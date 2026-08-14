import type { AgentEvent, AgentInput, AgentSeed, AgentState, Clock, IdGenerator, RunSummary } from "@coda/agent";
import type { Api, AuthResult, Model, ThinkingLevel } from "@coda/ai";
import type {
	CodingAgent,
	CodingAgentReceipt,
	CodingAgentSnapshot,
	DesiredRuntimeConfiguration,
	WorkCapacityPolicy,
	WorkerControlEvent,
	WorkGraphId,
	WorkGraphResult,
	WorkItemId,
	WorkResult,
	WorkspacePlacementDescriptor,
} from "@coda/runtime";
import type { Session, SessionToolLifecycle } from "../session/types.ts";

export interface SessionWorkSelection {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot?: AuthResult;
}

export interface PreparedWorkRunMetadata {
	readonly model: { readonly provider: string; readonly id: string };
	readonly reasoning: ThinkingLevel | "off";
	readonly prompt: { readonly version: string; readonly sha256: string };
}

export interface BegunSessionWork {
	readonly result: Promise<WorkResult>;
}

export interface SessionWorkState {
	readonly closed: boolean;
	readonly status: AgentState["status"];
	readonly activeGraphId?: WorkGraphId;
	readonly activeItemId?: WorkItemId;
	readonly activePlacement?: WorkspacePlacementDescriptor;
	readonly activeRun?: AgentState["activeRun"];
	readonly messages: AgentState["messages"];
	readonly pendingSteering: AgentState["pendingSteering"];
	readonly pendingFollowUps: AgentState["pendingFollowUps"];
	readonly lastRun?: RunSummary;
	readonly selection: Omit<SessionWorkSelection, "authSnapshot">;
}

export interface SessionWorkHost {
	readonly agent: CodingAgent;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly capacity: WorkCapacityPolicy;
	registerSelection(selection: SessionWorkSelection): void;
	release(controller: SessionWorkController): Promise<void>;
}

export interface SessionWorkResynchronization {
	readonly type: "resync_required";
	readonly reason: "slow_consumer" | "upstream_resync";
	readonly state: SessionWorkState;
	readonly seed: AgentSeed;
	readonly toolInvocations: readonly SessionToolLifecycle[];
}

export interface SessionWorkObserver {
	accept(event: AgentEvent): Promise<void> | void;
	resynchronize(snapshot: SessionWorkResynchronization): Promise<void> | void;
}

export interface SessionWorkObservationOptions {
	readonly capacity?: number;
}

type ControlListener = (event: WorkerControlEvent) => Promise<void> | void;
type WorkResultListener = (result: WorkResult) => Promise<void> | void;

export interface WorkerObservationIdentity {
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
	readonly runtimeId: string;
}

const TERMINAL_WORK_STATES: ReadonlySet<string> = new Set([
	"succeeded",
	"failed",
	"canceled",
	"interrupted",
	"blocked",
]);

type ObservationDelivery =
	| { readonly type: "event"; readonly event: AgentEvent }
	| { readonly type: "resync"; readonly snapshot: SessionWorkResynchronization };

interface ObservationSubscriber {
	readonly observer: SessionWorkObserver;
	readonly capacity: number;
	readonly queue: ObservationDelivery[];
	running: boolean;
	closed: boolean;
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 192);
	if (!safe) throw new Error("Could not allocate Work Graph identity");
	return safe;
}

function objectiveFor(input: AgentInput): string {
	const text =
		typeof input === "string"
			? input
			: input
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	const normalized = text.trim();
	return normalized || "Complete the attached user request.";
}

function rejected(receipt: Extract<CodingAgentReceipt, { status: "rejected" }>): Error {
	return new Error(`${receipt.rejection.code}: ${receipt.rejection.message}`);
}

async function waitForGraph(agent: CodingAgent, graphId: WorkGraphId): Promise<WorkGraphResult> {
	for (;;) {
		let resynchronize = false;
		for await (const observation of agent.observe({ capacity: 4_096 })) {
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
			if (observation.type === "closed") {
				throw new Error(`Coding Agent closed before Work Graph ${graphId} settled`);
			}
		}
		if (!resynchronize) throw new Error(`Coding Agent closed before Work Graph ${graphId} settled`);
	}
}

/**
 * Application-side projection for one durable Session.
 *
 * It owns no Agent, Prepared Run, input queue, or Context Window capability. All
 * execution crosses the public Work Graph command/observation seam.
 */
