import {
	type AgentEvent,
	type AgentInput,
	type AgentSeed,
	type AgentState,
	BoundedObservationQueue,
	type Clock,
	type IdGenerator,
	type RunSummary,
} from "@coda/agent";
import type { Api, AuthResult, Model, ThinkingLevel } from "@coda/ai";
import type {
	CodingAgent,
	CodingAgentObservation,
	CodingAgentReceipt,
	CodingAgentSnapshot,
	DesiredRuntimeConfiguration,
	OpenCodingAgentOptions,
	RunCapabilitySelections,
	WorkCapacityPolicy,
	WorkGraphId,
	WorkItemId,
	WorkItemState,
	WorkResult,
	WorkspacePlacementDescriptor,
} from "@coda/runtime";
import { waitForGraph } from "@coda/runtime/headless";
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

export interface DelegatedWorkItemProjection {
	readonly itemId: WorkItemId | string;
	readonly objective?: string;
	readonly executionMode?: "read_only" | "write";
	readonly state: WorkItemState;
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
	readonly snapshot?: CodingAgentSnapshot;
}

export interface SessionWorkObserver {
	accept(event: AgentEvent): Promise<void> | void;
	acceptObservation?(observation: CodingAgentObservation): Promise<void> | void;
	resynchronize(snapshot: SessionWorkResynchronization): Promise<void> | void;
}

export interface SessionWorkObservationOptions {
	readonly capacity?: number;
}

export type SessionWorkerControlEvent = Parameters<
	NonNullable<OpenCodingAgentOptions["workerControl"]>["accept"]
>[0]["event"];

type ControlListener = (event: SessionWorkerControlEvent) => Promise<void> | void;
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
	| { readonly type: "observation"; readonly observation: CodingAgentObservation }
	| { readonly type: "resync"; readonly snapshot: SessionWorkResynchronization };

interface ObservationSubscriber {
	readonly queue: BoundedObservationQueue<ObservationDelivery>;
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
	#lastSnapshot?: CodingAgentSnapshot;
	readonly #delegated = new Map<string, DelegatedWorkItemProjection>();

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

	async prompt(
		input: AgentInput,
		resources: readonly string[] = [],
		capabilitySelections?: RunCapabilitySelections,
	): Promise<WorkResult> {
		return (await this.beginPrompt(input, resources, capabilitySelections)).result;
	}

