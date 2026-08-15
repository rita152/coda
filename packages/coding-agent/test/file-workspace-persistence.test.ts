import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkGraphId, WorkItemId } from "@coda/runtime";
import { MemoryWorkspacePersistence, type WorkspacePersistence } from "@coda/runtime/workspace-persistence";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSystem } from "../src/host/file-system.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createFileWorkspacePersistence } from "../src/runtime/file-workspace-persistence.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function graphId(value: string): WorkGraphId {
	return value as WorkGraphId;
}

function fact(graph: string, timestamp: number): unknown {
	return {
		version: 1,
		type: "cancellation_requested",
		graphId: graphId(graph),
		timestamp,
		batchId: `batch:${timestamp}`,
		target: { type: "graph" },
	};
}

async function fileFixture(prefix: string): Promise<{ persistence: WorkspacePersistence; root: string }> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(root);
	return { persistence: createFileWorkspacePersistence(createNodeFileSystem(), root), root };
}

function workspacePersistenceContract(
	name: string,
	fixture: () => Promise<{ persistence: WorkspacePersistence }>,
): void {
	describe(`${name} Workspace persistence contract`, () => {
		it("owns one explicit lease epoch", async () => {
			const { persistence } = await fixture();
			const first = await persistence.acquire();
			expect(first.epoch).not.toBe("");
			await expect(persistence.acquire()).rejects.toThrow(/lease is already held/u);
			await first.close();
			const second = await persistence.acquire();
			expect(second.epoch).not.toBe(first.epoch);
			await second.close();
		});

		it("keeps Graph facts independent and archives them outside the active index", async () => {
			const { persistence } = await fixture();
			const first = await persistence.acquire();
			const graphA = graphId("graph:contract-a");
			const graphB = graphId("graph:contract-b");
			const storeA = await first.openGraph(graphA);
			const storeB = await first.openGraph(graphB);
			await Promise.all([storeA.append([fact(graphA, 1)]), storeB.append([fact(graphB, 2)])]);
			await first.ledger.accept({
				activeGraphs: [
					{ graphId: graphA, order: 4 },
					{ graphId: graphB, order: 9 },
				],
				nextGraphOrder: 10,
				nextPublicationOrder: 23,
				sessionOwners: [
					{
						sessionId: "session:contract-b",
						graphId: graphB,
						itemId: "item:contract" as WorkItemId,
					},
				],
			});
			await first.ledger.recordTargetIdentity({
				targetPlacementId: "placement:target",
				targetIdentity: "target:fingerprint",
			});
			await expect(storeA.load()).resolves.toMatchObject({ restore: [fact(graphA, 1)] });
			await expect(storeB.load()).resolves.toMatchObject({ restore: [fact(graphB, 2)] });

			await first.ledger.archiveGraph(graphA);
			await first.archiveGraph(graphA);
			await expect(first.openGraph(graphA)).rejects.toThrow(/archived/u);
			const historical = await first.openHistoricalGraph(graphA);
			await expect(historical?.load()).resolves.toMatchObject({ restore: [fact(graphA, 1)] });
			await historical?.close();
			await first.close();

			const reopened = await persistence.acquire();
			await expect(reopened.ledger.load()).resolves.toMatchObject({
				activeGraphs: [{ graphId: graphB, order: 9 }],
				nextGraphOrder: 10,
				nextPublicationOrder: 23,
				sessionOwners: [
					{
						sessionId: "session:contract-b",
						graphId: graphB,
						itemId: "item:contract",
					},
				],
				targetIdentities: [{ targetPlacementId: "placement:target", targetIdentity: "target:fingerprint" }],
			});
			await expect((await reopened.openGraph(graphB)).load()).resolves.toMatchObject({
				restore: [fact(graphB, 2)],
			});
			await reopened.ledger.releaseSession({
				sessionId: "session:contract-b",
				graphId: graphB,
				itemId: "item:contract" as WorkItemId,
			});
			expect((await reopened.ledger.load()).sessionOwners).toEqual([]);
			await reopened.close();
		});

		it("rejects Facts addressed to a different Graph at the store boundary", async () => {
			const { persistence } = await fixture();
			const lease = await persistence.acquire();
			const graphA = graphId("graph:contract-address-a");
			const graphB = graphId("graph:contract-address-b");
			const store = await lease.openGraph(graphA);
			await expect(store.append([fact(graphB, 1)])).rejects.toThrow("cannot append Facts for another Graph");
			await expect(store.load()).resolves.toMatchObject({ restore: [] });
			await lease.close();
		});

		it("quarantines an unindexed initial segment before reusing its Graph identity", async () => {
			const { persistence } = await fixture();
			const graph = graphId("graph:orphan-reuse");
			const crashedEpoch = await persistence.acquire();
			await (await crashedEpoch.openGraph(graph)).append([fact(graph, 1)]);
			await crashedEpoch.close();

			const nextEpoch = await persistence.acquire();
			expect((await nextEpoch.ledger.load()).activeGraphs).toEqual([]);
			const replacement = await nextEpoch.openGraph(graph);
			await expect(replacement.load()).resolves.toMatchObject({ restore: [] });
			await replacement.append([fact(graph, 2)]);
			await nextEpoch.ledger.accept({
				activeGraphs: [{ graphId: graph, order: 0 }],
				nextGraphOrder: 1,
				nextPublicationOrder: 1,
				sessionOwners: [],
			});
			const orphan = await nextEpoch.openHistoricalGraph(graph);
			await expect(orphan?.load()).resolves.toMatchObject({ restore: [fact(graph, 1)] });
			await expect(replacement.load()).resolves.toMatchObject({ restore: [fact(graph, 2)] });
			await orphan?.close();
			await nextEpoch.close();
		});
	});
}