export class SessionWorkController {
	readonly #host: SessionWorkHost;
	readonly #session: Session;
	readonly #observationSubscribers = new Set<ObservationSubscriber>();
	readonly #controlListeners = new Set<ControlListener>();
	readonly #resultListeners = new Set<WorkResultListener>();
	readonly #runMetadata = new Map<string, PreparedWorkRunMetadata>();
	#selection: SessionWorkSelection;
	#status: AgentState["status"] = "idle";
	#activeGraphId?: WorkGraphId;
	#activeItemId?: WorkItemId;
	#activeRuntimeId?: string;
	#activePlacement?: WorkspacePlacementDescriptor;
	#activeRun?: AgentState["activeRun"];
	#lastRun?: RunSummary;
	#pendingPreparation?: PreparedWorkRunMetadata["prompt"];
	#operation?: Promise<WorkResult>;
	#closed = false;
	#closeOperation?: Promise<void>;

	constructor(options: {
		readonly host: SessionWorkHost;
		readonly session: Session;
		readonly selection: SessionWorkSelection;
	}) {
		this.#host = options.host;
		this.#session = options.session;
		this.#selection = Object.freeze({ ...options.selection });
		this.#host.registerSelection(this.#selection);
	}

	get session(): Session {
		return this.#session;
	}

	get sessionId(): string {
		return this.#session.descriptor.id;
	}

