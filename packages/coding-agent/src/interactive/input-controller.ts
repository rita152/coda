import type { Agent, AgentEvent, AgentInput, QueueItemId, RunResult } from "@coda/agent";
import type { Session } from "../session/types.ts";
import type {
	ComposerExtensionReference,
	ComposerSubmission,
	ComposerSubmissionKind,
	UserShellSubmission,
} from "./input-types.ts";
import type { UserShell } from "./user-shell.ts";

const MAXIMUM_PENDING_FOLLOW_UPS = 32;
const MAXIMUM_FOLLOW_UP_TEXT_BYTES = 1_048_576;

export interface InteractiveInputControllerOptions {
	readonly agent: Agent;
	readonly session: Pick<Session, "composerSubmissions" | "record">;
	readonly buildInput: (
		text: string,
		attachmentIds: readonly string[],
		context: {
			readonly kind: ComposerSubmissionKind;
			readonly composerText: string;
			readonly references: readonly ComposerExtensionReference[];
		},
	) => Promise<AgentInput>;
	readonly prepareAttachments: (attachmentIds: readonly string[]) => Promise<AttachmentTransaction>;
	readonly allocateId: (kind: "composer_submission" | "user_shell") => string;
	readonly userShell?: Pick<UserShell, "cancel" | "run" | "running">;
}

export interface AttachmentTransaction {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

interface PendingPrompt {
	readonly transaction: AttachmentTransaction;
	readonly submissionId?: string;
}

interface PendingSteering {
	readonly transaction: AttachmentTransaction;
	readonly submissionId?: string;
}

type DeferredInput =
	| { readonly kind: "follow_up"; readonly id: QueueItemId }
	| { readonly kind: "user_shell"; readonly submission: UserShellSubmission };

/**
 * Owns acceptance and scheduling across Composer history, Agent queues, local Shell,
 * media transactions, and the Session journal.
 */
export class InteractiveInputController {
	readonly #options: InteractiveInputControllerOptions;
	#pendingPrompt?: PendingPrompt;
	readonly #pendingSteering = new Map<QueueItemId, PendingSteering>();
	readonly #submissionByQueueItemId = new Map<string, string>();
	readonly #deferred: DeferredInput[];
	#queuePaused: boolean;
	#activeAgent?: Promise<RunResult>;
	#pump?: Promise<void>;
	#acceptanceTail: Promise<void> = Promise.resolve();
	#driverFailure?: unknown;
	readonly #detachAgent: () => void;

	constructor(options: InteractiveInputControllerOptions) {
		this.#options = options;
		for (const submission of options.session.composerSubmissions ?? []) {
			if (submission.queueItemId) this.#submissionByQueueItemId.set(submission.queueItemId, submission.id);
		}
		this.#deferred = options.agent.state.pendingFollowUps.map(({ id }) => ({ kind: "follow_up", id }));
		this.#queuePaused = this.#deferred.length > 0;
		this.#detachAgent = options.agent.onEvent((event) => this.#accept(event));
	}

	get queuePaused(): boolean {
		return this.#queuePaused && (this.#deferred.length > 0 || this.#options.agent.state.pendingFollowUps.length > 0);
	}

	get pendingUserShellCount(): number {
		return this.#deferred.filter(({ kind }) => kind === "user_shell").length;
	}

