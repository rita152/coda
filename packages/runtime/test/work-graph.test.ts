import type { AgentEvent, AgentSeed, AgentTool, IdGenerator, IdKind } from "@coda/agent";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonValue,
	type Model,
	type Models,
	type ModelsSimpleStreamOptions,
	Type,
} from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CodingAgent,
	type CodingAgentObservation,
	createRunCapabilityHost,
	type OpenCodingAgentOptions,
	openCodingAgent,
	type RunCapabilitySource,
	type WorkGraphId,
	type WorkGraphResult,
	type WorkItemId,
	type WorkResult,
} from "../src/index.ts";
import { MemoryWorkspacePersistence } from "../src/work-graph/memory-workspace-persistence.ts";
import type {
	WorkGraphRecord,
	WorkGraphStore,
	WorkspacePersistence,
	WorkspacePersistenceLease,
} from "../src/work-graph/ports.ts";

class TestIds implements IdGenerator {
	#next = 0;

	generate(kind: IdKind): string {
		return `test:${kind}:${++this.#next}`;
	}
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

class MemorySessions {
	readonly opened: string[] = [];
	readonly closed: string[] = [];
	readonly rolledBack: string[] = [];
	readonly acceptedEventTypes: AgentEvent["type"][] = [];
	sharedSessionId?: string;
	failItemId?: string;
	failAcceptEventType?: AgentEvent["type"];
	failRecord = false;
	failEvidence = false;
	failClose = false;
	#acceptFailed = false;

	readonly adapter: OpenCodingAgentOptions["sessions"];

	constructor() {
		this.adapter = {
			reserve: async (request) => {
				if (request.itemId === this.failItemId) throw new Error("scripted Session failure");
				const id =
					this.sharedSessionId ??
					(request.target.type === "resume"
						? request.target.sessionId
						: (request.target.sessionId ?? `session:${request.itemId}`));
				this.opened.push(id);
				const events: AgentEvent[] = [];
				let closed = false;
				const session = {
					id,
					seed: Object.freeze({ version: 1, messages: [], pendingFollowUps: [] }) satisfies AgentSeed,
					accept: (event: AgentEvent) => {
						if (!this.#acceptFailed && event.type === this.failAcceptEventType) {
							this.#acceptFailed = true;
							throw new Error("scripted fatal Session barrier");
						}
						this.acceptedEventTypes.push(event.type);
						events.push(event);
					},
					record: (_change: unknown) =>
						this.failRecord ? Promise.reject(new Error("scripted Session record failure")) : Promise.resolve(),
					close: async () => {
						if (closed) return;
						if (this.failClose) throw new Error("scripted Session close failure");
						closed = true;
						this.closed.push(id);
					},
				};
				return {
					session,
					commit: () => Promise.resolve(),
					rollback: async () => {
						this.rolledBack.push(id);
						await session.close();
					},
					evidence: (runId: string) => {
						if (this.failEvidence) throw new Error("scripted Session evidence failure");
						return { version: 1, facts: { runId, eventCount: events.length } };
					},
				};
			},
		};
	}
}

class MemoryWorkspaceExecution {
	readonly reserved: string[] = [];
	readonly recovered: Array<Parameters<OpenCodingAgentOptions["workspaceExecution"]["recover"]>[0]> = [];
	readonly released: string[] = [];
	readonly rolledBack: string[] = [];
	readonly published: string[] = [];
	failItemId?: string;
	captureArtifacts = false;
	contributions: Awaited<ReturnType<OpenCodingAgentOptions["workspaceExecution"]["tools"]>> = [];
	toolsOperation?: () => Promise<Awaited<ReturnType<OpenCodingAgentOptions["workspaceExecution"]["tools"]>>>;
	readonly boundEffects: string[][] = [];
	readonly boundToolNames: string[][] = [];
	readonly #publicationOrders = new Map<string, number>();
	readonly #publicationTargetByPlacement = new Map<string, string>();
	readonly #publicationTargets = new Map<
		string,
		{
			readonly turns: Map<number, { readonly ready: Promise<void>; readonly resolve: () => void; settled: boolean }>;
			active?: number;
		}
	>();
	publishOperation?: OpenCodingAgentOptions["workspaceExecution"]["publish"];

	readonly adapter: OpenCodingAgentOptions["workspaceExecution"];

	constructor() {
		this.adapter = {
			reserve: async (request) => {
				if (request.itemId === this.failItemId) throw new Error("scripted Placement failure");
				const target = request.parent?.placementId ?? "source";
				const placement = {
					placementId: `placement:${request.graphId}:${request.itemId}`,
					root: `/workspace/${request.graphId}/${request.itemId}`,
					baseIdentity: `base:${request.parent?.baseIdentity ?? "root"}`,
					targetPlacementId: target,
					targetIdentity: `target:${target}:accepted`,
					kind: "memory" as const,
				};
				this.reserved.push(placement.placementId);
				return {
					placement,
					commit: async () => {
						this.#publicationOrders.set(placement.placementId, request.publicationOrder);
						this.#publicationTargetByPlacement.set(placement.placementId, target);
						this.#registerPublication(target, request.publicationOrder);
					},
					rollback: async () => {
						this.#settlePublication(request.parent?.placementId ?? "source", request.publicationOrder);
						this.rolledBack.push(placement.placementId);
					},
				};
			},
			recover: async (request) => {
				this.recovered.push(request);
				return {
					placement: request.placement,
					commit: () => Promise.resolve(),
					rollback: () => Promise.resolve(),
				};
			},
			tools: () => this.toolsOperation?.() ?? this.contributions,
			bindTools: ({ contributions }) => {
				this.boundEffects.push(contributions.map(({ effect }) => effect));
				this.boundToolNames.push(contributions.map(({ tool }) => tool.name));
				return contributions.map(({ tool }) => tool);
			},
			quiesce: () => Promise.resolve(),
			capture: ({ itemId, placement }) =>
				Promise.resolve(
					this.captureArtifacts
						? {
								artifactId: `artifact:${itemId}`,
								placementId: placement.placementId,
								baseIdentity: placement.baseIdentity,
								kind: "memory" as const,
							}
						: undefined,
				),
			publish: async (request) => {
				const order = this.#publicationOrders.get(request.placement.placementId);
				const target = this.#publicationTargetByPlacement.get(request.placement.placementId);
				if (order === undefined || !target) throw new Error("Memory publication order is unavailable");
				await this.#publicationTargets.get(target)?.turns.get(order)?.ready;
				try {
					if (this.publishOperation) return this.publishOperation(request);
					const { itemId } = request;
					this.published.push(String(itemId));
					return {
						state: "published" as const,
						publicationId: `publication:${itemId}`,
						targetPlacementId: target,
						targetIdentity: `target:${target}:published:${itemId}`,
					};
				} finally {
					this.#settlePublication(target, order);
				}
			},
			release: async ({ placement }) => {
				const order = this.#publicationOrders.get(placement.placementId);
				const target = this.#publicationTargetByPlacement.get(placement.placementId);
				if (order !== undefined && target) this.#settlePublication(target, order);
				this.released.push(placement.placementId);
			},
			close: () => Promise.resolve(),
		};
	}

	#registerPublication(targetId: string, order: number): void {
		let target = this.#publicationTargets.get(targetId);
		if (!target) {
			target = { turns: new Map() };
			this.#publicationTargets.set(targetId, target);
		}
		let resolve!: () => void;
		const ready = new Promise<void>((settle) => {
			resolve = settle;
		});
		target.turns.set(order, { ready, resolve, settled: false });
		this.#advancePublication(targetId);
	}

	#settlePublication(targetId: string, order: number): void {
		const target = this.#publicationTargets.get(targetId);
		const state = target?.turns.get(order);
		if (!state || state.settled) return;
		state.settled = true;
		if (target?.active === order) target.active = undefined;
		this.#advancePublication(targetId);
	}

	#advancePublication(targetId: string): void {
		const target = this.#publicationTargets.get(targetId);
		if (!target || target.active !== undefined) return;
		for (;;) {
			const next = [...target.turns.entries()].sort(([left], [right]) => left - right)[0];
			if (!next) return;
			const [order, state] = next;
			if (state.settled) {
				target.turns.delete(order);
				continue;
			}
			target.active = order;
			state.resolve();
			return;
		}
	}
}

function interceptGraphStores(
	lease: WorkspacePersistenceLease,
	beforeAppend: (record: WorkGraphRecord) => Promise<void> | void,
): WorkspacePersistenceLease {
	const stores = new Map<WorkGraphId, WorkGraphStore>();
	return Object.freeze({
		...lease,
		openGraph: async (graphId: WorkGraphId) => {
			const current = stores.get(graphId);
			if (current) return current;
			const underlying = await lease.openGraph(graphId);
			const store: WorkGraphStore = Object.freeze({
				load: () => underlying.load(),
				append: async (record: WorkGraphRecord) => {
					await beforeAppend(record);
					await underlying.append(record);
				},
				flush: () => underlying.flush(),
				close: () => underlying.close(),
			});
			stores.set(graphId, store);
			return store;
		},
	});
}

class FailOnceGraphPersistence implements WorkspacePersistence {
	readonly memory = new MemoryWorkspacePersistence();
	readonly attempts: WorkGraphRecord[] = [];
	readonly #fail: (record: WorkGraphRecord) => boolean;
	#failed = false;

	constructor(fail: (record: WorkGraphRecord) => boolean) {
		this.#fail = fail;
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		return interceptGraphStores(await this.memory.acquire(), (record) => {
			this.attempts.push(structuredClone(record));
			if (!this.#failed && this.#fail(record)) {
				this.#failed = true;
				throw new Error("scripted fatal graph barrier");
			}
		});
	}
}

class GatedGraphPersistence implements WorkspacePersistence {
	readonly memory = new MemoryWorkspacePersistence();
	readonly started = deferred();
	readonly release = deferred();
	readonly #gate: (record: WorkGraphRecord) => boolean;

	constructor(gate: (record: WorkGraphRecord) => boolean) {
		this.#gate = gate;
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		return interceptGraphStores(await this.memory.acquire(), async (record) => {
			if (this.#gate(record)) {
				this.started.resolve();
				await this.release.promise;
			}
		});
	}
}

class PoisonedLedgerPersistence implements WorkspacePersistence {
	readonly memory = new MemoryWorkspacePersistence();
	readonly attempts: string[] = [];
	readonly #fail: (operation: string, graphId?: WorkGraphId) => boolean;
	#failure?: Error;

