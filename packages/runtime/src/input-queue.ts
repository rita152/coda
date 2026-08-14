import type { AgentEvent, AgentInput, AgentState, QueueItemId, RunResult } from "@coda/agent";
import type { RuntimeCommand, RuntimeCommandResult } from "./types.ts";

const MAXIMUM_PENDING_FOLLOW_UPS = 32;
const MAXIMUM_FOLLOW_UP_TEXT_BYTES = 1_048_576;

export interface RuntimeResourceTransaction {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface RuntimeQueueItemLifecycle {
	accepted?(id: QueueItemId): Promise<void>;
	rollback?(id: QueueItemId): Promise<void>;
}

export type RuntimeFollowUpChange =
	| { readonly type: "follow_up_enqueued"; readonly item: AgentState["pendingFollowUps"][number] }
	| { readonly type: "follow_up_consumed" | "follow_up_canceled" | "follow_up_reclaimed"; readonly id: QueueItemId };

export interface RuntimeInputQueueJournal {
	record(change: RuntimeFollowUpChange): Promise<void>;
}

export interface RuntimeInputPort {
	snapshot(): { readonly agent: AgentState };
	prompt(input: AgentInput): Promise<RunResult>;
	steer(input: AgentInput): QueueItemId;
	followUp(input: AgentInput): QueueItemId;
	cancel(queueItemId?: QueueItemId): void;
	dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult>;
	subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void;
}

export interface RuntimeInputLifecycle {
	readonly queuePaused: boolean;
	readonly shouldDeferPrompt: boolean;
	readonly pendingExternalCount: number;
	startPrompt(input: AgentInput, transaction: RuntimeResourceTransaction): Promise<RunResult>;
	steer(input: AgentInput, transaction: RuntimeResourceTransaction): QueueItemId;
	enqueueFollowUp(
		input: AgentInput,
		transaction: RuntimeResourceTransaction,
		lifecycle?: RuntimeQueueItemLifecycle,
	): Promise<QueueItemId>;
	enqueueExternal(id: string, run: () => Promise<void>): void;
	reclaimExternal(id: string): void;
	resume(): void;
	reclaimFollowUp(id: QueueItemId): Promise<void>;
	discardPendingFollowUps(): Promise<readonly QueueItemId[]>;
	abort(): void;
	acknowledgeRuntimeFailure(): void;
	waitForIdle(): Promise<void>;
}

interface PendingResource {
	readonly transaction: RuntimeResourceTransaction;
}

type DeferredWork =
	| { readonly kind: "follow_up"; readonly id: QueueItemId }
	| { readonly kind: "external"; readonly id: string; readonly run: () => Promise<void> };

/**
 * Owns the non-UI lifecycle around Prompt resources, Steering resources, durable
 * Follow-ups, and serial deferred work. Adapters only translate user actions.
 */
export class RuntimeInputQueue implements RuntimeInputLifecycle {
	readonly #runtime: RuntimeInputPort;
	readonly #journal: RuntimeInputQueueJournal;
	#pendingPrompt?: PendingResource;
	readonly #pendingSteering = new Map<QueueItemId, PendingResource>();
	readonly #deferred: DeferredWork[];
	#queuePaused: boolean;
	#activeRun?: Promise<RunResult>;
	#pump?: Promise<void>;
	#driverFailure?: unknown;
	#acknowledgedRuntimeFailure = false;
	readonly #detach: () => void;
	#disposeOperation?: Promise<number>;

	constructor(options: { readonly runtime: RuntimeInputPort; readonly journal: RuntimeInputQueueJournal }) {
		this.#runtime = options.runtime;
		this.#journal = options.journal;
		this.#deferred = options.runtime.snapshot().agent.pendingFollowUps.map(({ id }) => ({ kind: "follow_up", id }));
		this.#queuePaused = this.#deferred.length > 0;
		this.#detach = options.runtime.subscribe((event) => this.#accept(event));
	}

	get queuePaused(): boolean {
		return (
			this.#queuePaused && (this.#deferred.length > 0 || this.#runtime.snapshot().agent.pendingFollowUps.length > 0)
		);
	}

	get shouldDeferPrompt(): boolean {
		return (
			this.#queuePaused || this.#deferred.length > 0 || this.#runtime.snapshot().agent.pendingFollowUps.length > 0
		);
	}

	get pendingExternalCount(): number {
		return this.#deferred.filter(({ kind }) => kind === "external").length;
	}