	async beginPrompt(
		input: AgentInput,
		resources: readonly string[] = [],
		capabilitySelections?: RunCapabilitySelections,
	): Promise<BegunSessionWork> {
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
					...(capabilitySelections ? { capabilitySelections } : {}),
				},
			],
		});
		if (receipt.status === "rejected") {
			this.#activeGraphId = undefined;
			this.#activeItemId = undefined;
			this.#activeRuntimeId = undefined;
			throw rejected(receipt);
		}
		const operation = waitForGraph(this.#host.agent, graphId, { capacity: 4_096 })
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
					this.#delegated.clear();
				}
			});
		this.#operation = operation;
		return Object.freeze({ result: operation });
	}

	async deliver(
		kind: "steering" | "follow_up",
		input: AgentInput,
		resources: readonly string[] = [],
		capabilitySelections?: RunCapabilitySelections,
	): Promise<void> {
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
					...(capabilitySelections ? { capabilitySelections } : {}),
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
		await this.#cancel({ type: "graph", graphId: this.#activeGraphId });
	}

	async cancelItem(itemId: WorkItemId | string): Promise<void> {
		this.#assertOpen();
		if (!this.#activeGraphId) return;
		await this.#cancel({ type: "item", graphId: this.#activeGraphId, itemId });
	}

	delegatedWorkItems(): readonly DelegatedWorkItemProjection[] {
		return Object.freeze([...this.#delegated.values()].map((item) => Object.freeze({ ...item })));
	}

	async #cancel(
		target:
			| { readonly type: "graph"; readonly graphId: WorkGraphId }
			| { readonly type: "item"; readonly graphId: WorkGraphId; readonly itemId: WorkItemId | string },
	): Promise<void> {
		const receipt = await this.#host.agent.submit({
			commands: [
				target.type === "graph"
					? { type: "cancel_work", target: { type: "graph", graphId: target.graphId } }
					: { type: "cancel_work", target: { type: "item", graphId: target.graphId, itemId: target.itemId } },
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
		let subscriber: ObservationSubscriber;
		const queue = new BoundedObservationQueue<ObservationDelivery>({
			capacity,
			capacityName: "Session Work Observation",
			deliver: (delivery) => {
				if (delivery.type === "event") return observer.accept(delivery.event);
				if (delivery.type === "observation") return observer.acceptObservation?.(delivery.observation);
				return observer.resynchronize(delivery.snapshot);
			},
			onDeliveryError: () => this.#removeObservationSubscriber(subscriber),
		});
		subscriber = { queue };
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

	acceptObservation(observation: CodingAgentObservation): void {
		if (this.#closed) return;
		if (observation.type === "snapshot") {
			this.#lastSnapshot = observation.snapshot;
			this.#delegated.clear();
			for (const graph of observation.snapshot.graphs) {
				if (this.#activeGraphId && graph.graphId !== this.#activeGraphId) continue;
				for (const item of graph.items) {
					if (item.parentItemId === undefined) continue;
					this.#delegated.set(String(item.itemId), {
						itemId: item.itemId,
						objective: item.objective,
						executionMode: item.executionMode,
						state: item.state,
					});
				}
			}
		} else if (observation.type === "item_state_changed" && !this.#isRootItem(observation.itemId)) {
			const current = this.#delegated.get(String(observation.itemId));
			this.#delegated.set(String(observation.itemId), {
				itemId: observation.itemId,
				...(current?.objective ? { objective: current.objective } : {}),
				...(current?.executionMode ? { executionMode: current.executionMode } : {}),
				state: observation.to,
			});
		} else if (observation.type === "work_item_settled" && !this.#isRootItem(observation.result.itemId)) {
			this.#delegated.set(String(observation.result.itemId), {
				itemId: observation.result.itemId,
				state: observation.result.state,
			});
		}
		for (const subscriber of this.#observationSubscribers) {
			this.#enqueueObservation(subscriber, { type: "observation", observation });
		}
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

	acceptWorkerControlEvent(event: SessionWorkerControlEvent): Promise<void> {
		if (this.#closed) return Promise.resolve();
		return this.#notifyControl(event);
	}

	resynchronize(snapshot: CodingAgentSnapshot): void {
		if (this.#closed) return;
		this.#lastSnapshot = snapshot;
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
			subscriber.queue.replace({
				type: "resync",
				snapshot: this.#resynchronization("upstream_resync"),
			});
		}
	}

	async #notifyControl(event: SessionWorkerControlEvent): Promise<void> {
		for (const listener of [...this.#controlListeners]) {
			try {
				await listener(event);
			} catch {
				this.#controlListeners.delete(listener);
			}
		}
	}

	#enqueueObservation(subscriber: ObservationSubscriber, delivery: ObservationDelivery): void {
		if (!subscriber.queue.enqueue(delivery)) {
			subscriber.queue.replace({
				type: "resync",
				snapshot: this.#resynchronization("slow_consumer"),
			});
		}
	}

	#resynchronization(reason: SessionWorkResynchronization["reason"]): SessionWorkResynchronization {
		return Object.freeze({
			type: "resync_required",
			reason,
			state: this.state(),
			seed: structuredClone(this.#session.seed),
			toolInvocations: Object.freeze(structuredClone(this.#session.toolInvocations)),
			...(this.#lastSnapshot ? { snapshot: structuredClone(this.#lastSnapshot) } : {}),
		});
	}

	#removeObservationSubscriber(subscriber: ObservationSubscriber): void {
		if (subscriber.queue.closed) return;
		subscriber.queue.close();
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

	#isRootItem(itemId: WorkItemId | string): boolean {
		return itemId === this.#activeItemId || String(itemId) === "root";
	}
}