	constructor(fail: (operation: string, graphId?: WorkGraphId) => boolean) {
		this.#fail = fail;
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		const lease = await this.memory.acquire();
		const ledger = lease.ledger;
		const attempt = (operation: string, graphId?: WorkGraphId): void => {
			this.attempts.push(graphId ? `${operation}:${graphId}` : operation);
			if (!this.#failure && this.#fail(operation, graphId)) {
				this.#failure = new Error("scripted Workspace Ledger failure");
			}
			if (this.#failure) throw this.#failure;
		};
		return Object.freeze({
			...lease,
			ledger: Object.freeze({
				load: () => ledger.load(),
				accept: async (acceptance: Parameters<typeof ledger.accept>[0]) => {
					attempt("accept");
					await ledger.accept(acceptance);
				},
				releaseSession: async (owner: Parameters<typeof ledger.releaseSession>[0]) => {
					attempt("releaseSession", owner.graphId);
					await ledger.releaseSession(owner);
				},
				recordTargetIdentity: async (identity: Parameters<typeof ledger.recordTargetIdentity>[0]) => {
					attempt("recordTargetIdentity");
					await ledger.recordTargetIdentity(identity);
				},
				archiveGraph: async (graphId: WorkGraphId) => {
					attempt("archiveGraph", graphId);
					await ledger.archiveGraph(graphId);
				},
				flush: () => ledger.flush(),
				close: () => ledger.close(),
			}),
		});
	}
}

function emptyCapabilitySource(): RunCapabilitySource {
	return Object.freeze({
		id: "test",
		acquire: () =>
			Object.freeze({
				revision: "0",
				tools: Object.freeze([]),
				promptFragments: Object.freeze([]),
				dispose: () => undefined,
			}),
	});
}

interface ResponsePlan {
	readonly gate?: Promise<void>;
	readonly outcome?: "success" | "error";
	readonly message?: ReturnType<typeof fauxAssistantMessage>;
}

async function harness(
	responses: readonly ResponsePlan[],
	overrides: Partial<Pick<OpenCodingAgentOptions, "persistence" | "resources">> & {
		readonly sessions?: MemorySessions;
		readonly workspace?: MemoryWorkspaceExecution;
		readonly processMaximumConcurrency?: number;
		readonly capabilitySource?: RunCapabilitySource;
		readonly controlWorker?: OpenCodingAgentOptions["controlWorker"];
		readonly chunkCharacters?: number;
		readonly modelStreamFailure?: Error;
	} = {},
) {
	let now = 1_000;
	const clock = { now: () => now++ };
	const runtime = { clock, random: { next: () => 0 }, sleep: { wait: async () => {} } };
	const faux = createFauxCore({
		runtime,
		provider: "work",
		...(overrides.chunkCharacters === undefined ? {} : { chunkCharacters: overrides.chunkCharacters }),
		models: [
			{ id: "one", input: ["text"], contextWindow: 64_000 },
			{ id: "two", input: ["text"], contextWindow: 64_000 },
		],
	});
	const modelCalls: string[] = [];
	const toolCatalogs: string[][] = [];
	const modelContexts: string[] = [];
	for (const [index, response] of responses.entries()) {
		faux.appendResponses([
			async () => {
				await response.gate;
				if (response.message) return response.message;
				return response.outcome === "error"
					? fauxAssistantMessage([], {
							stopReason: "error",
							errorMessage: `scripted failure ${index}`,
							timestamp: clock.now(),
						})
					: fauxAssistantMessage(`response:${index}`, { timestamp: clock.now() });
			},
		]);
	}
	const stream = (
		model: Model,
		context: Parameters<Models["streamSimple"]>[1],
		options: ModelsSimpleStreamOptions,
	) => {
		modelCalls.push(model.id);
		toolCatalogs.push(context.tools?.map(({ name }) => name) ?? []);
		modelContexts.push(JSON.stringify(context));
		if (overrides.modelStreamFailure) throw overrides.modelStreamFailure;
		return faux.streamSimple(model, context, { ...options, runtime });
	};
	const sessions = overrides.sessions ?? new MemorySessions();
	const workspace = overrides.workspace ?? new MemoryWorkspaceExecution();
	const runCapabilities = createRunCapabilityHost({
		model: {
			acquire: (selection) => ({
				model: selection.model,
				revision: `test:${selection.model.id}`,
				stream: (context, options) => stream(selection.model, context, options ?? {}),
				complete: (context, options) => stream(selection.model, context, options ?? {}).result(),
				dispose: () => undefined,
			}),
		},
		contributors: [overrides.capabilitySource ?? emptyCapabilitySource()],
		now: clock.now,
		platform: "linux",
		interactionMode: "evaluation",
	});
	const agent = await openCodingAgent({
		workspaceExecution: workspace.adapter,
		sessions: sessions.adapter,
		...(overrides.resources ? { resources: overrides.resources } : {}),
		...(overrides.persistence ? { persistence: overrides.persistence } : {}),
		runCapabilities,
		resolveConfiguration: (configuration) => ({
			model: faux.getModel(configuration.model.id)!,
			reasoning: configuration.reasoning,
			authSnapshot: { auth: {} },
		}),
		clock,
		idGenerator: new TestIds(),
		processMaximumConcurrency: overrides.processMaximumConcurrency ?? 8,
		platform: "linux",
		interactionMode: "evaluation",
		...(overrides.controlWorker ? { controlWorker: overrides.controlWorker } : {}),
	});
	return { agent, modelCalls, toolCatalogs, modelContexts, sessions, workspace };
}

function noOpTool(name: string): AgentTool {
	return {
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		replaySafety: "safe",
		execute: async () => ({ content: name }),
	};
}

function delegationMessage(
	id: string,
	items: readonly {
		readonly itemId: string;
		readonly objective: string;
		readonly executionMode: "read_only" | "write";
		readonly dependencies?: readonly string[];
	}[],
) {
	return fauxAssistantMessage([fauxToolCall("delegate", { items }, { id })], {
		stopReason: "toolUse",
		timestamp: 1_000,
	});
}

function start(graphId = "graph:one", maximumConcurrency = 4, model = "one") {
	return {
		type: "start_work_graph" as const,
		graphId,
		objective: "root objective",
		root: { itemId: "root", executionMode: "write" as const },
		maximumConcurrency,
		configuration: { model: { provider: "work", id: model }, reasoning: "off" as const },
		session: { type: "create" as const, sessionId: `session:${graphId}` },
	};
}

async function waitForGraphResult(agent: CodingAgent, graphId: string): Promise<WorkGraphResult> {
	for (;;) {
		let resynchronize = false;
		for await (const observation of agent.observe({ capacity: 1_024 })) {
			if (observation.type === "snapshot") {
				const result = observation.snapshot.graphs.find((graph) => graph.graphId === graphId)?.result;
				if (result) return result;
			}
			if (observation.type === "work_graph_settled" && observation.result.graphId === graphId) {
				return observation.result;
			}
			if (observation.type === "resync_required") {
				resynchronize = true;
				break;
			}
			if (observation.type === "closed") throw new Error(`Observation stream closed before ${graphId} settled`);
		}
		if (!resynchronize) throw new Error(`Observation stream closed before ${graphId} settled`);
	}
}

async function waitForPersistedGraphResult(
	persistence: MemoryWorkspacePersistence,
	graphId: string,
): Promise<WorkGraphResult> {
	await vi.waitFor(() => {
		expect(persistence.records.some((record) => record.type === "graph_result" && record.graphId === graphId)).toBe(
			true,
		);
	});
	const record = [...persistence.records]
		.reverse()
		.find((candidate) => candidate.type === "graph_result" && candidate.graphId === graphId);
	if (record?.type !== "graph_result") throw new Error(`Persisted Work Graph result not found: ${graphId}`);
	return record.payload as unknown as WorkGraphResult;
}

async function observeGraphEvents(
	agent: CodingAgent,
	graphId: string,
	accept: (event: Readonly<Record<string, unknown>>) => void,
): Promise<WorkGraphResult> {
	for (;;) {
		let resynchronize = false;
		for await (const observation of agent.observe({ capacity: 1_024 })) {
			if (observation.type === "snapshot") {
				const result = observation.snapshot.graphs.find((graph) => graph.graphId === graphId)?.result;
				if (result) return result;
			}
			if (observation.type === "work_item_event" && observation.graphId === graphId) {
				accept(observation.event as Readonly<Record<string, unknown>>);
			}
			if (observation.type === "work_graph_settled" && observation.result.graphId === graphId) {
				return observation.result;
			}
			if (observation.type === "resync_required") {
				resynchronize = true;
				break;
			}
			if (observation.type === "closed") throw new Error(`Observation stream closed before ${graphId} settled`);
		}
		if (!resynchronize) throw new Error(`Observation stream closed before ${graphId} settled`);
	}
}

async function waitForState(agent: CodingAgent, graphId: string, itemId: string, state: string): Promise<void> {
	for await (const observation of agent.observe({ capacity: 1_024 })) {
		if (observation.type === "snapshot") {
			const item = observation.snapshot.graphs
				.find((graph) => graph.graphId === graphId)
				?.items.find((candidate) => candidate.itemId === itemId);
			if (item?.state === state) return;
		}
		if (
			observation.type === "item_state_changed" &&
			observation.graphId === graphId &&
			observation.itemId === itemId &&
			observation.to === state
		) {
			return;
		}
	}
}

describe("Work Graph public Interface", () => {
	it("uses an accepted Prompt delivery as the root Worker input without exposing it as a Follow-up", async () => {
		const { agent, modelContexts } = await harness([{}]);
		await expect(
			agent.submit({
				commands: [
					start("graph:explicit-prompt", 1),
					{
						type: "deliver_work_item_input",
						graphId: "graph:explicit-prompt",
						itemId: "root",
						kind: "prompt",
						input: "structured caller prompt",
					},
				],
			}),
		).resolves.toMatchObject({ status: "accepted" });
		const result = await waitForGraphResult(agent, "graph:explicit-prompt");
		expect(result.results[0]).toMatchObject({ state: "succeeded", run: { outcome: "success" } });
		expect(modelContexts).toHaveLength(1);
		expect(modelContexts[0]).toContain("structured caller prompt");
		expect(modelContexts[0]).not.toContain("root objective");
		await agent.close();
	});

	it("atomically rejects duplicate Prompt ownership before a Work Graph becomes visible", async () => {
		const { agent, modelCalls } = await harness([]);
		const receipt = await agent.submit({
			commands: [
				start("graph:duplicate-prompt", 1),
				{
					type: "deliver_work_item_input",
					graphId: "graph:duplicate-prompt",
					itemId: "root",
					kind: "prompt",
					input: "first",
				},
				{
					type: "deliver_work_item_input",
					graphId: "graph:duplicate-prompt",
					itemId: "root",
					kind: "prompt",
					input: "second",
				},
			],
		});
		expect(receipt).toMatchObject({ status: "rejected", rejection: { code: "invalid_state", commandIndex: 2 } });
		const iterator = agent.observe()[Symbol.asyncIterator]();
		const snapshot = (await iterator.next()).value as Extract<CodingAgentObservation, { type: "snapshot" }>;
		expect(snapshot.snapshot.graphs).toEqual([]);
		expect(modelCalls).toEqual([]);
		await iterator.return?.();
		await agent.close();
	});

	it("routes built-in delegation through the deterministic bound Tool assembly", async () => {
		const journal = new MemoryWorkspacePersistence();
		const workspace = new MemoryWorkspaceExecution();
		const { agent, modelCalls, modelContexts } = await harness(
			[
				{
					message: delegationMessage("delegate:root", [
						{ itemId: "child", objective: "child objective", executionMode: "write" },
					]),
				},
				{
					message: delegationMessage("delegate:child", [
						{ itemId: "grandchild", objective: "grandchild objective", executionMode: "write" },
					]),
				},
				{},
				{},
				{},
			],
			{ persistence: journal, workspace, processMaximumConcurrency: 1 },
		);
		await agent.submit({ commands: [start("graph:nested-delegation", 1)] });
		const result = await waitForGraphResult(agent, "graph:nested-delegation");
		expect(result.results.map(({ itemId, parentItemId, state }) => [itemId, parentItemId, state])).toEqual([
			["root", undefined, "succeeded"],
			["child", "root", "succeeded"],
			["grandchild", "child", "succeeded"],
		]);
		expect(result.effectiveConcurrency).toBe(1);
		expect(modelCalls).toHaveLength(5);
		expect(journal.records.filter(({ type }) => type === "batch_accepted")).toHaveLength(3);
		expect(modelContexts.join("\n")).toContain('"itemId":"child"');
		expect(modelContexts.join("\n")).toContain('"itemId":"grandchild"');
		expect(workspace.boundToolNames).toEqual([["delegate"], ["delegate"], ["delegate"]]);
		await agent.close();
	});

	it("cascades cancellation while a parent is suspended in delegation wait", async () => {
		const child = deferred();
		const { agent } = await harness(
			[
				{
					message: delegationMessage("delegate:cancel", [
						{ itemId: "child", objective: "child waits", executionMode: "write" },
					]),
				},
				{ gate: child.promise },
			],
			{ processMaximumConcurrency: 1 },
		);
		await agent.submit({ commands: [start("graph:delegation-cancel", 1)] });
		await waitForState(agent, "graph:delegation-cancel", "child", "running");
		await agent.submit({
			commands: [
				{
					type: "cancel_work",
					target: { type: "item", graphId: "graph:delegation-cancel", itemId: "root" },
				},
			],
		});
		child.resolve();
		const result = await waitForGraphResult(agent, "graph:delegation-cancel");
		expect(result.results.map(({ state }) => state)).toEqual(["canceled", "canceled"]);
		await agent.close();
	});

	it("cancels observable preparation without starting a Model or leaking executable capabilities", async () => {
		const refreshGate = deferred();
		const journal = new MemoryWorkspacePersistence();
		const controlTypes: AgentEvent["type"][] = [];
		let capabilityDisposals = 0;
		const { agent, modelCalls, sessions } = await harness([], {
			persistence: journal,
			controlWorker: ({ event }) => {
				controlTypes.push(event.type);
			},
			capabilitySource: {
				id: "gated",
				acquire: async () => {
					await refreshGate.promise;
					return {
						revision: "gated",
						tools: [],
						promptFragments: [],
						dispose: () => {
							capabilityDisposals++;
						},
					};
				},
			},
		});
		const preparationStarted = deferred();
		const preparation = (async () => {
			let started = false;
			for await (const observation of agent.observe({ capacity: 64 })) {
				if (
					observation.type !== "work_item_event" ||
					typeof observation.event !== "object" ||
					observation.event === null ||
					Array.isArray(observation.event)
				) {
					continue;
				}
				if (observation.event.type === "preparation_started") {
					started = true;
					preparationStarted.resolve();
				}
				if (observation.event.type === "preparation_settled") {
					return { started, outcome: observation.event.outcome };
				}
			}
			throw new Error("Observation stream closed before preparation settled");
		})();
		await agent.submit({ commands: [start("graph:cancel-preparation", 1)] });
		await preparationStarted.promise;
		await agent.submit({
			commands: [
				{
					type: "cancel_work",
					target: { type: "item", graphId: "graph:cancel-preparation", itemId: "root" },
				},
			],
		});
		const result = await waitForGraphResult(agent, "graph:cancel-preparation");
		expect(result.results[0]).toMatchObject({ state: "canceled", run: { outcome: "aborted" } });
		expect(modelCalls).toEqual([]);
		await expect(preparation).resolves.toEqual({ started: true, outcome: "canceled" });
		expect(journal.records.filter((record) => record.type === "worker_fact")).toEqual([]);
		expect(sessions.acceptedEventTypes).toEqual([]);
		expect(controlTypes).toEqual([]);
		refreshGate.resolve();
		await vi.waitFor(() => expect(capabilityDisposals).toBe(1));
		await agent.close();
		expect(capabilityDisposals).toBe(1);
	});

	it("disposes acquired capabilities exactly once when Session preparation fails", async () => {
		const sessions = new MemorySessions();
		sessions.failRecord = true;
		let capabilityDisposals = 0;
		const { agent } = await harness([], {
			sessions,
			capabilitySource: {
				id: "counted",
				acquire: () => ({
					revision: "counted:1",
					tools: [],
					promptFragments: [],
					dispose: () => {
						capabilityDisposals++;
					},
				}),
			},
		});

		await agent.submit({ commands: [start("graph:prepare-record-failure", 1)] });
		const result = await waitForGraphResult(agent, "graph:prepare-record-failure");
		expect(result.results[0]?.state).toBe("failed");
		expect(capabilityDisposals).toBe(1);
		await agent.close();
		expect(capabilityDisposals).toBe(1);
	});

	it("cancels an active Tool Invocation through the Work Item AbortSignal", async () => {
		const toolStarted = deferred();
		let toolAborted = false;
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{
				tool: {
					name: "blocking_write",
					description: "Wait until canceled",
					parameters: Type.Object({}, { additionalProperties: false }),
					replaySafety: "never",
					execute: async (_arguments, context) => {
						toolStarted.resolve();
						await new Promise<void>((resolve) => {
							if (context.signal.aborted) resolve();
							else context.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						toolAborted = context.signal.aborted;
						context.signal.throwIfAborted();
						return { content: "unreachable" };
					},
				},
				effect: "write",
			},
		];
		const { agent } = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("blocking_write", {}, { id: "tool:cancel" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
			],
			{ workspace },
		);
		await agent.submit({ commands: [start("graph:cancel-tool", 1)] });
		await toolStarted.promise;
		await agent.submit({
			commands: [{ type: "cancel_work", target: { type: "graph", graphId: "graph:cancel-tool" } }],
		});
		const result = await waitForGraphResult(agent, "graph:cancel-tool");
		expect(toolAborted).toBe(true);
		expect(result.results[0]).toMatchObject({ state: "canceled", run: { outcome: "aborted" } });
		await agent.close();
	});

	it("marks cancellation during Publication interrupted and never reports the artifact as published", async () => {
		const publicationStarted = deferred();
		const workspace = new MemoryWorkspaceExecution();
		workspace.captureArtifacts = true;
		workspace.publishOperation = async ({ signal }) => {
			publicationStarted.resolve();
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			signal.throwIfAborted();
			return { state: "published", publicationId: "publication:unreachable" };
		};
		const { agent } = await harness([{}], { workspace });
		await agent.submit({ commands: [start("graph:cancel-publication", 1)] });
		await publicationStarted.promise;
		await agent.submit({
			commands: [{ type: "cancel_work", target: { type: "graph", graphId: "graph:cancel-publication" } }],
		});
		const result = await waitForGraphResult(agent, "graph:cancel-publication");
		expect(result.cancellationRequested).toBe(true);
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			publication: { state: "not_published", reason: "interrupted" },
			diagnostics: [{ code: "publication_interrupted" }],
		});
		await agent.close();
	});

	it("orders public Work Item events after fatal Run barriers", async () => {
		const observed: string[] = [];
		const { agent } = await harness([{}]);
		const settled = observeGraphEvents(agent, "graph:observer-order", (event) => {
			if (typeof event.type === "string") observed.push(event.type);
		});
		await agent.submit({ commands: [start("graph:observer-order", 1)] });
		const result = await settled;
		expect(result.results[0]?.state).toBe("succeeded");
		await vi.waitFor(() => expect(observed).toContain("prepared_run_disposed"));
		expect(observed.indexOf("preparation_started")).toBeLessThan(observed.indexOf("preparation_settled"));
		expect(observed.indexOf("preparation_settled")).toBeLessThan(observed.indexOf("run_start"));
		expect(observed.indexOf("run_end")).toBeLessThan(observed.indexOf("prepared_run_disposed"));
		expect(observed.filter((type) => type === "prepared_run_disposed")).toHaveLength(1);
		await agent.close();
	});

	it("keeps a failed public Observation consumer outside Work Graph barriers", async () => {
		const { agent } = await harness([{}]);
		const projection = (async () => {
			for await (const observation of agent.observe({ capacity: 1_024 })) {
				if (observation.type === "work_item_event") throw new Error("detached projection");
			}
		})();
		await agent.submit({ commands: [start("graph:observer-failure", 1)] });
		await expect(projection).rejects.toThrow("detached projection");
		const result = await waitForGraphResult(agent, "graph:observer-failure");
		expect(result.results[0]?.state).toBe("succeeded");
		await agent.close();
	});

	it("does not include a permanently stalled public Observation consumer in Run, Journal, or close barriers", async () => {
		const observerStarted = deferred();
		const neverSettles = new Promise<void>(() => {});
		const { agent } = await harness([{}]);
		void (async () => {
			for await (const observation of agent.observe({ capacity: 1_024 })) {
				if (observation.type !== "work_item_event") continue;
				observerStarted.resolve();
				await neverSettles;
			}
		})();
		await agent.submit({ commands: [start("graph:observer-stalled", 1)] });
		await observerStarted.promise;
		const result = await waitForGraphResult(agent, "graph:observer-stalled");
		expect(result.results[0]?.state).toBe("succeeded");
		await expect(agent.close()).resolves.toMatchObject({ canceledGraphIds: [], unknownWork: [] });
	});

	it("drops one unserializable Worker Observation without aborting Tool or Run settlement", async () => {
		const journal = new MemoryWorkspacePersistence();
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{
				tool: {
					...noOpTool("unserializable_observation"),
					execute: async (_arguments, context) => {
						context.reportProgress?.({ progress: 1, unsupported: 1n } as never);
						return {
							content: "completed",
							observation: { status: "ok" as const, truncated: false },
						};
					},
				},
				effect: "write",
			},
		];
		const { agent } = await harness(
			[
				{
					message: fauxAssistantMessage(
						fauxToolCall("unserializable_observation", {}, { id: "tool:unserializable" }),
						{ stopReason: "toolUse", timestamp: 1_000 },
					),
				},
				{},
			],
			{ persistence: journal, workspace },
		);
		const dropped = (async () => {
			for await (const observation of agent.observe({ capacity: 128 })) {
				if (observation.type === "diagnostic" && observation.diagnostic.code === "worker_observation_dropped") {
					return observation;
				}
			}
			throw new Error("Observation stream closed before the projection failure was diagnosed");
		})();
		await agent.submit({ commands: [start("graph:unserializable-observation", 1)] });
		const result = await waitForGraphResult(agent, "graph:unserializable-observation");
		expect(result.results[0]?.state).toBe("succeeded");
		await expect(dropped).resolves.toMatchObject({
			diagnostic: {
				code: "worker_observation_dropped",
				message: expect.stringContaining("projection failed"),
			},
		});
		expect(
			journal.records.some((record) => record.type === "worker_fact" && record.fact.type === "tool_settled"),
		).toBe(true);
		await agent.close();
	});