	startPrompt(input: AgentInput, transaction: RuntimeResourceTransaction): Promise<RunResult> {
		if (this.#runtime.snapshot().agent.status !== "idle") throw new Error("Agent is already running");
		this.#pendingPrompt = { transaction };
		this.#acknowledgedRuntimeFailure = false;
		let operation: Promise<RunResult>;
		try {
			operation = this.#runtime.prompt(input);
		} catch (error) {
			this.#pendingPrompt = undefined;
			throw error;
		}
		const tracked = operation.then(
			async (result) => {
				await this.#rollbackPromptIfPending(transaction);
				return result;
			},
			async (error) => {
				await this.#rollbackPromptIfPending(transaction);
				throw error;
			},
		);
		this.#trackRun(tracked);
		return tracked;
	}

	steer(input: AgentInput, transaction: RuntimeResourceTransaction): QueueItemId {
		const id = this.#runtime.steer(input);
		this.#pendingSteering.set(id, { transaction });
		return id;
	}

	async enqueueFollowUp(
		input: AgentInput,
		transaction: RuntimeResourceTransaction,
		lifecycle: RuntimeQueueItemLifecycle = {},
	): Promise<QueueItemId> {
		this.#validateFollowUp(input);
		let id: QueueItemId;
		try {
			id = this.#runtime.followUp(input);
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
		const item = this.#runtime.snapshot().agent.pendingFollowUps.find((candidate) => candidate.id === id);
		if (!item) {
			this.#runtime.cancel(id);
			await transaction.rollback();
			throw new Error(`Agent did not retain Follow-up ${id}`);
		}
		try {
			await lifecycle.accepted?.(id);
			await this.#journal.record({ type: "follow_up_enqueued", item });
		} catch (error) {
			this.#runtime.cancel(id);
			await lifecycle.rollback?.(id);
			await transaction.rollback();
			throw error;
		}
		await transaction.commit();
		this.#deferred.push({ kind: "follow_up", id });
		this.#scheduleQueue();
		return id;
	}

	enqueueExternal(id: string, run: () => Promise<void>): void {
		if (!id) throw new Error("Deferred work identity must not be empty");
		if (this.#deferred.some((item) => item.kind === "external" && item.id === id)) {
			throw new Error(`Deferred work is already queued: ${id}`);
		}
		this.#deferred.push({ kind: "external", id, run });
		this.#scheduleQueue();
	}

	reclaimExternal(id: string): void {
		const index = this.#deferred.findIndex((item) => item.kind === "external" && item.id === id);
		if (index < 0) throw new Error("Deferred work is no longer queued");
		this.#deferred.splice(index, 1);
	}

	resume(): void {
		this.#queuePaused = false;
		this.#scheduleQueue();
	}

	async reclaimFollowUp(id: QueueItemId): Promise<void> {
		this.#removeDeferredFollowUp(id);
		if (this.#runtime.snapshot().agent.pendingFollowUps.some((candidate) => candidate.id === id)) {
			this.#runtime.cancel(id);
		}
		await this.#journal.record({ type: "follow_up_reclaimed", id });
	}

	async discardPendingFollowUps(): Promise<readonly QueueItemId[]> {
		this.#queuePaused = true;
		const discarded: QueueItemId[] = [];
		for (const { id } of [...this.#runtime.snapshot().agent.pendingFollowUps]) {
			this.#removeDeferredFollowUp(id);
			this.#runtime.cancel(id);
			await this.#journal.record({ type: "follow_up_canceled", id });
			discarded.push(id);
		}
		return Object.freeze(discarded);
	}

	abort(): void {
		this.#runtime.cancel();
	}

	acknowledgeRuntimeFailure(): void {
		this.#acknowledgedRuntimeFailure = true;
		this.#driverFailure = undefined;
	}

	async waitForIdle(): Promise<void> {
		while (this.#activeRun || this.#pump) {
			await Promise.all([
				this.#activeRun?.then(
					() => undefined,
					() => undefined,
				),
				this.#pump,
			]);
		}
		if (this.#driverFailure !== undefined) {
			const failure = this.#driverFailure;
			this.#driverFailure = undefined;
			throw failure;
		}
	}

	dispose(): Promise<number> {
		if (this.#disposeOperation) return this.#disposeOperation;
		const operation = (async () => {
			this.#detach();
			const transactions = [
				...(this.#pendingPrompt ? [this.#pendingPrompt.transaction] : []),
				...[...this.#pendingSteering.values()].map(({ transaction }) => transaction),
			];
			this.#pendingPrompt = undefined;
			this.#pendingSteering.clear();
			for (const transaction of transactions) await transaction.rollback();
			const dropped = this.pendingExternalCount;
			for (let index = this.#deferred.length - 1; index >= 0; index--) {
				if (this.#deferred[index]?.kind === "external") this.#deferred.splice(index, 1);
			}
			return dropped;
		})();
		this.#disposeOperation = operation;
		return operation;
	}

	async #accept(event: AgentEvent): Promise<void> {
		if (event.type === "run_start" && event.source === "prompt" && this.#pendingPrompt) {
			const pending = this.#pendingPrompt;
			this.#pendingPrompt = undefined;
			await pending.transaction.commit();
			return;
		}
		if (event.type === "turn_start" && event.steeringMessages.length > 0) {
			const consumed = [...this.#pendingSteering.entries()].slice(0, event.steeringMessages.length);
			for (const [id, pending] of consumed) {
				this.#pendingSteering.delete(id);
				await pending.transaction.commit();
			}
			return;
		}
		if (event.type === "run_end" && this.#pendingSteering.size > 0) {
			const abandoned = [...this.#pendingSteering.values()];
			this.#pendingSteering.clear();
			for (const pending of abandoned) await pending.transaction.rollback();
		}
	}

	async #rollbackPromptIfPending(transaction: RuntimeResourceTransaction): Promise<void> {
		if (this.#pendingPrompt?.transaction !== transaction) return;
		this.#pendingPrompt = undefined;
		await transaction.rollback();
	}

	#trackRun(operation: Promise<RunResult>): void {
		this.#activeRun = operation;
		void operation
			.then(
				(result) => {
					if (result.outcome !== "success") this.#queuePaused = true;
				},
				(error: unknown) => {
					this.#queuePaused = true;
					if (!this.#consumeAcknowledgedRuntimeFailure()) this.#driverFailure ??= error;
				},
			)
			.finally(() => {
				if (this.#activeRun === operation) this.#activeRun = undefined;
				this.#scheduleQueue();
			});
	}

	#scheduleQueue(): void {
		if (
			this.#pump ||
			this.#queuePaused ||
			this.#deferred.length === 0 ||
			this.#activeRun ||
			this.#runtime.snapshot().agent.status !== "idle"
		) {
			return;
		}
		const pump = this.#drainQueue().catch((error: unknown) => {
			this.#driverFailure ??= error;
			this.#queuePaused = true;
		});
		this.#pump = pump;
		void pump.finally(() => {
			if (this.#pump === pump) this.#pump = undefined;
			this.#scheduleQueue();
		});
	}

	async #drainQueue(): Promise<void> {
		while (!this.#queuePaused && this.#deferred.length > 0) {
			const item = this.#deferred.shift();
			if (!item) return;
			if (item.kind === "external") {
				await item.run();
				continue;
			}
			if (!this.#runtime.snapshot().agent.pendingFollowUps.some(({ id }) => id === item.id)) continue;
			this.#acknowledgedRuntimeFailure = false;
			const operation = this.#runtime.dispatch({ type: "run_next_follow_up" }) as Promise<RunResult>;
			this.#activeRun = operation;
			let result: RunResult;
			try {
				result = await operation;
			} catch (error) {
				if (this.#consumeAcknowledgedRuntimeFailure()) {
					this.#queuePaused = true;
					return;
				}
				throw error;
			} finally {
				if (this.#activeRun === operation) this.#activeRun = undefined;
			}
			if (result.outcome !== "success") this.#queuePaused = true;
		}
	}

	#validateFollowUp(input: AgentInput): void {
		if (this.#runtime.snapshot().agent.pendingFollowUps.length >= MAXIMUM_PENDING_FOLLOW_UPS) {
			throw new Error(`Follow-up queue is limited to ${MAXIMUM_PENDING_FOLLOW_UPS} items`);
		}
		const text =
			typeof input === "string"
				? input
				: input
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		if (new TextEncoder().encode(text).byteLength > MAXIMUM_FOLLOW_UP_TEXT_BYTES) {
			throw new Error("Follow-up text is limited to 1 MiB");
		}
	}

	#consumeAcknowledgedRuntimeFailure(): boolean {
		const acknowledged = this.#acknowledgedRuntimeFailure;
		this.#acknowledgedRuntimeFailure = false;
		return acknowledged;
	}

	#removeDeferredFollowUp(id: QueueItemId): void {
		const index = this.#deferred.findIndex((item) => item.kind === "follow_up" && item.id === id);
		if (index >= 0) this.#deferred.splice(index, 1);
	}
}
