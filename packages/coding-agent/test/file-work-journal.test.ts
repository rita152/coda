import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodingAgentOptions, WorkGraphId, WorkItemId } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSystem } from "../src/host/file-system.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createFileWorkJournal } from "../src/runtime/file-work-journal.ts";

type WorkJournal = NonNullable<OpenCodingAgentOptions["journal"]>;
type WorkJournalRecord = Parameters<WorkJournal["append"]>[0];

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function record(timestamp: number): WorkJournalRecord {
	return {
		type: "cancellation_requested",
		graphId: "graph:file" as WorkGraphId,
		itemId: "item:file" as WorkItemId,
		timestamp,
	};
}

describe("file Work Journal Adapter", () => {
	it("durably appends versioned records and restores them in order", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-work-journal-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "nested", "work.jsonl");
		const fileSystem = createNodeFileSystem();
		const first = createFileWorkJournal(fileSystem, path);
		await first.append(record(1));
		await first.append(record(2));
		await first.close();
		const lines = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map(({ version, sequence }) => [version, sequence])).toEqual([
			[1, 1],
			[1, 2],
		]);

		const restored = createFileWorkJournal(fileSystem, path);
		await expect(restored.load()).resolves.toEqual({ records: [record(1), record(2)], diagnostics: [] });
		await restored.append(record(3));
		await restored.close();
		expect(
			(await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).sequence),
		).toEqual([1, 2, 3]);
	});

	it("round-trips input resource settlements required for crash recovery", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-work-journal-resources-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "work.jsonl");
		const settlement: WorkJournalRecord = {
			type: "input_resources_settled",
			graphId: "graph:resources" as WorkGraphId,
			itemId: "item:resources" as WorkItemId,
			deliveryId: "batch:resources:1",
			outcome: "committed",
			timestamp: 10,
		};
		const fileSystem = createNodeFileSystem();
		const first = createFileWorkJournal(fileSystem, path);
		await first.append(settlement);
		await first.close();

		const restored = createFileWorkJournal(fileSystem, path);
		await expect(restored.load()).resolves.toEqual({ records: [settlement], diagnostics: [] });
		await restored.close();
	});

	it("serializes concurrent fatal-barrier appends", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-work-journal-concurrent-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "work.jsonl");
		const journal = createFileWorkJournal(createNodeFileSystem(), path);
		await Promise.all(Array.from({ length: 32 }, (_, index) => journal.append(record(index + 1))));
		await journal.close();
		const envelopes = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(envelopes.map(({ sequence }) => sequence)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
		expect(envelopes.map(({ record: value }) => value.timestamp)).toEqual(
			Array.from({ length: 32 }, (_, index) => index + 1),
		);
	});

	it("poisons the fatal barrier after a write failure instead of creating a sequence gap", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-work-journal-failure-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "work.jsonl");
		const nodeFileSystem = createNodeFileSystem();
		let writes = 0;
		const failingFileSystem: FileSystem = {
			...nodeFileSystem,
			open: async (...arguments_) => {
				const handle = await nodeFileSystem.open(...arguments_);
				return {
					...handle,
					write: async (data) => {
						writes += 1;
						if (writes === 2) throw new Error("injected journal write failure");
						await handle.write(data);
					},
				};
			},
		};
		const journal = createFileWorkJournal(failingFileSystem, path);
		await journal.append(record(1));
		await expect(journal.append(record(2))).rejects.toThrow("injected journal write failure");
		await expect(journal.append(record(3))).rejects.toThrow("injected journal write failure");
		await expect(journal.flush()).rejects.toThrow("injected journal write failure");
		await expect(journal.close()).rejects.toThrow("injected journal write failure");

		const restored = createFileWorkJournal(nodeFileSystem, path);
		await expect(restored.load()).resolves.toEqual({ records: [record(1)], diagnostics: [] });
		await restored.append(record(4));
		await restored.close();
		expect(
			(await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).sequence),
		).toEqual([1, 2]);
	});

	it("repairs only an incomplete crash tail and rejects earlier corruption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-work-journal-recovery-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "work.jsonl");
		const fileSystem = createNodeFileSystem();
		const first = createFileWorkJournal(fileSystem, path);
		await first.append(record(1));
		await first.close();
		const complete = await readFile(path, "utf8");
		await writeFile(path, `${complete}{"version":1,"sequence":2`);
		const repaired = createFileWorkJournal(fileSystem, path);
		await expect(repaired.load()).resolves.toEqual({
			records: [record(1)],
			diagnostics: ["Ignored incomplete Work Journal tail at sequence 2"],
		});
		await repaired.close();
		expect(await readFile(path, "utf8")).toBe(complete);

		await writeFile(path, '{"version":1,"sequence":9,"record":{"type":"cancellation_requested"}}\n');
		const corrupt = createFileWorkJournal(fileSystem, path);
		await expect(corrupt.load()).rejects.toThrow("Invalid Work Journal record envelope at sequence 1");
	});
});