	submit(
		text: string,
		attachmentIds: readonly string[],
		composerText = text,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string | undefined> {
		return this.#serializeAcceptance(async () => {
			this.#assertCanSubmit();
			const deferred = this.#shouldAppendDeferredQueue();
			const prepared = await this.#prepareInput(
				text,
				attachmentIds,
				deferred ? "follow_up" : "prompt",
				composerText,
				references,
			);
			if (deferred) {
				this.#validateFollowUp(followUpText(prepared.input));
				const submission = await this.#enqueueFollowUp(
					composerText,
					prepared.input,
					prepared.transaction,
					references,
				);
				this.resumeQueue();
				return submission;
			}
			return this.#submitPrompt(composerText, prepared.input, prepared.transaction, references);
		});
	}

	submitInput(input: AgentInput, attachmentIds: readonly string[] = []): Promise<QueueItemId | undefined> {
		return this.#serializeAcceptance(async () => {
			this.#assertCanSubmit();
			const transaction = await this.#options.prepareAttachments(attachmentIds);
			if (this.#shouldAppendDeferredQueue()) {
				this.#validateFollowUp(followUpText(input));
				const id = await this.#enqueueFollowUpWithoutComposer(input, transaction);
				this.resumeQueue();
				return id;
			}
			this.#startPrompt(input, { transaction });
			return undefined;
		});
	}

	steer(
		text: string,
		attachmentIds: readonly string[],
		composerText = text,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string> {
		return this.#serializeAcceptance(async () => {
			const prepared = await this.#prepareInput(text, attachmentIds, "steering", composerText, references);
			const submission = await this.#recordComposerSubmission("steering", composerText, undefined, references);
			try {
				const id = this.#options.agent.steer(prepared.input);
				this.#pendingSteering.set(id, {
					transaction: prepared.transaction,
					...(submission ? { submissionId: submission.id } : {}),
				});
				return submission ?? id;
			} catch (error) {
				if (submission) await this.#retractComposerSubmission(submission.id);
				await prepared.transaction.rollback();
				throw error;
			}
		});
	}

	followUp(
		text: string,
		attachmentIds: readonly string[],
		composerText = text,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string> {
		return this.#serializeAcceptance(async () => {
			this.#validateFollowUp(text);
			const prepared = await this.#prepareInput(text, attachmentIds, "follow_up", composerText, references);
			return this.#enqueueFollowUp(composerText, prepared.input, prepared.transaction, references);
		});
	}

	submitUserShell(command: string): Promise<UserShellSubmission> {
		return this.#serializeAcceptance(async () => {
			if (!this.#options.userShell) throw new Error("Local Shell mode is unavailable");
			const normalized = command.trim();
			if (!normalized) throw new Error("Prefix a command with ! to run it locally. Example: !ls");
			const submission = Object.freeze({ id: this.#allocate("user_shell"), command: normalized });
			this.#deferred.push({ kind: "user_shell", submission });
			this.#scheduleQueue();
			return submission;
		});
	}

	resumeQueue(): void {
		this.#queuePaused = false;
		this.#scheduleQueue();
	}

	async reclaimFollowUp(id: QueueItemId): Promise<void> {
		this.#removeDeferred("follow_up", id);
		if (this.#options.agent.state.pendingFollowUps.some((candidate) => candidate.id === id)) {
			this.#options.agent.cancelQueueItem(id);
		}
		await this.#options.session.record({ type: "follow_up_reclaimed", id });
		const submissionId = this.#submissionByQueueItemId.get(id);
		if (submissionId) {
			await this.#retractComposerSubmission(submissionId);
			this.#submissionByQueueItemId.delete(id);
		}
	}

	discardPendingFollowUps(): Promise<void> {
		this.#queuePaused = true;
		return this.#serializeAcceptance(async () => {
			for (const { id } of [...this.#options.agent.state.pendingFollowUps]) {
				this.#removeDeferred("follow_up", id);
				this.#options.agent.cancelQueueItem(id);
				await this.#options.session.record({ type: "follow_up_canceled", id });
				const submissionId = this.#submissionByQueueItemId.get(id);
				if (submissionId) {
					await this.#retractComposerSubmission(submissionId);
					this.#submissionByQueueItemId.delete(id);
				}
			}
		});
	}

	reclaimUserShell(id: string): void {
		const index = this.#deferred.findIndex((item) => item.kind === "user_shell" && item.submission.id === id);
		if (index < 0) throw new Error("The local Shell command is no longer queued");
		this.#deferred.splice(index, 1);
	}

	cancelUserShell(): boolean {
		return this.#options.userShell?.cancel() ?? false;
	}

	abortAgent(): void {
		this.#options.agent.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.#acceptanceTail;
		while (this.#activeAgent || this.#pump) {
			await Promise.all([this.#activeAgent?.then(() => undefined), this.#pump]);
		}
		if (this.#driverFailure !== undefined) {
			const failure = this.#driverFailure;
			this.#driverFailure = undefined;
			throw failure;
		}
	}

	async dispose(): Promise<number> {
		await this.#acceptanceTail;
		this.#detachAgent();
		const transactions = [
			...(this.#pendingPrompt ? [this.#pendingPrompt.transaction] : []),
			...[...this.#pendingSteering.values()].map(({ transaction }) => transaction),
		];
		this.#pendingPrompt = undefined;
		this.#pendingSteering.clear();
		for (const transaction of transactions) await transaction.rollback();
		const droppedShells = this.pendingUserShellCount;
		for (let index = this.#deferred.length - 1; index >= 0; index--) {
			if (this.#deferred[index]?.kind === "user_shell") this.#deferred.splice(index, 1);
		}
		return droppedShells;
	}

	async #submitPrompt(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | undefined> {
		const submission = await this.#recordComposerSubmission("prompt", composerText, undefined, references);
		try {
			this.#startPrompt(input, { transaction, ...(submission ? { submissionId: submission.id } : {}) });
			return submission;
		} catch (error) {
			if (submission) await this.#retractComposerSubmission(submission.id);
			await transaction.rollback();
			throw error;
		}
	}

	#startPrompt(input: AgentInput, pending: PendingPrompt): void {
		this.#pendingPrompt = pending;
		let operation: Promise<RunResult>;
		try {
			operation = this.#options.agent.prompt(input);
		} catch (error) {
			this.#pendingPrompt = undefined;
			throw error;
		}
		this.#trackAgent(
			operation.then(
				async (result) => {
					await this.#rollbackPromptIfPending(pending);
					return result;
				},
				async (error) => {
					await this.#rollbackPromptIfPending(pending);
					throw error;
				},
			),
		);
	}

	async #enqueueFollowUp(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string> {
		let id: QueueItemId;
		try {
			id = this.#options.agent.followUp(input);
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
		const item = this.#retainedFollowUp(id);
		let submission: ComposerSubmission | undefined;
		try {
			submission = await this.#recordComposerSubmission("follow_up", composerText, id, references);
			await this.#options.session.record({ type: "follow_up_enqueued", item });
		} catch (error) {
			this.#options.agent.cancelQueueItem(id);
			if (submission) await this.#retractComposerSubmission(submission.id);
			await transaction.rollback();
			throw error;
		}
		await transaction.commit();
		if (submission) this.#submissionByQueueItemId.set(id, submission.id);
		this.#deferred.push({ kind: "follow_up", id });
		this.#scheduleQueue();
		return submission ?? id;
	}

	async #enqueueFollowUpWithoutComposer(input: AgentInput, transaction: AttachmentTransaction): Promise<QueueItemId> {
		let id: QueueItemId;
		try {
			id = this.#options.agent.followUp(input);
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
		const item = this.#retainedFollowUp(id);
		try {
			await this.#options.session.record({ type: "follow_up_enqueued", item });
		} catch (error) {
			this.#options.agent.cancelQueueItem(id);
			await transaction.rollback();
			throw error;
		}
		await transaction.commit();
		this.#deferred.push({ kind: "follow_up", id });
		this.#scheduleQueue();
		return id;
	}

	#retainedFollowUp(id: QueueItemId) {
		const item = this.#options.agent.state.pendingFollowUps.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Agent did not retain Follow-up ${id}`);
		return item;
	}

	async #recordComposerSubmission(
		kind: ComposerSubmissionKind,
		text: string,
		queueItemId?: QueueItemId,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | undefined> {
		const normalized = text.trim();
		if (!normalized) return undefined;
		const submission = Object.freeze({
			id: this.#allocate("composer_submission"),
			kind,
			text: normalized,
			...(references && references.length > 0
				? { references: Object.freeze(references.map((reference) => Object.freeze({ ...reference }))) }
				: {}),
			...(queueItemId ? { queueItemId } : {}),
		});
		await this.#options.session.record({ type: "composer_submission_recorded", submission });
		return submission;
	}

	async #retractComposerSubmission(id: string): Promise<void> {
		await this.#options.session.record({ type: "composer_submission_retracted", id });
	}

	#allocate(kind: "composer_submission" | "user_shell"): string {
		const value = this.#options.allocateId(kind);
		if (!value) throw new Error(`Could not allocate ${kind.replaceAll("_", " ")} identity`);
		return `${kind}:${value}`;
	}

	#validateFollowUp(text: string): void {
		if (this.#options.agent.state.pendingFollowUps.length >= MAXIMUM_PENDING_FOLLOW_UPS) {
			throw new Error(`Follow-up queue is limited to ${MAXIMUM_PENDING_FOLLOW_UPS} items`);
		}
		if (new TextEncoder().encode(text).byteLength > MAXIMUM_FOLLOW_UP_TEXT_BYTES) {
			throw new Error("Follow-up text is limited to 1 MiB");
		}
	}

	async #prepareInput(
		text: string,
		attachmentIds: readonly string[],
		kind: ComposerSubmissionKind,
		composerText: string,
		references: readonly ComposerExtensionReference[] = [],
	): Promise<{ readonly input: AgentInput; readonly transaction: AttachmentTransaction }> {
		const input = await this.#options.buildInput(text, attachmentIds, {
			kind,
			composerText,
			references,
		});
		const transaction = await this.#options.prepareAttachments(attachmentIds);
		return { input, transaction };
	}

	#assertCanSubmit(): void {
		if (this.#options.agent.state.status !== "idle") throw new Error("Agent is already running");
	}

	#shouldAppendDeferredQueue(): boolean {
		return this.#queuePaused || this.#deferred.length > 0 || this.#options.agent.state.pendingFollowUps.length > 0;
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

	async #rollbackPromptIfPending(pending: PendingPrompt): Promise<void> {
		if (this.#pendingPrompt !== pending) return;
		this.#pendingPrompt = undefined;
		if (pending.submissionId) await this.#retractComposerSubmission(pending.submissionId);
		await pending.transaction.rollback();
	}

	#trackAgent(operation: Promise<RunResult>): void {
		this.#activeAgent = operation;
		void operation
			.then(
				(result) => {
					if (result.outcome !== "success") this.#queuePaused = true;
				},
				(error: unknown) => {
					this.#queuePaused = true;
					this.#driverFailure ??= error;
				},
			)
			.finally(() => {
				if (this.#activeAgent === operation) this.#activeAgent = undefined;
				this.#scheduleQueue();
			});
	}

	#scheduleQueue(): void {
		if (
			this.#pump ||
			this.#queuePaused ||
			this.#deferred.length === 0 ||
			this.#activeAgent ||
			this.#options.agent.state.status !== "idle" ||
			this.#options.userShell?.running
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
			if (item.kind === "user_shell") {
				if (!this.#options.userShell) throw new Error("Local Shell mode is unavailable");
				await this.#options.userShell.run(item.submission.id, item.submission.command);
				continue;
			}
			if (!this.#options.agent.state.pendingFollowUps.some(({ id }) => id === item.id)) continue;
			const operation = this.#options.agent.runNextFollowUp();
			this.#activeAgent = operation;
			let result: RunResult;
			try {
				result = await operation;
			} finally {
				if (this.#activeAgent === operation) this.#activeAgent = undefined;
			}
			if (result.outcome !== "success") this.#queuePaused = true;
		}
	}

	#removeDeferred(kind: DeferredInput["kind"], id: string): void {
		const index = this.#deferred.findIndex((item) =>
			item.kind === kind ? (item.kind === "follow_up" ? item.id === id : item.submission.id === id) : false,
		);
		if (index >= 0) this.#deferred.splice(index, 1);
	}

	#serializeAcceptance<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#acceptanceTail.then(operation);
		this.#acceptanceTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function followUpText(input: AgentInput): string {
	if (typeof input === "string") return input;
	return input
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}