	it("bounds journal and slow-consumer memory during two large streams and 10,000 Tool progress updates per Session", async () => {
		const journal = new MemoryWorkspacePersistence();
		const large = "stream-token".repeat(834);
		const streamGate = deferred();
		const streamControls: AgentEvent["type"][] = [];
		const streamed = await harness(
			[
				{ gate: streamGate.promise, message: fauxAssistantMessage(`first:${large}`, { timestamp: 1_000 }) },
				{ gate: streamGate.promise, message: fauxAssistantMessage(`second:${large}`, { timestamp: 1_000 }) },
			],
			{
				persistence: journal,
				processMaximumConcurrency: 2,
				chunkCharacters: 1,
				controlWorker: ({ event }) => {
					streamControls.push(event.type);
				},
			},
		);
		const slow = streamed.agent.observe({ capacity: 1 })[Symbol.asyncIterator]();
		await expect(slow.next()).resolves.toMatchObject({ value: { type: "snapshot" } });
		await Promise.all([
			streamed.agent.submit({ commands: [start("graph:stream-one", 1)] }),
			streamed.agent.submit({ commands: [start("graph:stream-two", 1)] }),
		]);
		await vi.waitFor(() => expect(streamed.modelCalls).toHaveLength(2));
		streamGate.resolve();
		const [first, second] = await Promise.all([
			waitForGraphResult(streamed.agent, "graph:stream-one"),
			waitForGraphResult(streamed.agent, "graph:stream-two"),
		]);
		expect(first.results[0]?.state).toBe("succeeded");
		expect(second.results[0]?.state).toBe("succeeded");
		await expect(slow.next()).resolves.toMatchObject({
			value: { type: "resync_required", reason: "slow_consumer" },
		});
		const streamedFacts = journal.records.filter((record) => record.type === "worker_fact");
		expect(streamedFacts).toHaveLength(10);
		expect(JSON.stringify(streamedFacts)).not.toContain("stream-token");
		expect(Math.max(...streamedFacts.map((record) => JSON.stringify(record).length))).toBeLessThan(1_024);
		expect(streamed.sessions.acceptedEventTypes).not.toEqual(
			expect.arrayContaining(["message_start", "message_update", "tool_execution_progress"]),
		);
		expect(streamControls).not.toEqual(
			expect.arrayContaining(["message_start", "message_update", "tool_execution_progress"]),
		);
		await streamed.agent.close();

		const progressJournal = new MemoryWorkspacePersistence();
		const workspace = new MemoryWorkspaceExecution();
		let progressReports = 0;
		let progressToolsStarted = 0;
		const bothProgressToolsStarted = deferred();
		const progressControls: AgentEvent["type"][] = [];
		workspace.contributions = [
			{
				tool: {
					...noOpTool("progress_stress"),
					execute: async (_arguments, context) => {
						progressToolsStarted++;
						if (progressToolsStarted === 2) bothProgressToolsStarted.resolve();
						await bothProgressToolsStarted.promise;
						for (let index = 0; index < 10_000; index++) {
							context.reportProgress?.({ progress: index + 1, total: 10_000, message: `progress:${index}` });
							progressReports++;
							if (index % 100 === 0) await Promise.resolve();
						}
						return { content: "progress complete" };
					},
				},
				effect: "write",
			},
		];
		const progressed = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("progress_stress", {}, { id: "tool:progress-one" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
				{
					message: fauxAssistantMessage(fauxToolCall("progress_stress", {}, { id: "tool:progress-two" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
				{},
				{},
			],
			{
				persistence: progressJournal,
				workspace,
				processMaximumConcurrency: 2,
				controlWorker: ({ event }) => {
					progressControls.push(event.type);
				},
			},
		);
		const slowProgress = progressed.agent.observe({ capacity: 1 })[Symbol.asyncIterator]();
		await slowProgress.next();
		await Promise.all([
			progressed.agent.submit({ commands: [start("graph:progress-stress-one", 1)] }),
			progressed.agent.submit({ commands: [start("graph:progress-stress-two", 1)] }),
		]);
		const [progressOne, progressTwo] = await Promise.all([
			waitForGraphResult(progressed.agent, "graph:progress-stress-one"),
			waitForGraphResult(progressed.agent, "graph:progress-stress-two"),
		]);
		expect(progressOne.results[0]?.state).toBe("succeeded");
		expect(progressTwo.results[0]?.state).toBe("succeeded");
		expect(progressReports).toBe(20_000);
		await expect(slowProgress.next()).resolves.toMatchObject({ value: { type: "resync_required" } });
		expect(JSON.stringify(progressJournal.records)).not.toContain("progress:9999");
		expect(progressJournal.records.filter((record) => record.type === "worker_fact")).toHaveLength(20);
		expect(progressed.sessions.acceptedEventTypes).not.toContain("tool_execution_progress");
		expect(progressControls).not.toContain("tool_execution_progress");
		await progressed.agent.close();
	}, 15_000);

	it("does not call the Model until attempt_started is durably appended", async () => {
		const journal = new GatedGraphPersistence(
			(record) => record.type === "worker_fact" && record.fact.type === "attempt_started",
		);
		const { agent, modelCalls } = await harness([{}], { persistence: journal });
		await agent.submit({ commands: [start("graph:gated-attempt", 1)] });
		await journal.started.promise;
		expect(modelCalls).toEqual([]);
		journal.release.resolve();
		const result = await waitForGraphResult(agent, "graph:gated-attempt");
		expect(result.results[0]?.state).toBe("succeeded");
		expect(modelCalls).toEqual(["one"]);
		await agent.close();
	});

	it("does not call a Tool until tool_started is durably appended", async () => {
		const journal = new GatedGraphPersistence(
			(record) => record.type === "worker_fact" && record.fact.type === "tool_started",
		);
		let executions = 0;
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{
				tool: {
					...noOpTool("gated_tool"),
					execute: async () => {
						executions++;
						return { content: "done" };
					},
				},
				effect: "write",
			},
		];
		const { agent } = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("gated_tool", {}, { id: "tool:gated" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
				{},
			],
			{ persistence: journal, workspace },
		);
		await agent.submit({ commands: [start("graph:gated-tool", 1)] });
		await journal.started.promise;
		expect(executions).toBe(0);
		journal.release.resolve();
		const result = await waitForGraphResult(agent, "graph:gated-tool");
		expect(result.results[0]?.state).toBe("succeeded");
		expect(executions).toBe(1);
		await agent.close();
	});

	it("treats causal Worker Control as ordered progression rather than an Observation barrier", async () => {
		const controlStarted = deferred();
		const controlGate = deferred();
		const journal = new MemoryWorkspacePersistence();
		const controlledFacts: string[] = [];
		const factForControl: Partial<Record<AgentEvent["type"], string>> = {
			run_start: "run_started",
			turn_end: "turn_settled",
			run_end: "run_settled",
		};
		const { agent, modelCalls } = await harness([{}], {
			persistence: journal,
			controlWorker: async ({ event }) => {
				const expectedFact = factForControl[event.type];
				if (expectedFact) {
					expect(
						journal.records.some((record) => record.type === "worker_fact" && record.fact.type === expectedFact),
					).toBe(true);
					controlledFacts.push(expectedFact);
				}
				if (event.type === "run_start") {
					controlStarted.resolve();
					await controlGate.promise;
				}
			},
		});
		await agent.submit({ commands: [start("graph:worker-control", 1)] });
		await controlStarted.promise;
		expect(modelCalls).toEqual([]);
		controlGate.resolve();
		const result = await waitForGraphResult(agent, "graph:worker-control");
		expect(result.results[0]?.state).toBe("succeeded");
		expect(controlledFacts).toEqual(["run_started", "turn_settled", "run_settled"]);
		await agent.close();
	});

	it("diagnoses and detaches failed Worker Control without converting it into a fatal barrier", async () => {
		const controller = vi.fn(() => {
			throw new Error("detached control projection");
		});
		const { agent } = await harness([{}], { controlWorker: controller });
		const diagnostic = (async () => {
			for await (const observation of agent.observe({ capacity: 1_024 })) {
				if (observation.type === "diagnostic" && observation.diagnostic.code === "worker_controller_detached") {
					return observation;
				}
			}
			throw new Error("Observation stream closed before Worker Control detached");
		})();
		await agent.submit({ commands: [start("graph:worker-control-failure", 1)] });
		const result = await waitForGraphResult(agent, "graph:worker-control-failure");
		expect(result.results[0]?.state).toBe("succeeded");
		await expect(diagnostic).resolves.toMatchObject({
			type: "diagnostic",
			diagnostic: { code: "worker_controller_detached", message: "detached control projection" },
		});
		expect(controller).toHaveBeenCalledTimes(1);
		await agent.close();
	});

	it("closes idempotently, rejects later batches, and reports dropped Work Item input", async () => {
		const toolStarted = deferred();
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{
				tool: {
					name: "wait_for_close",
					description: "Wait until close cancels the Work Item",
					parameters: Type.Object({}, { additionalProperties: false }),
					replaySafety: "safe",
					execute: async (_arguments, context) => {
						toolStarted.resolve();
						await new Promise<void>((resolve) => {
							if (context.signal.aborted) resolve();
							else context.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						context.signal.throwIfAborted();
						return { content: "unreachable" };
					},
				},
				effect: "read",
			},
		];
		const sessions = new MemorySessions();
		const { agent } = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("wait_for_close", {}, { id: "tool:close" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
			],
			{ sessions, workspace },
		);
		await agent.submit({ commands: [start("graph:close", 1)] });
		await toolStarted.promise;
		await expect(
			agent.submit({
				commands: [
					{
						type: "deliver_work_item_input",
						graphId: "graph:close",
						itemId: "root",
						kind: "follow_up",
						input: "drop this pending input",
					},
				],
			}),
		).resolves.toMatchObject({ status: "accepted" });
		const firstClose = agent.close();
		const secondClose = agent.close();
		expect(secondClose).toBe(firstClose);
		await expect(firstClose).resolves.toEqual({
			canceledGraphIds: ["graph:close"],
			droppedInputs: 1,
			unknownWork: [],
		});
		await expect(agent.submit({ commands: [start("graph:after-close", 1)] })).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "closed" },
		});
		expect(sessions.closed).toEqual(["session:graph:close"]);
		expect(workspace.released).toHaveLength(1);
	});

	it("tears down the Runtime before an exceptional settlement releases its Session lease", async () => {
		const sessions = new MemorySessions();
		sessions.sharedSessionId = "session:shared-settlement";
		sessions.failEvidence = true;
		const { agent } = await harness([{}, {}], { sessions });

		await agent.submit({ commands: [start("graph:evidence-failure", 1)] });
		const interrupted = await waitForGraphResult(agent, "graph:evidence-failure");
		expect(interrupted.results[0]).toMatchObject({ state: "interrupted", durability: "unknown" });
		expect(sessions.closed).toEqual(["session:shared-settlement"]);

		sessions.failEvidence = false;
		await expect(agent.submit({ commands: [start("graph:reuse-after-teardown", 1)] })).resolves.toMatchObject({
			status: "accepted",
		});
		const reused = await waitForGraphResult(agent, "graph:reuse-after-teardown");
		expect(reused.results[0]?.state).toBe("succeeded");
		await agent.close();
	});

	it("quarantines a Session lease when Runtime teardown cannot confirm Session close", async () => {
		const sessions = new MemorySessions();
		sessions.sharedSessionId = "session:failed-close";
		sessions.failClose = true;
		const { agent } = await harness([{}, {}], { sessions });

		await agent.submit({ commands: [start("graph:failed-close", 1)] });
		const failed = await waitForGraphResult(agent, "graph:failed-close");
		expect(failed.results[0]).toMatchObject({
			state: "failed",
			diagnostics: [{ code: "worker_close_failed" }],
		});
		await expect(agent.submit({ commands: [start("graph:blocked-reuse", 1)] })).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "session_leased" },
		});

