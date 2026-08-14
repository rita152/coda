import type { AgentInput, QueueItemId } from "@coda/agent";
import type { RuntimeInputLifecycle, RuntimeQueueItemLifecycle, RuntimeResourceTransaction } from "@coda/runtime";
import type {
	ComposerExtensionReference,
	ComposerSubmission,
	ComposerSubmissionKind,
} from "../session/composer-submission.ts";
import type { Session } from "../session/types.ts";
import type { UserShellSubmission } from "./input-types.ts";
import type { UserShell } from "./user-shell.ts";

export interface InteractiveInputControllerOptions {
	readonly input: RuntimeInputLifecycle;
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

export interface AttachmentTransaction extends RuntimeResourceTransaction {}

/** Thin interactive Adapter over the headless Runtime's input lifecycle. */
export class InteractiveInputController {
	readonly #options: InteractiveInputControllerOptions;
	readonly #queue: RuntimeInputLifecycle;
	readonly #submissionByQueueItemId = new Map<string, string>();
	#acceptanceTail: Promise<void> = Promise.resolve();

	constructor(options: InteractiveInputControllerOptions) {
		this.#options = options;
		for (const submission of options.session.composerSubmissions ?? []) {
			if (submission.queueItemId) this.#submissionByQueueItemId.set(submission.queueItemId, submission.id);
		}
		this.#queue = options.input;
	}

	get queuePaused(): boolean {
		return this.#queue.queuePaused;
	}

	get pendingUserShellCount(): number {
		return this.#queue.pendingExternalCount;
	}

	submit(
		text: string,
		attachmentIds: readonly string[],
		composerText = text,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string | undefined> {
		return this.#serializeAcceptance(async () => {
			const deferred = this.#queue.shouldDeferPrompt;
			const prepared = await this.#prepareInput(
				text,
				attachmentIds,
				deferred ? "follow_up" : "prompt",
				composerText,
				references,
			);
			if (deferred) {
				const result = await this.#enqueueFollowUp(composerText, prepared.input, prepared.transaction, references);
				this.resumeQueue();
				return result;
			}
			return this.#submitPrompt(composerText, prepared.input, prepared.transaction, references);
		});
	}

	submitInput(input: AgentInput, attachmentIds: readonly string[] = []): Promise<QueueItemId | undefined> {
		return this.#serializeAcceptance(async () => {
			const transaction = await this.#options.prepareAttachments(attachmentIds);
			if (this.#queue.shouldDeferPrompt) {
				const id = await this.#queue.enqueueFollowUp(input, transaction);
				this.resumeQueue();
				return id;
			}
			try {
				this.#queue.startPrompt(input, transaction);
			} catch (error) {
				await transaction.rollback();
				throw error;
			}
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
				const id = this.#queue.steer(prepared.input, prepared.transaction);
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
			this.#queue.enqueueExternal(submission.id, async () => {
				await this.#options.userShell!.run(submission.id, submission.command);
			});
			return submission;
		});
	}

	resumeQueue(): void {
		this.#queue.resume();
	}

	async reclaimFollowUp(id: QueueItemId): Promise<void> {
		await this.#queue.reclaimFollowUp(id);
		const submissionId = this.#submissionByQueueItemId.get(id);
		if (submissionId) {
			await this.#retractComposerSubmission(submissionId);
			this.#submissionByQueueItemId.delete(id);
		}
	}

	discardPendingFollowUps(): Promise<void> {
		return this.#serializeAcceptance(async () => {
			for (const id of await this.#queue.discardPendingFollowUps()) {
				const submissionId = this.#submissionByQueueItemId.get(id);
				if (submissionId) {
					await this.#retractComposerSubmission(submissionId);
					this.#submissionByQueueItemId.delete(id);
				}
			}
		});
	}

	reclaimUserShell(id: string): void {
		this.#queue.reclaimExternal(id);
	}

	cancelUserShell(): boolean {
		return this.#options.userShell?.cancel() ?? false;
	}

	abortAgent(): void {
		this.#queue.abort();
	}

	acknowledgeAgentRuntimeFailure(): void {
		this.#queue.acknowledgeRuntimeFailure();
	}

	async waitForIdle(): Promise<void> {
		await this.#acceptanceTail;
		await this.#queue.waitForIdle();
	}

	async #submitPrompt(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | undefined> {
		const submission = await this.#recordComposerSubmission("prompt", composerText, undefined, references);
		const resources: RuntimeResourceTransaction = {
			commit: () => transaction.commit(),
			rollback: async () => {
				if (submission) await this.#retractComposerSubmission(submission.id);
				await transaction.rollback();
			},
		};
		try {
			this.#queue.startPrompt(input, resources);
			return submission;
		} catch (error) {
			await resources.rollback();
			throw error;
		}
	}

	async #enqueueFollowUp(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string> {
		let submission: ComposerSubmission | undefined;
		const lifecycle: RuntimeQueueItemLifecycle = {
			accepted: async (id) => {
				submission = await this.#recordComposerSubmission("follow_up", composerText, id, references);
				if (submission) this.#submissionByQueueItemId.set(id, submission.id);
			},
			rollback: async (id) => {
				if (submission) await this.#retractComposerSubmission(submission.id);
				this.#submissionByQueueItemId.delete(id);
			},
		};
		const id = await this.#queue.enqueueFollowUp(input, transaction, lifecycle);
		return submission ?? id;
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

	#serializeAcceptance<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#acceptanceTail.then(operation);
		this.#acceptanceTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