	state(): SessionWorkState {
		const seed = this.#session.seed;
		return Object.freeze({
			closed: this.#closed,
			status: this.#status,
			...(this.#activeGraphId ? { activeGraphId: this.#activeGraphId } : {}),
			...(this.#activeItemId ? { activeItemId: this.#activeItemId } : {}),
			...(this.#activePlacement ? { activePlacement: structuredClone(this.#activePlacement) } : {}),
			...(this.#activeRun ? { activeRun: structuredClone(this.#activeRun) } : {}),
			messages: seed.messages,
			pendingSteering: Object.freeze([]),
			pendingFollowUps: seed.pendingFollowUps,
			...(this.#lastRun ? { lastRun: structuredClone(this.#lastRun) } : {}),
			selection: Object.freeze({ model: this.#selection.model, reasoning: this.#selection.reasoning }),
		});
	}

	isBusy(): boolean {
		return this.#activeGraphId !== undefined || this.#status !== "idle";
	}

	async prompt(input: AgentInput, resources: readonly string[] = []): Promise<WorkResult> {
		return (await this.beginPrompt(input, resources)).result;
	}

	async beginPrompt(input: AgentInput, resources: readonly string[] = []): Promise<BegunSessionWork> {
		this.#assertOpen();
		if (this.#activeGraphId || this.#operation) throw new Error("This Session already owns active Work");
		const token = safeIdentity(this.#host.idGenerator.generate("queue_item"));
		const graphId = `graph:${safeIdentity(this.sessionId)}:${token}` as WorkGraphId;
		const itemId = "root" as WorkItemId;
		this.#activeGraphId = graphId;
		this.#activeItemId = itemId;
		this.#activeRuntimeId = undefined;
		const receipt = await this.#host.agent.submit({
			batchId: `batch:${token}`,
			commands: [
				{
					type: "start_work_graph",
					graphId,
					objective: objectiveFor(input),
					root: { itemId, executionMode: "write" },
					maximumConcurrency: this.#host.capacity.graphMaximumConcurrency,
					configuration: this.#configuration(),
					session: { type: "resume", sessionId: this.sessionId },
				},
				{
					type: "deliver_work_item_input",
					graphId,
					itemId,
					kind: "prompt",
					input,
					...(resources.length > 0 ? { resources: Object.freeze([...resources]) } : {}),
				},
			],
		});
		if (receipt.status === "rejected") {
			this.#activeGraphId = undefined;
			this.#activeItemId = undefined;
			this.#activeRuntimeId = undefined;
			throw rejected(receipt);
		}
		const operation = waitForGraph(this.#host.agent, graphId)
			.then((result) => {
				const root = result.results.find((candidate) => candidate.itemId === itemId);
				if (!root) throw new Error(`Work Graph ${graphId} has no root Work Result`);
				this.#notifyResult(root);
				return root;
			})
			.finally(() => {
				if (this.#operation === operation) this.#operation = undefined;
				if (this.#activeGraphId === graphId) {
					this.#activeGraphId = undefined;
					this.#activeItemId = undefined;
					this.#activeRuntimeId = undefined;
					this.#activePlacement = undefined;
					this.#activeRun = undefined;
					this.#status = "idle";
				}
			});
		this.#operation = operation;
		return Object.freeze({ result: operation });
	}

	async deliver(kind: "steering" | "follow_up", input: AgentInput, resources: readonly string[] = []): Promise<void> {
		this.#assertOpen();
		const graphId = this.#activeGraphId;
		const itemId = this.#activeItemId;
		if (!graphId || !itemId) throw new Error(`Cannot deliver ${kind.replace("_", "-")} without active Work`);
		const receipt = await this.#host.agent.submit({
			commands: [
				{
					type: "deliver_work_item_input",
					graphId,
					itemId,
					kind,
					input,
					...(resources.length > 0 ? { resources: Object.freeze([...resources]) } : {}),
				},
			],
		});
		if (receipt.status === "rejected") throw rejected(receipt);
	}

	async select(selection: SessionWorkSelection): Promise<void> {
		this.#assertOpen();
		const previous = this.#selection;
		this.#selection = Object.freeze({ ...selection });
		this.#host.registerSelection(this.#selection);
		if (!this.#activeGraphId || !this.#activeItemId) return;
		const receipt = await this.#host.agent.submit({
			commands: [
				{
					type: "configure_work_item",
					graphId: this.#activeGraphId,
					itemId: this.#activeItemId,
					configuration: this.#configuration(),
				},
			],
		});
		if (receipt.status === "rejected") {
			this.#selection = previous;
			throw rejected(receipt);
		}
	}

	selectReasoning(reasoning: ThinkingLevel | "off"): Promise<void> {
		return this.select({ ...this.#selection, reasoning });
	}

	async cancel(): Promise<void> {
		this.#assertOpen();
		if (!this.#activeGraphId) return;
		const receipt = await this.#host.agent.submit({
			commands: [
				{
					type: "cancel_work",
					target: { type: "graph", graphId: this.#activeGraphId },
				},
			],
		});
		if (receipt.status === "rejected" && receipt.rejection.code !== "invalid_state") throw rejected(receipt);
	}

	waitForIdle(): Promise<void> {
		return (
			this.#operation?.then(
				() => undefined,
				() => undefined,
			) ?? Promise.resolve()
		);
	}

	subscribe(observer: SessionWorkObserver, options: SessionWorkObservationOptions = {}): () => void {
		this.#assertOpen();
		const capacity = options.capacity ?? 256;
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new Error("Session Work Observation capacity must be a positive safe integer");
		}
		const subscriber: ObservationSubscriber = {
			observer,
			capacity,
			queue: [],
			running: false,
			closed: false,
		};
		this.#observationSubscribers.add(subscriber);
		return () => this.#removeObservationSubscriber(subscriber);
	}

	subscribeControl(listener: ControlListener): () => void {
		this.#assertOpen();
		this.#controlListeners.add(listener);
		return () => this.#controlListeners.delete(listener);
	}

	subscribeResult(listener: WorkResultListener): () => void {
		this.#assertOpen();
		this.#resultListeners.add(listener);
		return () => this.#resultListeners.delete(listener);
	}

	metadataForRun(runId: string): PreparedWorkRunMetadata | undefined {
		const value = this.#runMetadata.get(runId);
		return value ? structuredClone(value) : undefined;
	}

	notePreparation(prompt: PreparedWorkRunMetadata["prompt"]): void {
		this.#pendingPreparation = structuredClone(prompt);
	}

	notePlacement(placement: WorkspacePlacementDescriptor): void {
		if (!this.#activeGraphId || !this.#activeItemId) return;
		this.#activePlacement = structuredClone(placement);
	}

	acceptWorkerEvent(event: AgentEvent, identity: WorkerObservationIdentity): void {
		if (
			this.#closed ||
			this.#activeGraphId !== identity.graphId ||
			this.#activeItemId !== identity.itemId ||
			(this.#activeRuntimeId !== undefined && this.#activeRuntimeId !== identity.runtimeId)
		) {
			return;
		}
		this.#activeRuntimeId = identity.runtimeId;
		switch (event.type) {
			case "run_start": {
				this.#status = "running";
				this.#activeRun = Object.freeze({
					id: event.runId,
					source: event.source,
					...(event.queueItemId ? { queueItemId: event.queueItemId } : {}),
					...(event.budget ? { budget: event.budget } : {}),
				});
				if (this.#pendingPreparation) {
					this.#runMetadata.set(
						String(event.runId),
						Object.freeze({
							model: { provider: this.#selection.model.provider, id: this.#selection.model.id },
							reasoning: this.#selection.reasoning,
							prompt: this.#pendingPreparation,
						}),
					);
					this.#pendingPreparation = undefined;
				}
				break;
			}
			case "run_budget_exhausted":
				if (this.#activeRun)
					this.#activeRun = Object.freeze({ ...this.#activeRun, budgetExhaustion: event.exhaustion });
				break;
			case "run_end":
				this.#status = "settling";
				this.#lastRun = Object.freeze({
					id: event.runId,
					outcome: event.outcome,
					...(event.failure ? { failure: event.failure } : {}),
				});
				break;
		}
		for (const subscriber of this.#observationSubscribers) {
			this.#enqueueObservation(subscriber, { type: "event", event });
		}
	}

	acceptWorkerControlEvent(event: WorkerControlEvent): Promise<void> {
		if (this.#closed) return Promise.resolve();
		return this.#notifyControl(event);
	}

	resynchronize(snapshot: CodingAgentSnapshot): void {
		if (this.#closed) return;
		const active = snapshot.graphs
			.flatMap((graph) => graph.items.map((item) => ({ graph, item })))
			.find(({ item }) => item.sessionId === this.sessionId && !TERMINAL_WORK_STATES.has(item.state));
		if (active) {
			this.#activeGraphId = active.graph.graphId;
			this.#activeItemId = active.item.itemId;
			this.#activeRuntimeId = active.item.runtimeId;
			this.#activePlacement = structuredClone(active.item.placement);
			this.#status =
				active.item.state === "settling" ? "settling" : active.item.state === "running" ? "running" : "idle";
			this.#activeRun = active.item.activeRun ? Object.freeze(structuredClone(active.item.activeRun)) : undefined;
		} else if (this.#activeGraphId) {
			const graph = snapshot.graphs.find(({ graphId }) => graphId === this.#activeGraphId);
			if (graph?.result) {
				this.#activeGraphId = undefined;
				this.#activeItemId = undefined;
				this.#activeRuntimeId = undefined;
				this.#activePlacement = undefined;
				this.#activeRun = undefined;
				this.#status = "idle";
			}
		}
		for (const subscriber of this.#observationSubscribers) {
			subscriber.queue.splice(0);
			this.#enqueueObservation(subscriber, {
				type: "resync",
				snapshot: this.#resynchronization("upstream_resync"),
			});
		}
	}

	async #notifyControl(event: WorkerControlEvent): Promise<void> {
		for (const listener of [...this.#controlListeners]) {
			try {
				await listener(event);
			} catch {
				this.#controlListeners.delete(listener);
			}
		}
	}

	#enqueueObservation(subscriber: ObservationSubscriber, delivery: ObservationDelivery): void {
		if (subscriber.closed) return;
		if (subscriber.queue.length >= subscriber.capacity) {
			subscriber.queue.splice(0);
			subscriber.queue.push({
				type: "resync",
				snapshot: this.#resynchronization("slow_consumer"),
			});
		} else {
			subscriber.queue.push(delivery);
		}
		if (subscriber.running) return;
		subscriber.running = true;
		queueMicrotask(() => void this.#drainObservationSubscriber(subscriber));
	}

	async #drainObservationSubscriber(subscriber: ObservationSubscriber): Promise<void> {
		try {
			while (!subscriber.closed) {
				const delivery = subscriber.queue.shift();
				if (!delivery) return;
				if (delivery.type === "event") await subscriber.observer.accept(delivery.event);
				else await subscriber.observer.resynchronize(delivery.snapshot);
			}
		} catch {
			this.#removeObservationSubscriber(subscriber);
		} finally {
			subscriber.running = false;
			if (!subscriber.closed && subscriber.queue.length > 0) {
				subscriber.running = true;
				queueMicrotask(() => void this.#drainObservationSubscriber(subscriber));
			}
		}
	}

	#resynchronization(reason: SessionWorkResynchronization["reason"]): SessionWorkResynchronization {
		return Object.freeze({
			type: "resync_required",
			reason,
			state: this.state(),
			seed: structuredClone(this.#session.seed),
			toolInvocations: Object.freeze(structuredClone(this.#session.toolInvocations)),
		});
	}

	#removeObservationSubscriber(subscriber: ObservationSubscriber): void {
		if (subscriber.closed) return;
		subscriber.closed = true;
		subscriber.queue.splice(0);
		this.#observationSubscribers.delete(subscriber);
	}

	#notifyResult(result: WorkResult): void {
		for (const listener of [...this.#resultListeners]) {
			try {
				void Promise.resolve(listener(result)).catch(() => this.#resultListeners.delete(listener));
			} catch {
				this.#resultListeners.delete(listener);
			}
		}
	}

	close(): Promise<void> {
		if (this.#closeOperation) return this.#closeOperation;
		this.#closed = true;
		this.#closeOperation = (async () => {
			if (this.#activeGraphId) {
				this.#closed = false;
				try {
					await this.cancel();
				} finally {
					this.#closed = true;
				}
			}
			await this.waitForIdle();
			for (const subscriber of [...this.#observationSubscribers]) {
				this.#removeObservationSubscriber(subscriber);
			}
			this.#controlListeners.clear();
			this.#resultListeners.clear();
			await this.#host.release(this);
		})();
		return this.#closeOperation;
	}

	#configuration(): DesiredRuntimeConfiguration {
		return Object.freeze({
			model: { provider: this.#selection.model.provider, id: this.#selection.model.id },
			reasoning: this.#selection.reasoning,
		});
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error(`Session Work Controller ${this.sessionId} is closed`);
	}
}
