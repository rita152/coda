import type { Agent, AgentEvent, AgentInput, QueueItemId } from "@coda/agent";
import type { Session } from "../session/types.ts";

const MAXIMUM_PENDING_FOLLOW_UPS = 32;
const MAXIMUM_FOLLOW_UP_TEXT_BYTES = 1_048_576;

export interface InteractiveInputControllerOptions {
	readonly agent: Agent;
	readonly session: Pick<Session, "record">;
	readonly buildInput: (text: string, attachmentIds: readonly string[]) => Promise<AgentInput>;
	readonly prepareAttachments: (attachmentIds: readonly string[]) => Promise<AttachmentTransaction>;
}

export interface AttachmentTransaction {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

/** Owns the transactional seam between the Composer, Agent queues, media, and Session journal. */
export class InteractiveInputController {
	readonly #options: InteractiveInputControllerOptions;
	#driver?: Promise<void>;
	#driverFailure?: unknown;
	#pendingPrompt?: AttachmentTransaction;
	readonly #pendingSteering = new Map<QueueItemId, AttachmentTransaction>();
	readonly #detachAgent: () => void;

	constructor(options: InteractiveInputControllerOptions) {
		this.#options = options;
		this.#detachAgent = options.agent.onEvent((event) => this.#accept(event));
	}

	async submit(text: string, attachmentIds: readonly string[]): Promise<QueueItemId | undefined> {
		this.#assertCanSubmit();
		const prepared = await this.#prepareInput(text, attachmentIds);
		return this.#submitPrepared(prepared.input, prepared.transaction);
	}

	async submitInput(input: AgentInput, attachmentIds: readonly string[] = []): Promise<QueueItemId | undefined> {
		this.#assertCanSubmit();
		const transaction = await this.#options.prepareAttachments(attachmentIds);
		return this.#submitPrepared(input, transaction);
	}

	async #submitPrepared(input: AgentInput, transaction: AttachmentTransaction): Promise<QueueItemId | undefined> {
		if (this.#options.agent.state.pendingFollowUps.length > 0) {
			this.#validateFollowUp(followUpText(input));
			const id = await this.#enqueueFollowUp(input, transaction);
			this.resumeFollowUps();
			return id;
		}
		this.#pendingPrompt = transaction;
		let operation: ReturnType<Agent["prompt"]>;
		try {
			operation = this.#options.agent.prompt(input);
		} catch (error) {
			this.#pendingPrompt = undefined;
			await transaction.rollback();
			throw error;
		}
		this.#track(
			operation.then(
				() => this.#rollbackPromptIfPending(transaction),
				async (error) => {
					await this.#rollbackPromptIfPending(transaction);
					throw error;
				},
			),
		);
		return undefined;
	}

	async steer(text: string, attachmentIds: readonly string[]): Promise<QueueItemId> {
		const prepared = await this.#prepareInput(text, attachmentIds);
		try {
			const id = this.#options.agent.steer(prepared.input);
			this.#pendingSteering.set(id, prepared.transaction);
			return id;
		} catch (error) {
			await prepared.transaction.rollback();
			throw error;
		}
	}

	async followUp(text: string, attachmentIds: readonly string[]): Promise<QueueItemId> {
		this.#validateFollowUp(text);
		const prepared = await this.#prepareInput(text, attachmentIds);
		return this.#enqueueFollowUp(prepared.input, prepared.transaction);
	}

	resumeFollowUps(): void {
		const operation = this.#options.agent.resumeFollowUps();
		this.#track(operation.then(() => undefined));
	}

	async reclaimFollowUp(id: QueueItemId): Promise<void> {
		if (this.#options.agent.state.pendingFollowUps.some((candidate) => candidate.id === id)) {
			this.#options.agent.cancelQueueItem(id);
		}
		await this.#options.session.record({ type: "follow_up_reclaimed", id });
	}

	async #enqueueFollowUp(input: AgentInput, transaction: AttachmentTransaction): Promise<QueueItemId> {
		let id: QueueItemId;
		try {
			id = this.#options.agent.followUp(input);
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
		const item = this.#options.agent.state.pendingFollowUps.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Agent did not retain Follow-up ${id}`);
		try {
			await this.#options.session.record({ type: "follow_up_enqueued", item });
		} catch (error) {
			this.#options.agent.cancelQueueItem(id);
			await transaction.rollback();
			throw error;
		}
		await transaction.commit();
		return id;
	}

	#validateFollowUp(text: string): void {
		if (this.#options.agent.state.pendingFollowUps.length >= MAXIMUM_PENDING_FOLLOW_UPS) {
			throw new Error(`Follow-up queue is limited to ${MAXIMUM_PENDING_FOLLOW_UPS} items`);
		}
		if (new TextEncoder().encode(text).byteLength > MAXIMUM_FOLLOW_UP_TEXT_BYTES) {
			throw new Error("Follow-up text is limited to 1 MiB");
		}
	}

	async waitForIdle(): Promise<void> {
		await this.#driver;
		if (this.#driverFailure !== undefined) {
			const failure = this.#driverFailure;
			this.#driverFailure = undefined;
			throw failure;
		}
	}

	abort(): void {
		this.#options.agent.abort();
	}

	async dispose(): Promise<void> {
		this.#detachAgent();
		const transactions = [...(this.#pendingPrompt ? [this.#pendingPrompt] : []), ...this.#pendingSteering.values()];
		this.#pendingPrompt = undefined;
		this.#pendingSteering.clear();
		for (const transaction of transactions) await transaction.rollback();
	}

	async #prepareInput(
		text: string,
		attachmentIds: readonly string[],
	): Promise<{ readonly input: AgentInput; readonly transaction: AttachmentTransaction }> {
		const input = await this.#options.buildInput(text, attachmentIds);
		const transaction = await this.#options.prepareAttachments(attachmentIds);
		return { input, transaction };
	}

	#assertCanSubmit(): void {
		if (this.#options.agent.state.status !== "idle") throw new Error("Agent is already running");
	}

	async #accept(event: AgentEvent): Promise<void> {
		if (event.type === "run_start" && event.source === "prompt" && this.#pendingPrompt) {
			const transaction = this.#pendingPrompt;
			this.#pendingPrompt = undefined;
			await transaction.commit();
			return;
		}
		if (event.type === "turn_start" && event.steeringMessages.length > 0) {
			const consumed = [...this.#pendingSteering.entries()].slice(0, event.steeringMessages.length);
			for (const [id, transaction] of consumed) {
				this.#pendingSteering.delete(id);
				await transaction.commit();
			}
			return;
		}
		if (event.type === "run_end" && this.#pendingSteering.size > 0) {
			const abandoned = [...this.#pendingSteering.values()];
			this.#pendingSteering.clear();
			for (const transaction of abandoned) await transaction.rollback();
		}
	}

	async #rollbackPromptIfPending(transaction: AttachmentTransaction): Promise<void> {
		if (this.#pendingPrompt !== transaction) return;
		this.#pendingPrompt = undefined;
		await transaction.rollback();
	}

	#track(operation: Promise<void>): void {
		const driver = operation.then(
			() => undefined,
			(error: unknown) => {
				this.#driverFailure = error;
			},
		);
		this.#driver = driver;
		void driver.finally(() => {
			if (this.#driver === driver) this.#driver = undefined;
		});
	}
}

function followUpText(input: AgentInput): string {
	if (typeof input === "string") return input;
	return input
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}