		sessions.failClose = false;
		await agent.close();
	});

	it("cancels and joins an in-flight Runtime opening before headless close releases ownership", async () => {
		const toolsStarted = deferred();
		const releaseTools = deferred();
		const workspace = new MemoryWorkspaceExecution();
		workspace.toolsOperation = async () => {
			toolsStarted.resolve();
			await releaseTools.promise;
			return [];
		};
		const journal = new FailOnceGraphPersistence((record) => record.type === "cancellation_requested");
		const { agent, sessions } = await harness([], { persistence: journal, workspace });

		await agent.submit({ commands: [start("graph:opening-close", 1)] });
		await toolsStarted.promise;
		const closed = await agent.close();
		expect(closed.unknownWork).toContainEqual({
			graphId: "graph:opening-close",
			itemId: "root",
			phase: "preparing",
		});
		expect(sessions.closed).toEqual(["session:graph:opening-close"]);

		releaseTools.resolve();
		await Promise.resolve();
		expect(sessions.closed).toEqual(["session:graph:opening-close"]);
	});

	it("keeps Submission causality, preparation identity, and resource references out of model input", async () => {
		const first = deferred();
		const resourceCommitStarted = deferred();
		const resourceCommit = deferred();
		const workerEvents: Array<{ readonly type: string; readonly resourceReferences?: readonly string[] }> = [];
		const { agent, modelCalls, modelContexts } = await harness([{ gate: first.promise }, {}], {
			resources: {
				reserve: async () => ({
					commit: async () => {
						resourceCommitStarted.resolve();
						await resourceCommit.promise;
					},
					rollback: () => Promise.resolve(),
				}),
			},
		});
		const settled = observeGraphEvents(agent, "graph:submission-envelope", (event) => {
			if (event.type === "preparation_started") {
				workerEvents.push({
					type: event.type,
					...(Array.isArray(event.resourceReferences)
						? {
								resourceReferences: event.resourceReferences.filter(
									(value): value is string => typeof value === "string",
								),
							}
						: {}),
				});
			}
		});
		await agent.submit({ commands: [start("graph:submission-envelope", 1)] });
		await vi.waitFor(() => expect(modelCalls).toEqual(["one"]));
		const delivery = agent.submit({
			commands: [
				{
					type: "deliver_work_item_input",
					graphId: "graph:submission-envelope",
					itemId: "root",
					kind: "follow_up",
					input: "model-visible follow-up",
					resources: ["resource:host-only"],
				},
			],
		});
		await resourceCommitStarted.promise;
		first.resolve();
		await Promise.resolve();
		expect(modelCalls).toEqual(["one"]);
		resourceCommit.resolve();
		await expect(delivery).resolves.toMatchObject({ status: "accepted" });
		await settled;
		expect(modelContexts.at(-1)).toContain("model-visible follow-up");
		expect(modelContexts.join("\n")).not.toMatch(/resource:host-only|preparation:/u);
		expect(workerEvents.at(-1)?.resourceReferences).toEqual(["resource:host-only"]);
		await agent.close();
	});

	it("exposes only read-effect Workspace tools to read-only Work Items", async () => {
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{ tool: noOpTool("read_tool"), effect: "read" },
			{ tool: noOpTool("write_tool"), effect: "write" },
			{ tool: noOpTool("unknown_tool"), effect: "unknown" },
		];
		const { agent, toolCatalogs } = await harness([{}], { workspace });
		await agent.submit({
			commands: [
				{
					...start("graph:read-only", 1),
					root: { itemId: "root", executionMode: "read_only" },
				},
			],
		});
		await waitForGraphResult(agent, "graph:read-only");
		expect(toolCatalogs).toEqual([["read_tool"]]);
		expect(workspace.boundEffects.every((effects) => effects.every((effect) => effect === "read"))).toBe(true);
		await agent.close();
	});

	it("schedules independent Work Items concurrently while preserving accepted source-order results", async () => {
		const root = deferred();
		const alpha = deferred();
		const beta = deferred();
		const workspace = new MemoryWorkspaceExecution();
		workspace.captureArtifacts = true;
		const { agent, modelCalls, sessions } = await harness(
			[{ gate: root.promise }, { gate: alpha.promise }, { gate: beta.promise }],
			{ workspace },
		);
		await expect(agent.submit({ commands: [start("graph:dag", 3)] })).resolves.toMatchObject({ status: "accepted" });
		await expect(
			agent.submit({
				commands: [
					{
						type: "add_work_items",
						graphId: "graph:dag",
						items: [
							{
								itemId: "alpha",
								parentItemId: "root",
								objective: "alpha objective",
								executionMode: "write",
							},
							{
								itemId: "beta",
								parentItemId: "root",
								objective: "beta objective",
								executionMode: "write",
							},
						],
					},
				],
			}),
		).resolves.toMatchObject({ status: "accepted" });
		await vi.waitFor(() => expect(modelCalls).toEqual(["one", "one", "one"]));
		const resultPromise = waitForGraphResult(agent, "graph:dag");
		beta.resolve();
		alpha.resolve();
		root.resolve();
		const result = await resultPromise;
		expect(result.results.map(({ itemId }) => itemId)).toEqual(["root", "alpha", "beta"]);
		expect(result.results.map(({ state }) => state)).toEqual(["succeeded", "succeeded", "succeeded"]);
		expect(result.effectiveConcurrency).toBe(3);
		expect(new Set(result.results.map(({ sessionId }) => sessionId)).size).toBe(3);
		expect(new Set(result.results.map(({ runtimeId }) => runtimeId)).size).toBe(3);
		expect(workspace.published).toEqual(["alpha", "beta", "root"]);
		await agent.close();
		expect(new Set(sessions.closed).size).toBe(3);
	});

	it("assigns exactly one settlement owner when parallel terminal paths converge on a graph", async () => {
		const root = deferred();
		const alpha = deferred();
		const beta = deferred();
		const graphResultStarted = deferred();
		const releaseGraphResult = deferred();
		const memory = new MemoryWorkspacePersistence();
		let graphResultAppends = 0;
		const journal: WorkspacePersistence = {
			acquire: async () =>
				interceptGraphStores(await memory.acquire(), async (record) => {
					if (record.type === "graph_result") {
						graphResultAppends++;
						graphResultStarted.resolve();
						await releaseGraphResult.promise;
					}
				}),
		};
		const { agent, modelCalls } = await harness(
			[{ gate: root.promise }, { gate: alpha.promise }, { gate: beta.promise }],
			{ persistence: journal },
		);
		const settledObservations: WorkGraphResult[] = [];
		const observation = (async () => {
			for await (const event of agent.observe({ capacity: 1_024 })) {
				if (event.type === "work_graph_settled" && event.result.graphId === "graph:single-settlement") {
					settledObservations.push(event.result);
				}
			}
		})();
		await agent.submit({ commands: [start("graph:single-settlement", 3)] });
		await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:single-settlement",
					items: [
						{ itemId: "alpha", parentItemId: "root", objective: "alpha", executionMode: "read_only" },
						{ itemId: "beta", parentItemId: "root", objective: "beta", executionMode: "read_only" },
					],
				},
			],
		});
		await vi.waitFor(() => expect(modelCalls).toHaveLength(3));
		root.resolve();
		alpha.resolve();
		beta.resolve();
		await graphResultStarted.promise;
		await Promise.resolve();
		expect(graphResultAppends).toBe(1);
		releaseGraphResult.resolve();
		await waitForGraphResult(agent, "graph:single-settlement");
		await agent.close();
		await observation;

		expect(memory.records.filter(({ type }) => type === "graph_result")).toHaveLength(1);
		expect(settledObservations).toHaveLength(1);
	});

	it("rejects an invalid AddWorkItems batch atomically before any item becomes visible", async () => {
		const gate = deferred();
		const { agent, workspace } = await harness([{ gate: gate.promise }]);
		await agent.submit({ commands: [start("graph:atomic")] });
		const before = workspace.reserved.length;
		const duplicate = await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:atomic",
					items: [
						{ itemId: "same", parentItemId: "root", objective: "one", executionMode: "read_only" },
						{ itemId: "same", parentItemId: "root", objective: "two", executionMode: "read_only" },
					],
				},
			],
		});
		expect(duplicate).toMatchObject({ status: "rejected", rejection: { code: "duplicate_identity" } });
		const missing = await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:atomic",
					items: [
						{
							itemId: "missing",
							parentItemId: "root",
							dependencies: ["not-there"],
							objective: "missing dependency",
							executionMode: "read_only",
						},
					],
				},
			],
		});
		expect(missing).toMatchObject({ status: "rejected", rejection: { code: "missing_dependency" } });
		const cycle = await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:atomic",
					items: [
						{
							itemId: "cycle",
							parentItemId: "root",
							dependencies: ["cycle"],
							objective: "cycle",
							executionMode: "read_only",
						},
					],
				},
			],
		});
		expect(cycle).toMatchObject({ status: "rejected", rejection: { code: "dependency_cycle" } });
		expect(workspace.reserved).toHaveLength(before);
		const iterator = agent.observe()[Symbol.asyncIterator]();
		const snapshot = (await iterator.next()).value as Extract<CodingAgentObservation, { type: "snapshot" }>;
		expect(snapshot.snapshot.graphs[0]?.items.map(({ itemId }) => itemId)).toEqual(["root"]);
		await iterator.return?.();
		gate.resolve();
		await waitForGraphResult(agent, "graph:atomic");
		await agent.close();
	});

	it("rejects a command batch that targets more than one Work Graph", async () => {
		const persistence = new MemoryWorkspacePersistence();
		const { agent, workspace } = await harness([], { persistence });
		await expect(
			agent.submit({ commands: [start("graph:batch-one"), start("graph:batch-two")] }),
		).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "invalid_command", message: expect.stringContaining("exactly one Work Graph") },
		});
		expect(persistence.ledgerSnapshot().activeGraphs).toEqual([]);
		expect(persistence.records).toEqual([]);
		expect(workspace.reserved).toEqual([]);
		await agent.close();
	});

	it("shares graph and process concurrency budgets across all schedulable Work Items", async () => {
		const firstRoot = deferred();
		const firstChild = deferred();
		const secondChild = deferred();
		const secondRoot = deferred();
		const { agent, modelCalls } = await harness(
			[
				{ gate: firstRoot.promise },
				{ gate: firstChild.promise },
				{ gate: secondChild.promise },
				{ gate: secondRoot.promise },
			],
			{ processMaximumConcurrency: 2 },
		);
		await agent.submit({ commands: [start("graph:first", 2)] });
		await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:first",
					items: [
						{ itemId: "first", parentItemId: "root", objective: "first", executionMode: "read_only" },
						{ itemId: "second", parentItemId: "root", objective: "second", executionMode: "read_only" },
					],
				},
			],
		});
		await agent.submit({ commands: [start("graph:second", 2)] });
		await vi.waitFor(() => expect(modelCalls).toHaveLength(2));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(modelCalls).toHaveLength(2);
		firstChild.resolve();
		await vi.waitFor(() => expect(modelCalls).toHaveLength(3));
		secondChild.resolve();
		await vi.waitFor(() => expect(modelCalls).toHaveLength(4));
		firstRoot.resolve();
		secondRoot.resolve();
		const [firstResult, secondResult] = await Promise.all([
			waitForGraphResult(agent, "graph:first"),
			waitForGraphResult(agent, "graph:second"),
		]);
		expect(firstResult.effectiveConcurrency).toBe(2);
		expect(secondResult.effectiveConcurrency).toBe(1);
		await agent.close();
	});

	it("rolls back Session and Placement reservations and rejects Session sharing", async () => {
		const gate = deferred();
		const sessions = new MemorySessions();
		sessions.sharedSessionId = "session:shared";
		const workspace = new MemoryWorkspaceExecution();
		const { agent } = await harness([{ gate: gate.promise }], { sessions, workspace });
		await agent.submit({ commands: [start("graph:lease")] });
		const receipt = await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:lease",
					items: [{ itemId: "child", parentItemId: "root", objective: "child", executionMode: "write" }],
				},
			],
		});
		expect(receipt).toMatchObject({ status: "rejected", rejection: { code: "session_leased" } });
		expect(sessions.rolledBack).toContain("session:shared");
		expect(workspace.rolledBack.some((id) => id.endsWith(":child"))).toBe(true);
		gate.resolve();
		await waitForGraphResult(agent, "graph:lease");
		await agent.close();
	});

	it("rejects reservation failures without leaking partially reserved ownership", async () => {
		const gate = deferred();
		const sessions = new MemorySessions();
		const workspace = new MemoryWorkspaceExecution();
		workspace.failItemId = "placement-fails";
		const resources = {
			reserve: async () => {
				throw new Error("scripted resource failure");
			},
		};
		const { agent } = await harness([{ gate: gate.promise }], { sessions, workspace, resources });
		await agent.submit({ commands: [start("graph:reservation")] });
		const placementFailure = await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:reservation",
					items: [
						{
							itemId: "placement-fails",
							parentItemId: "root",
							objective: "fail placement",
							executionMode: "write",
						},
					],
				},
			],
		});
		expect(placementFailure).toMatchObject({
			status: "rejected",
			rejection: { code: "placement_reservation_failed" },
		});
		const resourceFailure = await agent.submit({
			commands: [
				{
					type: "deliver_work_item_input",
					graphId: "graph:reservation",
					itemId: "root",
					kind: "steering",
					input: "resource-backed input",
					resources: ["resource:one"],
				},
			],
		});
		expect(resourceFailure).toMatchObject({ status: "rejected", rejection: { code: "resource_reservation_failed" } });
		gate.resolve();
		await waitForGraphResult(agent, "graph:reservation");
		await agent.close();
	});

	it("never commits an input resource when the durable batch barrier rejects", async () => {
		const run = deferred();
		let commits = 0;
		let rollbacks = 0;
		const journal = new FailOnceGraphPersistence(
			(record) => record.type === "batch_accepted" && record.batchId === "batch:resource-rejected",
		);
		const { agent, modelCalls } = await harness([{ gate: run.promise }], {
			persistence: journal,
			resources: {
				reserve: async () => ({
					commit: async () => {
						commits++;
					},
					rollback: async () => {
						rollbacks++;
					},
				}),
			},
		});
		await agent.submit({ commands: [start("graph:resource-rejected", 1)] });
		await vi.waitFor(() => expect(modelCalls).toHaveLength(1));

		const receipt = await agent.submit({
			batchId: "batch:resource-rejected",
			commands: [
				{
					type: "deliver_work_item_input",
					graphId: "graph:resource-rejected",
					itemId: "root",
					kind: "steering",
					input: "resource input",
					resources: ["resource:rejected"],
				},
			],
		});

		expect(receipt).toMatchObject({ status: "rejected", rejection: { code: "graph_store_failed" } });
		expect({ commits, rollbacks }).toEqual({ commits: 0, rollbacks: 1 });
		run.resolve();
		await waitForGraphResult(agent, "graph:resource-rejected");
		await agent.close();
	});

	it("accepts durably but interrupts Work before the Model when input resource commit fails", async () => {
		const journal = new MemoryWorkspacePersistence();
		let rollbacks = 0;
		const { agent, modelCalls } = await harness([], {
			persistence: journal,
			resources: {
				reserve: async () => ({
					commit: async () => {
						throw new Error("scripted input commit failure");
					},
					rollback: async () => {
						rollbacks++;
					},
				}),
			},
		});

		const receipt = await agent.submit({
			batchId: "batch:resource-commit-fails",
			commands: [
				start("graph:resource-commit-fails", 1),
				{
					type: "deliver_work_item_input",
					graphId: "graph:resource-commit-fails",
					itemId: "root",
					kind: "prompt",
					input: "must not run",
					resources: ["resource:fails"],
				},
			],
		});
		expect(receipt).toMatchObject({ status: "accepted" });
		const result = await waitForGraphResult(agent, "graph:resource-commit-fails");

		expect(modelCalls).toEqual([]);
		expect(rollbacks).toBe(0);
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			diagnostics: [{ code: "input_resource_commit_failed" }],
		});
		expect(
			journal.records.some((record) => record.type === "input_resources_settled" && record.outcome === "failed"),
		).toBe(true);
		await agent.close();
	});

	it("never replays accepted input whose resource settlement was not journaled before recovery", async () => {
		const resourceCommitStarted = deferred();
		const resourceCommit = deferred();
		const liveJournal = new MemoryWorkspacePersistence();
		const live = await harness([], {
			persistence: liveJournal,
			resources: {
				reserve: async () => ({
					commit: async () => {
						resourceCommitStarted.resolve();
						await resourceCommit.promise;
					},
					rollback: () => Promise.resolve(),
				}),
			},
		});
		const submission = live.agent.submit({
			batchId: "batch:resource-recovery",
			commands: [
				start("graph:resource-recovery", 1),
				{
					type: "deliver_work_item_input",
					graphId: "graph:resource-recovery",
					itemId: "root",
					kind: "prompt",
					input: "must never be replayed",
					resources: ["resource:uncertain"],
				},
			],
		});
		await resourceCommitStarted.promise;
		expect(liveJournal.records.map(({ type }) => type)).toEqual(["batch_accepted"]);

		const recoveredJournal = new MemoryWorkspacePersistence(liveJournal.records);
		const recovered = await harness([], { persistence: recoveredJournal });
		const result = await waitForPersistedGraphResult(recoveredJournal, "graph:resource-recovery");
		expect(recovered.modelCalls).toEqual([]);
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			diagnostics: [
				{
					code: "recovered_interruption",
					message: expect.stringContaining("input_resource_settlement_unknown"),
				},
			],
		});
		await recovered.agent.close();

		resourceCommit.resolve();
		await expect(submission).resolves.toMatchObject({ status: "accepted" });
		await live.agent.close();
	});

	it("revalidates live Work state after asynchronous resource reservation", async () => {
		const run = deferred();
		const reservationStarted = deferred();
		const reservation = deferred();
		let commits = 0;
		let rollbacks = 0;
		const journal = new MemoryWorkspacePersistence();
		const { agent, modelCalls } = await harness([{ gate: run.promise }], {
			persistence: journal,
			resources: {
				reserve: async () => {
					reservationStarted.resolve();
					await reservation.promise;
					return {
						commit: async () => {
							commits++;
						},
						rollback: async () => {
							rollbacks++;
						},
					};
				},
			},
		});
		await agent.submit({ commands: [start("graph:resource-race", 1)] });
		await vi.waitFor(() => expect(modelCalls).toHaveLength(1));
		const delivery = agent.submit({
			batchId: "batch:resource-race",
			commands: [
				{
					type: "deliver_work_item_input",
					graphId: "graph:resource-race",
					itemId: "root",
					kind: "follow_up",
					input: "too late",
					resources: ["resource:late"],
				},
			],
		});
		await reservationStarted.promise;
		run.resolve();
		await vi.waitFor(() => expect(journal.records.some((record) => record.type === "item_result")).toBe(true));
		reservation.resolve();

		await expect(delivery).resolves.toMatchObject({ status: "rejected", rejection: { code: "invalid_state" } });
		expect({ commits, rollbacks }).toEqual({ commits: 0, rollbacks: 1 });
		expect(
			journal.records.some((record) => record.type === "batch_accepted" && record.batchId === "batch:resource-race"),
		).toBe(false);
		await waitForGraphResult(agent, "graph:resource-race");
		await agent.close();
	});

	it("never reports a durable accepted batch as rejected when later cancellation bookkeeping fails", async () => {
		const root = deferred();
		const journal = new FailOnceGraphPersistence((record) => record.type === "cancellation_requested");
		const { agent } = await harness([{ gate: root.promise }], { persistence: journal });
		await agent.submit({ commands: [start("graph:accepted-barrier", 1)] });
		await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:accepted-barrier",
					items: [
						{
							itemId: "pending-child",
							parentItemId: "root",
							objective: "remain pending",
							executionMode: "read_only",
						},
					],
				},
			],
		});
		await expect(
			agent.submit({
				commands: [
					{
						type: "cancel_work",
						target: { type: "item", graphId: "graph:accepted-barrier", itemId: "pending-child" },
					},
				],
			}),
		).resolves.toMatchObject({ status: "accepted" });
		root.resolve();
		const result = await waitForGraphResult(agent, "graph:accepted-barrier");
		expect(result.results.find(({ itemId }) => itemId === "pending-child")?.state).toBe("canceled");
		await agent.close();
	});

	it("cascades idempotent Work Item cancellation through descendants", async () => {
		const root = deferred();
		const { agent } = await harness([{ gate: root.promise }]);
		await agent.submit({ commands: [start("graph:cancel", 1)] });
		await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:cancel",
					items: [
						{ itemId: "child", parentItemId: "root", objective: "child", executionMode: "write" },
						{ itemId: "grandchild", parentItemId: "child", objective: "grandchild", executionMode: "write" },
					],
				},
			],
		});
		const cancellation = {
			type: "cancel_work" as const,
			target: { type: "item" as const, graphId: "graph:cancel", itemId: "root" },
		};
		await expect(agent.submit({ commands: [cancellation, cancellation] })).resolves.toMatchObject({
			status: "accepted",
		});
		root.resolve();
		const result = await waitForGraphResult(agent, "graph:cancel");
		expect(result.results.map(({ state }) => state)).toEqual(["canceled", "canceled", "canceled"]);
		expect(result.outcome).toBe("canceled");
		await agent.close();
	});

	it("applies Desired Runtime Configuration only to later Runs in the same Work Item", async () => {
		const first = deferred();
		const { agent, modelCalls } = await harness([{ gate: first.promise }, {}]);
		await agent.submit({ commands: [start("graph:configuration", 1, "one")] });
		await vi.waitFor(() => expect(modelCalls).toEqual(["one"]));
		await agent.submit({
			commands: [
				{
					type: "configure_work_item",
					graphId: "graph:configuration",
					itemId: "root",
					configuration: { model: { provider: "work", id: "two" }, reasoning: "off" },
				},
				{
					type: "deliver_work_item_input",
					graphId: "graph:configuration",
					itemId: "root",
					kind: "follow_up",
					input: "second run",
				},
			],
		});
		first.resolve();
		await waitForGraphResult(agent, "graph:configuration");
		expect(modelCalls).toEqual(["one", "two"]);
		await agent.close();
	});

	it("blocks failed dependents while allowing independent siblings to finish", async () => {
		const root = deferred();
		const failed = deferred();
		const independent = deferred();
		const { agent } = await harness([
			{ gate: root.promise },
			{ gate: failed.promise, outcome: "error" },
			{ gate: independent.promise },
		]);
		await agent.submit({ commands: [start("graph:blocking", 3)] });
		await agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:blocking",
					items: [
						{ itemId: "failed", parentItemId: "root", objective: "fail", executionMode: "read_only" },
						{
							itemId: "dependent",
							parentItemId: "root",
							dependencies: ["failed"],
							objective: "blocked",
							executionMode: "read_only",
						},
						{
							itemId: "independent",
							parentItemId: "root",
							objective: "continue",
							executionMode: "read_only",
						},
					],
				},
			],
		});
		failed.resolve();
		independent.resolve();
		root.resolve();
		const result = await waitForGraphResult(agent, "graph:blocking");
		expect(result.results.map(({ itemId, state }) => [itemId, state])).toEqual([
			["root", "succeeded"],
			["failed", "failed"],
			["dependent", "blocked"],
			["independent", "succeeded"],
		]);
		expect(result.outcome).toBe("partial");
		await agent.close();
	});

	it("exposes frozen data-only snapshots and resynchronizes slow observers", async () => {
		const gate = deferred();
		const { agent } = await harness([{ gate: gate.promise }]);
		const iterator = agent.observe({ capacity: 1 })[Symbol.asyncIterator]();
		const initial = await iterator.next();
		expect(initial.value).toMatchObject({ type: "snapshot", snapshot: { graphs: [] } });
		await agent.submit({ commands: [start("graph:snapshot")] });
		await waitForState(agent, "graph:snapshot", "root", "running");
		const slow = await iterator.next();
		expect(slow.value).toMatchObject({ type: "resync_required", reason: "slow_consumer" });
		const fresh = agent.observe()[Symbol.asyncIterator]();
		const snapshot = (await fresh.next()).value as Extract<CodingAgentObservation, { type: "snapshot" }>;
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.snapshot.graphs[0]?.items[0])).toBe(true);
		expect(JSON.stringify(snapshot)).toContain("graph:snapshot");
		expect(JSON.stringify(snapshot)).not.toMatch(/execute|dispose|streamSimple|authSnapshot/u);
		await fresh.return?.();
		gate.resolve();
		await waitForGraphResult(agent, "graph:snapshot");
		await agent.close();
	});

	it("classifies fatal journal barriers by whether an external effect may already have begun", async () => {
		const beforeEffectJournal = new FailOnceGraphPersistence(
			(record) => record.type === "worker_fact" && record.fact.type === "run_started",
		);
		const beforeEffect = await harness([], { persistence: beforeEffectJournal });
		const failedResult = waitForGraphResult(beforeEffect.agent, "graph:barrier-before");
		await beforeEffect.agent.submit({ commands: [start("graph:barrier-before")] });
		const failed = await failedResult;
		expect(failed.results[0]).toMatchObject({ state: "failed", publication: { state: "not_required" } });
		expect(beforeEffect.modelCalls).toEqual([]);
		await beforeEffect.agent.close();

		const sessions = new MemorySessions();
		sessions.failAcceptEventType = "attempt_end";
		const afterModelEffect = await harness([{}], { sessions });
		await afterModelEffect.agent.submit({ commands: [start("graph:session-barrier-after")] });
		const sessionInterrupted = await waitForGraphResult(afterModelEffect.agent, "graph:session-barrier-after");
		expect(sessionInterrupted.results[0]).toMatchObject({
			state: "interrupted",
			run: { outcome: "error" },
		});
		await afterModelEffect.agent.close();

		const workspace = new MemoryWorkspaceExecution();
		workspace.captureArtifacts = true;
		const afterEffectJournal = new FailOnceGraphPersistence(
			(record) =>
				record.type === "publication" &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				!Array.isArray(record.payload) &&
				record.payload.phase === "settled",
		);
		const afterEffect = await harness([{}], { persistence: afterEffectJournal, workspace });
		const interruptedResult = waitForGraphResult(afterEffect.agent, "graph:barrier-after");
		await afterEffect.agent.submit({ commands: [start("graph:barrier-after")] });
		const interrupted = await interruptedResult;
		expect(workspace.published).toEqual(["root"]);
		expect(interrupted.results[0]).toMatchObject({
			state: "interrupted",
			publication: { state: "not_published", reason: "interrupted" },
			diagnostics: [{ code: "publication_barrier_failed" }],
		});
		await afterEffect.agent.close();

		const resultJournal = new FailOnceGraphPersistence((record) => record.type === "item_result");
		const resultBarrier = await harness([{}], { persistence: resultJournal });
		const undurableResult = waitForGraphResult(resultBarrier.agent, "graph:result-barrier");
		await resultBarrier.agent.submit({ commands: [start("graph:result-barrier")] });
		const undurable = await undurableResult;
		expect(undurable).toMatchObject({
			durability: "unknown",
			results: [{ durability: "unknown", state: "interrupted" }],
		});
		const resultRecoveryRecords = structuredClone(resultJournal.memory.records);
		await expect(resultBarrier.agent.close()).resolves.toMatchObject({
			unknownWork: [{ itemId: "root", phase: "result" }],
		});

		const recoveredResultPersistence = new MemoryWorkspacePersistence(resultRecoveryRecords);
		const recoveredResult = await harness([], {
			persistence: recoveredResultPersistence,
			workspace: new MemoryWorkspaceExecution(),
		});
		const recoveredResultBarrier = await waitForPersistedGraphResult(
			recoveredResultPersistence,
			"graph:result-barrier",
		);
		expect(recoveredResultBarrier).toMatchObject({
			durability: "confirmed",
			results: [{ durability: "confirmed", state: "interrupted" }],
		});
		expect(recoveredResult.modelCalls).toEqual([]);
		await recoveredResult.agent.close();
	});

	it("latches the first safe Session failure and skips all cleanup Facts and Control", async () => {
		const sessions = new MemorySessions();
		sessions.failAcceptEventType = "run_start";
		const journal = new MemoryWorkspacePersistence();
		const controlTypes: AgentEvent["type"][] = [];
		const { agent, modelCalls } = await harness([], {
			sessions,
			persistence: journal,
			controlWorker: ({ event }) => {
				controlTypes.push(event.type);
			},
		});
		const diagnostics: string[] = [];
		const settled = (async () => {
			for await (const observation of agent.observe({ capacity: 128 })) {
				if (observation.type === "diagnostic") diagnostics.push(observation.diagnostic.code);
				if (observation.type === "work_graph_settled" && observation.result.graphId === "graph:latched-session") {
					return observation.result;
				}
			}
			throw new Error("Observation stream closed before the latched Session failure settled");
		})();
		await agent.submit({ commands: [start("graph:latched-session", 1)] });
		const result = await settled;
		expect(result.results[0]).toMatchObject({
			state: "failed",
			diagnostics: [{ code: "session_barrier_failed", message: expect.stringContaining("run_start") }],
		});
		expect(modelCalls).toEqual([]);
		expect(journal.records.filter((record) => record.type === "worker_fact")).toEqual([]);
		expect(controlTypes).toEqual([]);
		expect(diagnostics.filter((code) => code === "session_barrier_failed")).toHaveLength(1);
		await agent.close();
	});

	it("interrupts a Work Item whose Agent settles with an open Model effect window", async () => {
		const journal = new MemoryWorkspacePersistence();
		const { agent, modelCalls } = await harness([], {
			persistence: journal,
			modelStreamFailure: new Error("model transport vanished after dispatch"),
		});
		await agent.submit({ commands: [start("graph:unclosed-model-window", 1)] });
		const result = await waitForGraphResult(agent, "graph:unclosed-model-window");

		expect(modelCalls).toEqual(["one"]);
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			diagnostics: [{ code: "worker_failed" }, { code: "worker_effect_window_unclosed" }],
		});
		expect(
			journal.records.filter((record) => record.type === "worker_fact").map((record) => record.fact.type),
		).toEqual(["run_started", "attempt_started", "turn_settled", "run_settled"]);
		await agent.close();
	});

	it("derives Tool barrier classification from parallel open windows", async () => {
		const firstStartFailure = new FailOnceGraphPersistence(
			(record) => record.type === "worker_fact" && record.fact.type === "tool_started",
		);
		let firstExecutions = 0;
		const firstWorkspace = new MemoryWorkspaceExecution();
		firstWorkspace.contributions = [
			{
				tool: {
					...noOpTool("first_tool"),
					execute: async () => {
						firstExecutions++;
						return { content: "unreachable" };
					},
				},
				effect: "write",
			},
		];
		const first = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("first_tool", {}, { id: "tool:first" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
			],
			{ persistence: firstStartFailure, workspace: firstWorkspace },
		);
		await first.agent.submit({ commands: [start("graph:first-tool-barrier", 1)] });
		const safelyFailed = await waitForGraphResult(first.agent, "graph:first-tool-barrier");
		expect(safelyFailed.results[0]?.state).toBe("failed");
		expect(firstExecutions).toBe(0);
		expect(firstStartFailure.attempts.at(-1)).toMatchObject({
			type: "worker_fact",
			fact: { type: "tool_started", toolName: "first_tool" },
		});
		await first.agent.close();

		const secondStartFailure = new FailOnceGraphPersistence(
			(record) =>
				record.type === "worker_fact" &&
				record.fact.type === "tool_started" &&
				record.fact.toolName === "parallel_two",
		);
		const executions: string[] = [];
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = ["parallel_one", "parallel_two"].map((name) => ({
			tool: {
				...noOpTool(name),
				parallelSafe: true,
				execute: async (_arguments: unknown, context: { readonly signal: AbortSignal }) => {
					executions.push(name);
					await new Promise<void>((resolve) => {
						if (context.signal.aborted) resolve();
						else context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					context.signal.throwIfAborted();
					return { content: "unreachable" };
				},
			},
			effect: "write" as const,
		}));
		const parallel = await harness(
			[
				{
					message: fauxAssistantMessage(
						[
							fauxToolCall("parallel_one", {}, { id: "tool:first" }),
							fauxToolCall("parallel_two", {}, { id: "tool:second" }),
						],
						{ stopReason: "toolUse", timestamp: 1_000 },
					),
				},
			],
			{ persistence: secondStartFailure, workspace },
		);
		await parallel.agent.submit({ commands: [start("graph:parallel-tool-barrier", 1)] });
		const interrupted = await waitForGraphResult(parallel.agent, "graph:parallel-tool-barrier");
		expect(interrupted.results[0]?.state).toBe("interrupted");
		expect(executions).toEqual(["parallel_one"]);
		expect(secondStartFailure.attempts.at(-1)).toMatchObject({
			type: "worker_fact",
			fact: { type: "tool_started", toolName: "parallel_two" },
		});
		expect(secondStartFailure.memory.records.at(-1)).toMatchObject({
			type: "worker_fact",
			fact: { type: "tool_started", toolName: "parallel_one" },
		});
		await parallel.agent.close();
	});

	it("does not share an append or flush tail across Work Graph stores", async () => {
		const persistence = new GatedGraphPersistence(
			(record) =>
				record.type === "worker_fact" &&
				record.graphId === "graph:slow-store" &&
				record.fact.type === "attempt_started",
		);
		const { agent, modelCalls } = await harness([{}, {}], {
			persistence,
			processMaximumConcurrency: 2,
		});
		const slowResult = waitForGraphResult(agent, "graph:slow-store");
		await agent.submit({ commands: [start("graph:slow-store", 1)] });
		await persistence.started.promise;

		const independentResult = waitForGraphResult(agent, "graph:independent-store");
		await agent.submit({ commands: [start("graph:independent-store", 1)] });
		expect((await independentResult).results[0]?.state).toBe("succeeded");
		expect(modelCalls).toHaveLength(1);

		persistence.release.resolve();
		expect((await slowResult).results[0]?.state).toBe("succeeded");
		expect(modelCalls).toHaveLength(2);
		await agent.close();
	});

	it("isolates one Work Graph store failure and one Session failure from sibling Graphs", async () => {
		const persistence = new FailOnceGraphPersistence(
			(record) =>
				record.type === "worker_fact" &&
				record.graphId === "graph:store-poison" &&
				record.fact.type === "tool_started",
		);
		let toolExecutions = 0;
		const workspace = new MemoryWorkspaceExecution();
		workspace.contributions = [
			{
				tool: {
					...noOpTool("poison_tool"),
					execute: async () => {
						toolExecutions++;
						return { content: "unreachable" };
					},
				},
				effect: "write",
			},
		];
		const isolatedStores = await harness(
			[
				{
					message: fauxAssistantMessage(fauxToolCall("poison_tool", {}, { id: "tool:poison" }), {
						stopReason: "toolUse",
						timestamp: 1_000,
					}),
				},
				{},
				{},
			],
			{ persistence, workspace, processMaximumConcurrency: 2 },
		);
		const persistenceFailure = (async () => {
			for await (const observation of isolatedStores.agent.observe({ capacity: 128 })) {
				if (
					observation.type === "diagnostic" &&
					observation.graphId === "graph:store-poison" &&
					observation.diagnostic.code === "work_graph_persistence_failed"
				) {
					return;
				}
			}
		})();
		const poisonedResult = waitForGraphResult(isolatedStores.agent, "graph:store-poison");
		await isolatedStores.agent.submit({ commands: [start("graph:store-poison", 1)] });
		await persistenceFailure;
		const siblingResult = waitForGraphResult(isolatedStores.agent, "graph:store-sibling");
		await expect(isolatedStores.agent.submit({ commands: [start("graph:store-sibling", 1)] })).resolves.toMatchObject(
			{ status: "accepted" },
		);
		const laterResult = waitForGraphResult(isolatedStores.agent, "graph:store-later");
		await expect(isolatedStores.agent.submit({ commands: [start("graph:store-later", 1)] })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(
			isolatedStores.agent.submit({
				commands: [
					{
						type: "deliver_work_item_input",
						graphId: "graph:store-poison",
						itemId: "root",
						kind: "steering",
						input: "must reject",
					},
				],
			}),
		).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "graph_store_failed", graphId: "graph:store-poison" },
		});
		expect((await poisonedResult).results[0]?.durability).toBe("unknown");
		expect((await siblingResult).results[0]?.state).toBe("succeeded");
		expect((await laterResult).results[0]?.state).toBe("succeeded");
		expect(toolExecutions).toBe(0);
		await isolatedStores.agent.close();

		const sessions = new MemorySessions();
		sessions.failAcceptEventType = "run_start";
		const isolated = await harness([{}], { sessions, processMaximumConcurrency: 2 });
		const failedResult = waitForGraphResult(isolated.agent, "graph:session-fails");
		const succeededResult = waitForGraphResult(isolated.agent, "graph:session-succeeds");
		await isolated.agent.submit({ commands: [start("graph:session-fails", 1)] });
		await isolated.agent.submit({ commands: [start("graph:session-succeeds", 1)] });
		const [failed, succeeded] = await Promise.all([failedResult, succeededResult]);
		expect(failed.results[0]?.state).toBe("failed");
		expect(succeeded.results[0]?.state).toBe("succeeded");
		expect(isolated.modelCalls).toEqual(["one"]);
		await isolated.agent.close();
	});

	it("retains ledger Session owners for an unreadable Graph without stalling unrelated Graphs", async () => {
		const failedGraph = "graph:unreadable-owner" as WorkGraphId;
		const memory = new MemoryWorkspacePersistence({
			ledger: {
				activeGraphs: [{ graphId: failedGraph, order: 0 }],
				nextGraphOrder: 1,
				nextPublicationOrder: 1,
				sessionOwners: [{ sessionId: "session:quarantined", graphId: failedGraph, itemId: "root" as WorkItemId }],
				targetIdentities: [],
				diagnostics: [],
			},
		});
		const persistence: WorkspacePersistence = {
			acquire: async () => {
				const lease = await memory.acquire();
				return Object.freeze({
					...lease,
					openGraph: async (graphId: WorkGraphId) => {
						if (graphId === failedGraph) throw new Error("injected unreadable Graph store");
						return lease.openGraph(graphId);
					},
				});
			},
		};
		const sessions = new MemorySessions();
		const { agent } = await harness([{}], { persistence, sessions });
		await expect(
			agent.submit({
				commands: [{ type: "cancel_work", target: { type: "graph", graphId: failedGraph } }],
			}),
		).resolves.toMatchObject({ status: "rejected", rejection: { code: "graph_store_failed" } });
		await expect(
			agent.submit({
				commands: [
					{
						...start("graph:owner-reuse", 1),
						session: { type: "resume", sessionId: "session:quarantined" },
					},
				],
			}),
		).resolves.toMatchObject({ status: "rejected", rejection: { code: "session_leased" } });
		const unrelatedResult = waitForGraphResult(agent, "graph:owner-unrelated");
		await expect(agent.submit({ commands: [start("graph:owner-unrelated", 1)] })).resolves.toMatchObject({
			status: "accepted",
		});
		expect((await unrelatedResult).results[0]?.state).toBe("succeeded");
		expect(memory.ledgerSnapshot().sessionOwners).toContainEqual({
			sessionId: "session:quarantined",
			graphId: failedGraph,
			itemId: "root",
		});
		await agent.close();
	});

	it("fail-stops the Workspace when the Workspace Ledger fails", async () => {
		const finishPoison = deferred();
		const finishSibling = deferred();
		const persistence = new PoisonedLedgerPersistence(
			(operation, graphId) => operation === "archiveGraph" && graphId === "graph:ledger-poison",
		);
		const { agent } = await harness([{ gate: finishPoison.promise }, { gate: finishSibling.promise }], {
			persistence,
			processMaximumConcurrency: 2,
		});
		const ledgerFailure = (async () => {
			for await (const observation of agent.observe({ capacity: 128 })) {
				if (
					observation.type === "diagnostic" &&
					observation.diagnostic.code === "workspace_ledger_persistence_failed"
				) {
					return;
				}
			}
		})();
		const poisonedResult = waitForGraphResult(agent, "graph:ledger-poison");
		const siblingResult = waitForGraphResult(agent, "graph:ledger-sibling");
		await agent.submit({ commands: [start("graph:ledger-poison", 1)] });
		await agent.submit({ commands: [start("graph:ledger-sibling", 1)] });
		finishPoison.resolve();
		await ledgerFailure;
		await expect(agent.submit({ commands: [start("graph:ledger-rejected", 1)] })).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "ledger_failed", message: expect.stringContaining("Workspace Ledger") },
		});
		finishSibling.resolve();
		const [poisoned, sibling] = await Promise.all([poisonedResult, siblingResult]);
		expect(poisoned.durability).toBe("unknown");
		expect(sibling.results[0]).toMatchObject({ durability: "unknown", state: "interrupted" });
		expect(persistence.attempts).toContain("archiveGraph:graph:ledger-poison");
		await agent.close();
	});

	it("linearizes new Graph acceptance at the ledger index and quarantines a rejected initial segment", async () => {
		const persistence = new PoisonedLedgerPersistence((operation) => operation === "accept");
		const rejected = await harness([], { persistence });
		await expect(rejected.agent.submit({ commands: [start("graph:index-failure", 1)] })).resolves.toMatchObject({
			status: "rejected",
			rejection: { code: "ledger_failed" },
		});
		expect(persistence.memory.ledgerSnapshot().activeGraphs).toEqual([]);
		expect(persistence.memory.graphRecords("graph:index-failure" as WorkGraphId)).toEqual([
			expect.objectContaining({ type: "batch_accepted" }),
		]);
		await rejected.agent.close();

		const nextEpoch = await harness([{}], { persistence: persistence.memory });
		const result = waitForGraphResult(nextEpoch.agent, "graph:index-failure");
		await expect(nextEpoch.agent.submit({ commands: [start("graph:index-failure", 1)] })).resolves.toMatchObject({
			status: "accepted",
		});
		expect((await result).results[0]?.state).toBe("succeeded");
		expect(
			persistence.memory
				.graphRecords("graph:index-failure" as WorkGraphId)
				.filter((record) => record.type === "batch_accepted"),
		).toHaveLength(1);
		await nextEpoch.agent.close();
	});

	it("projects active Run state only after the run_started Fact commits", async () => {
		const journal = new GatedGraphPersistence(
			(record) => record.type === "worker_fact" && record.fact.type === "run_started",
		);
		const model = deferred();
		const { agent } = await harness([{ gate: model.promise }], { persistence: journal });
		await agent.submit({ commands: [start("graph:durable-active-run", 1)] });
		await journal.started.promise;

		const before = await agent.observe()[Symbol.asyncIterator]().next();
		if (before.value?.type !== "snapshot") throw new Error("Expected initial Coding Agent snapshot");
		expect(before.value.snapshot.graphs[0]?.items[0]).toMatchObject({ state: "preparing" });
		expect(before.value.snapshot.graphs[0]?.items[0]?.activeRun).toBeUndefined();

		journal.release.resolve();
		await waitForState(agent, "graph:durable-active-run", "root", "running");
		const after = await agent.observe()[Symbol.asyncIterator]().next();
		if (after.value?.type !== "snapshot") throw new Error("Expected committed Coding Agent snapshot");
		expect(after.value.snapshot.graphs[0]?.items[0]?.activeRun).toMatchObject({ source: "prompt" });

		model.resolve();
		await waitForGraphResult(agent, "graph:durable-active-run");
		await agent.close();
	});

	it("archives terminal Work Graphs outside active restore and default snapshots", async () => {
		const persistence = new MemoryWorkspacePersistence();
		const live = await harness([{}], { persistence });
		const settled = waitForGraphResult(live.agent, "graph:archived");
		await live.agent.submit({ commands: [start("graph:archived", 1)] });
		expect((await settled).durability).toBe("confirmed");
		expect(persistence.ledgerSnapshot().activeGraphs).toEqual([]);
		const liveSnapshot = await live.agent.observe()[Symbol.asyncIterator]().next();
		expect(liveSnapshot.value).toMatchObject({ type: "snapshot", snapshot: { graphs: [] } });
		await live.agent.close();

		const reopened = await harness([], { persistence });
		const restoredSnapshot = await reopened.agent.observe()[Symbol.asyncIterator]().next();
		expect(restoredSnapshot.value).toMatchObject({ type: "snapshot", snapshot: { graphs: [] } });
		expect(reopened.modelCalls).toEqual([]);
		await reopened.agent.close();

		const lease = await persistence.acquire();
		const historical = await lease.openHistoricalGraph("graph:archived" as WorkGraphId);
		expect((await historical?.load())?.records.at(-1)).toMatchObject({
			type: "graph_result",
			graphId: "graph:archived",
		});
		await historical?.close();
		await lease.close();
	});

	it("reconciles ordinal counters and Session owners from active Work Graph facts", async () => {
		const liveGate = deferred();
		const livePersistence = new MemoryWorkspacePersistence();
		const live = await harness([{ gate: liveGate.promise }, {}], {
			persistence: livePersistence,
			processMaximumConcurrency: 1,
		});
		await live.agent.submit({ commands: [start("graph:ordinal-recovery", 1)] });
		await live.agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:ordinal-recovery",
					items: [
						{
							itemId: "child",
							parentItemId: "root",
							objective: "recover child ownership",
							executionMode: "read_only",
						},
					],
				},
			],
		});
		expect(livePersistence.ledgerSnapshot()).toMatchObject({
			nextGraphOrder: 1,
			nextPublicationOrder: 2,
		});
		const acceptedFacts = livePersistence
			.graphRecords("graph:ordinal-recovery" as WorkGraphId)
			.filter((record) => record.type === "batch_accepted");
		expect(acceptedFacts).toHaveLength(2);

		const recoveredPersistence = new MemoryWorkspacePersistence({
			ledger: {
				activeGraphs: [{ graphId: "graph:ordinal-recovery" as WorkGraphId, order: 0 }],
				nextGraphOrder: 0,
				nextPublicationOrder: 0,
				sessionOwners: [],
				targetIdentities: [],
				diagnostics: [],
			},
			graphs: new Map([["graph:ordinal-recovery" as WorkGraphId, acceptedFacts]]),
		});
		const recoveredRoot = deferred();
		const recoveredChild = deferred();
		const newRoot = deferred();
		const recovered = await harness(
			[{ gate: recoveredRoot.promise }, { gate: recoveredChild.promise }, { gate: newRoot.promise }],
			{ persistence: recoveredPersistence, processMaximumConcurrency: 1 },
		);
		expect(recoveredPersistence.ledgerSnapshot().sessionOwners).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ graphId: "graph:ordinal-recovery", itemId: "root" }),
				expect.objectContaining({ graphId: "graph:ordinal-recovery", itemId: "child" }),
			]),
		);
		await expect(recovered.agent.submit({ commands: [start("graph:after-recovery", 1)] })).resolves.toMatchObject({
			status: "accepted",
		});
		const newAcceptance = recoveredPersistence
			.graphRecords("graph:after-recovery" as WorkGraphId)
			.find((record) => record.type === "batch_accepted");
		expect(newAcceptance).toMatchObject({
			payload: {
				graphs: [{ graphId: "graph:after-recovery", order: 1 }],
				items: [{ graphId: "graph:after-recovery", publicationOrder: 2 }],
			},
		});
		await expect(
			recovered.agent.submit({
				commands: [
					{
						...start("graph:owner-conflict", 1),
						session: { type: "resume", sessionId: "session:graph:ordinal-recovery" },
					},
				],
			}),
		).resolves.toMatchObject({ status: "rejected", rejection: { code: "session_leased" } });
		expect(recoveredPersistence.ledgerSnapshot()).toMatchObject({
			nextGraphOrder: 2,
			nextPublicationOrder: 3,
		});

		const recoveredOldResult = waitForGraphResult(recovered.agent, "graph:ordinal-recovery");
		const recoveredNewResult = waitForGraphResult(recovered.agent, "graph:after-recovery");
		recoveredRoot.resolve();
		recoveredChild.resolve();
		newRoot.resolve();
		await Promise.all([recoveredOldResult, recoveredNewResult]);
		await recovered.agent.close();

		const liveResult = waitForGraphResult(live.agent, "graph:ordinal-recovery");
		liveGate.resolve();
		await liveResult;
		await live.agent.close();
	});

	it("recovers Worker Fact counters, exhaustion, and every unclosed effect window", async () => {
		const gate = deferred();
		const liveJournal = new MemoryWorkspacePersistence();
		const live = await harness([{ gate: gate.promise }], { persistence: liveJournal });
		await live.agent.submit({ commands: [start("graph:fact-recovery", 1)] });
		await vi.waitFor(() =>
			expect(
				liveJournal.records.some(
					(record) => record.type === "worker_fact" && record.fact.type === "attempt_started",
				),
			).toBe(true),
		);

		const firstAttemptIndex = liveJournal.records.findIndex(
			(record) => record.type === "worker_fact" && record.fact.type === "attempt_started",
		);
		const recoveryRecords = structuredClone(liveJournal.records.slice(0, firstAttemptIndex + 1));
		const firstAttempt = recoveryRecords.at(-1);
		if (firstAttempt?.type !== "worker_fact" || firstAttempt.fact.type !== "attempt_started") {
			throw new Error("The live journal did not reach attempt_started");
		}
		const recordIdentity = {
			graphId: firstAttempt.graphId,
			itemId: firstAttempt.itemId,
			runtimeId: firstAttempt.runtimeId,
			sessionId: firstAttempt.sessionId,
		};
		recoveryRecords.push(
			{
				type: "worker_fact",
				...recordIdentity,
				fact: {
					type: "attempt_settled",
					runId: firstAttempt.fact.runId,
					turnId: firstAttempt.fact.turnId,
					attemptId: firstAttempt.fact.attemptId,
					messageId: firstAttempt.fact.messageId,
					attempt: firstAttempt.fact.attempt,
					outcome: "success",
					discarded: false,
					totalTokens: 37,
					timestamp: 2_000,
				},
			},
			{
				type: "worker_fact",
				...recordIdentity,
				fact: {
					type: "attempt_started",
					runId: firstAttempt.fact.runId,
					turnId: "turn:recovered-open",
					attemptId: "attempt:recovered-open",
					messageId: "message:recovered-open",
					attempt: 2,
					timestamp: 2_001,
				},
			},
			{
				type: "worker_fact",
				...recordIdentity,
				fact: {
					type: "tool_started",
					runId: firstAttempt.fact.runId,
					turnId: "turn:recovered-open",
					invocationId: "tool:recovered-open",
					toolName: "recovery_probe",
					replaySafety: "never",
					timestamp: 2_002,
				},
			},
			{
				type: "worker_fact",
				...recordIdentity,
				fact: {
					type: "budget_exhausted",
					runId: firstAttempt.fact.runId,
					exhaustion: { limit: "model_attempts", maximum: 2, observed: 2 },
					timestamp: 2_003,
				},
			},
		);

		const recoveredJournal = new MemoryWorkspacePersistence(recoveryRecords);
		const recovered = await harness([], { persistence: recoveredJournal });
		const result = await waitForPersistedGraphResult(recoveredJournal, "graph:fact-recovery");
		expect(recovered.modelCalls).toEqual([]);
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			budget: {
				modelAttempts: 2,
				toolInvocations: 1,
				totalTokens: 37,
				exhaustion: { limit: "model_attempts", maximum: 2, observed: 2 },
			},
			diagnostics: [
				{
					code: "recovered_interruption",
					message: expect.stringContaining("unclosed_model_attempt"),
				},
			],
		});
		expect(result.results[0]?.diagnostics[0]?.message).toContain("unclosed_tool_invocation");
		expect(recoveredJournal.records.find((record) => record.type === "recovery_interrupted")).toMatchObject({
			reasons: expect.arrayContaining(["unclosed_model_attempt", "unclosed_tool_invocation"]),
		});
		await recovered.agent.close();

		gate.resolve();
		await waitForGraphResult(live.agent, "graph:fact-recovery");
		await live.agent.close();

		const authoritativeRecords = liveJournal.records
			.filter((record) => record.type !== "graph_result")
			.map((record): WorkGraphRecord => {
				if (record.type !== "item_result") return structuredClone(record);
				const payload = record.payload as unknown as WorkResult;
				return {
					...record,
					payload: {
						...payload,
						budget: {
							modelAttempts: 91,
							toolInvocations: 82,
							totalTokens: 73,
							elapsedMs: 64,
							exhaustion: { limit: "total_tokens", maximum: 72, observed: 73 },
						},
					} as unknown as JsonValue,
				};
			});
		const authoritativePersistence = new MemoryWorkspacePersistence(authoritativeRecords);
		const authoritative = await harness([], { persistence: authoritativePersistence });
		const authoritativeResult = await waitForPersistedGraphResult(authoritativePersistence, "graph:fact-recovery");
		expect(authoritativeResult.results[0]?.budget).toEqual({
			modelAttempts: 91,
			toolInvocations: 82,
			totalTokens: 73,
			elapsedMs: 64,
			exhaustion: { limit: "total_tokens", maximum: 72, observed: 73 },
		});
		await authoritative.agent.close();
	});

	it("restores uncertain work as interrupted and never automatically replays it", async () => {
		const gate = deferred();
		const liveJournal = new MemoryWorkspacePersistence();
		const live = await harness([{ gate: gate.promise }, {}], { persistence: liveJournal });
		await live.agent.submit({ commands: [start("graph:recovery", 1)] });
		await live.agent.submit({
			commands: [
				{
					type: "add_work_items",
					graphId: "graph:recovery",
					items: [
						{
							itemId: "never-started",
							parentItemId: "root",
							objective: "must not replay",
							executionMode: "write",
						},
					],
				},
			],
		});
		await waitForState(live.agent, "graph:recovery", "root", "running");
		const acceptance = liveJournal.records.find((record) => record.type === "batch_accepted");
		expect(acceptance).toMatchObject({
			payload: {
				schemaVersion: 1,
				items: [
					{
						runtimeId: expect.stringContaining("worker:graph:recovery:root"),
						sessionId: "session:graph:recovery",
						placement: { placementId: "placement:graph:recovery:root" },
					},
				],
			},
		});
		const interruptedRecords: WorkGraphRecord[] = structuredClone([...liveJournal.records]);
		interruptedRecords.push({
			type: "publication",
			graphId: "graph:recovery" as WorkGraphId,
			itemId: "root" as WorkItemId,
			timestamp: 2_000,
			payload: {
				phase: "started",
				artifact: {
					artifactId: "artifact:recovery",
					placementId: "placement:graph:recovery:root",
					baseIdentity: "base:root",
					kind: "memory",
				},
			},
		});
		const recoveredJournal = new MemoryWorkspacePersistence(interruptedRecords);
		const recovered = await harness([], { persistence: recoveredJournal });
		const result = await waitForGraphResult(recovered.agent, "graph:recovery");
		expect(recovered.modelCalls).toEqual([]);
		expect(result.outcome).toBe("interrupted");
		expect(result.results[0]).toMatchObject({
			state: "interrupted",
			artifact: { artifactId: "artifact:recovery" },
			publication: { state: "not_published", reason: "interrupted" },
			diagnostics: [
				{
					code: "recovered_interruption",
					message: expect.stringContaining("unclosed_publication"),
				},
			],
		});
		expect(result.results[1]).toMatchObject({ itemId: "never-started", state: "blocked" });
		expect(recovered.workspace.recovered).toEqual([
			expect.objectContaining({
				itemId: "never-started",
				expectedTargetIdentity: "target:placement:graph:recovery:root:accepted",
			}),
		]);
		expect(recoveredJournal.records.some((record) => record.type === "recovery_interrupted")).toBe(true);
		expect(recoveredJournal.records.at(-1)?.type).toBe("graph_result");
		await recovered.agent.close();

		gate.resolve();
		await waitForGraphResult(live.agent, "graph:recovery");
		await live.agent.close();
	});
});