workspacePersistenceContract("memory", async () => ({ persistence: new MemoryWorkspacePersistence() }));
workspacePersistenceContract("Node filesystem", () => fileFixture("coda-workspace-persistence-contract-"));

describe("Node filesystem Workspace persistence", () => {
	it("rejects a second process lease before it can open Work Graph storage", async () => {
		const { root } = await fileFixture("coda-workspace-persistence-lock-");
		const firstProcess = createFileWorkspacePersistence(createNodeFileSystem(), root);
		const secondProcess = createFileWorkspacePersistence(createNodeFileSystem(), root);
		const firstLease = await firstProcess.acquire();
		await expect(secondProcess.acquire()).rejects.toThrow("Workspace process lease is already held");
		expect(await readFile(join(root, "workspace.lease"), "utf8")).toContain(firstLease.epoch);
		await firstLease.close();
		const secondLease = await secondProcess.acquire();
		await secondLease.close();
	});

	it("archives a dead process lease before opening the next epoch", async () => {
		const { root } = await fileFixture("coda-workspace-persistence-stale-lock-");
		const staleEpoch = "00000000-0000-4000-8000-000000000000";
		await writeFile(
			join(root, "workspace.lease"),
			`${JSON.stringify({
				version: 1,
				epoch: staleEpoch,
				pid: 2_147_483_647,
				acquiredAt: "2000-01-01T00:00:00.000Z",
			})}\n`,
		);
		const persistence = createFileWorkspacePersistence(createNodeFileSystem(), root);
		const lease = await persistence.acquire();
		expect(lease.epoch).not.toBe(staleEpoch);
		expect((await readdir(root)).some((name) => name.startsWith(`workspace.lease.stale-${staleEpoch}-`))).toBe(true);
		await lease.close();
	});

	it("does not share append or flush tails between Graph files", async () => {
		const { root } = await fileFixture("coda-workspace-persistence-independent-");
		const nodeFileSystem = createNodeFileSystem();
		const slowGraph = graphId("graph:slow-file");
		const slowFile = `${Buffer.from(String(slowGraph), "utf8").toString("base64url")}.jsonl`;
		let releaseSlow!: () => void;
		const slowReleased = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let markSlowStarted!: () => void;
		const slowStarted = new Promise<void>((resolve) => {
			markSlowStarted = resolve;
		});
		const gatedFileSystem: FileSystem = {
			...nodeFileSystem,
			open: async (...arguments_) => {
				const handle = await nodeFileSystem.open(...arguments_);
				if (!arguments_[0].endsWith(slowFile)) return handle;
				return {
					...handle,
					write: async (data) => {
						markSlowStarted();
						await slowReleased;
						await handle.write(data);
					},
				};
			},
		};
		const persistence = createFileWorkspacePersistence(gatedFileSystem, root);
		const lease = await persistence.acquire();
		const independentGraph = graphId("graph:independent-file");
		const slowStore = await lease.openGraph(slowGraph);
		const independentStore = await lease.openGraph(independentGraph);
		const pendingSlowAppend = slowStore.append([fact(slowGraph, 1)]);
		await slowStarted;
		await independentStore.append([fact(independentGraph, 2)]);
		await independentStore.flush();
		await expect(independentStore.load()).resolves.toMatchObject({ restore: [fact(independentGraph, 2)] });
		releaseSlow();
		await pendingSlowAppend;
		await lease.close();
	});

	it("poisons only a failed Graph store while the ledger and sibling Graph remain writable", async () => {
		const { root } = await fileFixture("coda-workspace-persistence-graph-failure-");
		const nodeFileSystem = createNodeFileSystem();
		const failedGraph = graphId("graph:failed-file");
		const failedFile = `${Buffer.from(String(failedGraph), "utf8").toString("base64url")}.jsonl`;
		const failingFileSystem: FileSystem = {
			...nodeFileSystem,
			open: async (...arguments_) => {
				const handle = await nodeFileSystem.open(...arguments_);
				if (!arguments_[0].endsWith(failedFile)) return handle;
				return {
					...handle,
					write: async () => {
						throw new Error("injected Graph write failure");
					},
				};
			},
		};
		const persistence = createFileWorkspacePersistence(failingFileSystem, root);
		const lease = await persistence.acquire();
		const failedStore = await lease.openGraph(failedGraph);
		const siblingGraph = graphId("graph:healthy-file");
		const siblingStore = await lease.openGraph(siblingGraph);
		await expect(failedStore.append([fact(failedGraph, 1)])).rejects.toThrow("injected Graph write failure");
		await expect(failedStore.append([fact(failedGraph, 2)])).rejects.toThrow("injected Graph write failure");
		await siblingStore.append([fact(siblingGraph, 3)]);
		await lease.ledger.accept({
			activeGraphs: [{ graphId: siblingGraph, order: 0 }],
			nextGraphOrder: 1,
			nextPublicationOrder: 1,
			sessionOwners: [],
		});
		await expect(siblingStore.load()).resolves.toMatchObject({ restore: [fact(siblingGraph, 3)] });
		await expect(lease.close()).rejects.toThrow("injected Graph write failure");
	});

	it("poisons the Workspace Ledger after an atomic replacement failure", async () => {
		const { root } = await fileFixture("coda-workspace-persistence-ledger-failure-");
		const nodeFileSystem = createNodeFileSystem();
		const failingFileSystem: FileSystem = {
			...nodeFileSystem,
			rename: async (from, to) => {
				if (to === join(root, "ledger.json")) throw new Error("injected ledger replacement failure");
				await nodeFileSystem.rename(from, to);
			},
		};
		const persistence = createFileWorkspacePersistence(failingFileSystem, root);
		const lease = await persistence.acquire();
		await expect(
			lease.ledger.accept({
				activeGraphs: [{ graphId: graphId("graph:ledger-file"), order: 0 }],
				nextGraphOrder: 1,
				nextPublicationOrder: 1,
				sessionOwners: [],
			}),
		).rejects.toThrow("injected ledger replacement failure");
		await expect(lease.ledger.flush()).rejects.toThrow("injected ledger replacement failure");
		await expect(
			lease.ledger.recordTargetIdentity({ targetPlacementId: "target", targetIdentity: "identity" }),
		).rejects.toThrow("injected ledger replacement failure");
		await expect(lease.close()).rejects.toThrow("injected ledger replacement failure");
	});

	it("repairs only an incomplete final Graph envelope", async () => {
		const { persistence, root } = await fileFixture("coda-workspace-persistence-repair-");
		const graph = graphId("graph:repair-file");
		const first = await persistence.acquire();
		await (await first.openGraph(graph)).append([fact(graph, 1)]);
		await first.ledger.accept({
			activeGraphs: [{ graphId: graph, order: 0 }],
			nextGraphOrder: 1,
			nextPublicationOrder: 1,
			sessionOwners: [],
		});
		await first.close();
		const path = join(root, "graphs", "active", `${Buffer.from(String(graph), "utf8").toString("base64url")}.jsonl`);
		const complete = await readFile(path, "utf8");
		await appendFile(path, '{"version":1,"sequence":2');

		const repairedLease = await persistence.acquire();
		await expect((await repairedLease.openGraph(graph)).load()).resolves.toEqual({
			restore: [fact(graph, 1)],
			diagnostics: ["Ignored incomplete Work Graph tail at sequence 2"],
		});
		await repairedLease.close();
		expect(await readFile(path, "utf8")).toBe(complete);
	});
});
