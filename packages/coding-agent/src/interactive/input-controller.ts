import type { AgentEvent, AgentInput, FollowUp, QueueItemId } from "@coda/agent";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import type {
	ComposerExtensionReference,
	ComposerSubmission,
	ComposerSubmissionKind,
} from "../session/composer-submission.ts";
import type { Session } from "../session/types.ts";
import type { UserShellSubmission } from "./input-types.ts";
import type { UserShell } from "./user-shell.ts";

const MAXIMUM_PENDING_FOLLOW_UPS = 32;
const MAXIMUM_FOLLOW_UP_TEXT_BYTES = 1_048_576;

export interface AttachmentTransaction {
	/** Opaque Runtime-owned references; omitted by legacy/test transactions. */
	readonly resources?: readonly string[];
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface InteractiveInputControllerOptions {
	readonly work: Pick<SessionWorkController, "beginPrompt" | "cancel" | "deliver" | "isBusy" | "prompt" | "subscribe">;
	readonly session: Pick<Session, "composerSubmissions" | "record" | "seed">;
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

interface DeferredFollowUp {
	readonly kind: "follow_up";
	readonly id: QueueItemId;
	readonly input: AgentInput;
}

interface DeferredExternal {
	readonly kind: "external";
	readonly id: string;
	readonly run: () => Promise<void>;
}

type DeferredWork = DeferredFollowUp | DeferredExternal;

interface PendingResource {
	readonly transaction: AttachmentTransaction;
}

/** Product interaction queue translated exclusively into public Work Graph operations. */
export class InteractiveInputController {
	readonly #options: InteractiveInputControllerOptions;
	readonly #work: InteractiveInputControllerOptions["work"];
	readonly #submissionByQueueItemId = new Map<string, string>();
	readonly #deferred: DeferredWork[] = [];
	readonly #deliveredFollowUps: QueueItemId[] = [];
	readonly #pendingSteering: PendingResource[] = [];
	readonly #detach: () => void;
	#pendingPrompt?: PendingResource;
	#queuedPromptId?: QueueItemId;
	#queuePaused = false;
	#acceptanceTail: Promise<void> = Promise.resolve();
	#active?: Promise<unknown>;
	#pump?: Promise<void>;
	#driverFailure?: unknown;
	#acknowledgedFailure = false;
	#closed = false;

	constructor(options: InteractiveInputControllerOptions) {
		this.#options = options;
		this.#work = options.work;
		for (const submission of options.session.composerSubmissions ?? []) {
			if (submission.queueItemId) this.#submissionByQueueItemId.set(submission.queueItemId, submission.id);
		}
		for (const item of options.session.seed.pendingFollowUps) {
			this.#deferred.push({
				kind: "follow_up",
				id: item.id,
				input:
					typeof item.content === "string" ? item.content : item.content.map((block) => structuredClone(block)),
			});
		}
		this.#queuePaused = this.#deferred.length > 0;
		this.#detach = this.#work.subscribe((event) => this.#accept(event));
	}

	get queuePaused(): boolean {
		return this.#queuePaused && this.#deferred.length > 0;
	}

	get pendingUserShellCount(): number {
		return this.#deferred.filter(({ kind }) => kind === "external").length;
	}

	get pendingFollowUps(): readonly FollowUp[] {
		return Object.freeze(
			this.#deferred.flatMap((item) =>
				item.kind === "follow_up" ? [{ id: item.id, content: structuredClone(item.input) }] : [],
			),
		);
	}

	submit(
		text: string,
		attachmentIds: readonly string[],
		composerText = text,
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string | undefined> {
		return this.#serializeAcceptance(async () => {
			const deferred = this.queuePaused || this.#deferred.some(({ kind }) => kind === "follow_up");
			const prepared = await this.#prepareInput(
				text,
				attachmentIds,
				deferred ? "follow_up" : "prompt",
				composerText,
				references,
			);
			if (deferred) {
				const result = await this.#enqueueFollowUp(
					composerText,
					prepared.input,
					prepared.transaction,
					this.#resourceReferences(prepared.transaction, attachmentIds),
					references,
				);
				this.resumeQueue();
				return result;
			}
			return this.#submitPrompt(
				composerText,
				prepared.input,
				prepared.transaction,
				this.#resourceReferences(prepared.transaction, attachmentIds),
				references,
			);
		});
	}

	submitInput(input: AgentInput, attachmentIds: readonly string[] = []): Promise<QueueItemId | undefined> {
		return this.#serializeAcceptance(async () => {
			const transaction = await this.#options.prepareAttachments(attachmentIds);
			if (this.queuePaused || this.#deferred.some(({ kind }) => kind === "follow_up")) {
				const id = await this.#queueFollowUp(
					input,
					transaction,
					undefined,
					this.#resourceReferences(transaction, attachmentIds),
				);
				this.resumeQueue();
				return id;
			}
			await this.#startPrompt(input, transaction, this.#resourceReferences(transaction, attachmentIds));
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
			const pending = { transaction: prepared.transaction };
			this.#pendingSteering.push(pending);
			try {
				await this.#work.deliver(
					"steering",
					prepared.input,
					this.#resourceReferences(prepared.transaction, attachmentIds),
				);
				return submission ?? this.#allocateQueueItem();
			} catch (error) {
				const index = this.#pendingSteering.indexOf(pending);
				if (index >= 0) this.#pendingSteering.splice(index, 1);
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
			return this.#enqueueFollowUp(
				composerText,
				prepared.input,
				prepared.transaction,
				this.#resourceReferences(prepared.transaction, attachmentIds),
				references,
			);
		});
	}

	submitUserShell(command: string): Promise<UserShellSubmission> {
		return this.#serializeAcceptance(async () => {
			if (!this.#options.userShell) throw new Error("Local Shell mode is unavailable");
			const normalized = command.trim();
			if (!normalized) throw new Error("Prefix a command with ! to run it locally. Example: !ls");
			const submission = Object.freeze({ id: this.#allocate("user_shell"), command: normalized });
			this.#deferred.push({
				kind: "external",
				id: submission.id,
				run: async () => void (await this.#options.userShell!.run(submission.id, submission.command)),
			});
			this.#scheduleQueue();
			return submission;
		});
	}

	resumeQueue(): void {
		this.#queuePaused = false;
		this.#scheduleQueue();
	}

	async reclaimFollowUp(id: QueueItemId): Promise<void> {
		const index = this.#deferred.findIndex((item) => item.kind === "follow_up" && item.id === id);
		if (index < 0)
			throw new Error("Follow-up is already durable in active Work and cannot be reclaimed individually");
		this.#deferred.splice(index, 1);
		await this.#options.session.record({ type: "follow_up_reclaimed", id });
		const submissionId = this.#submissionByQueueItemId.get(id);
		if (submissionId) {
			await this.#retractComposerSubmission(submissionId);
			this.#submissionByQueueItemId.delete(id);
		}
	}

	discardPendingFollowUps(): Promise<void> {
		return this.#serializeAcceptance(async () => {
			this.#queuePaused = true;
			for (let index = this.#deferred.length - 1; index >= 0; index--) {
				const item = this.#deferred[index];
				if (item?.kind !== "follow_up") continue;
				this.#deferred.splice(index, 1);
				await this.#options.session.record({ type: "follow_up_canceled", id: item.id });
				const submissionId = this.#submissionByQueueItemId.get(item.id);
				if (submissionId) await this.#retractComposerSubmission(submissionId);
				this.#submissionByQueueItemId.delete(item.id);
			}
		});
	}

	reclaimUserShell(id: string): void {
		const index = this.#deferred.findIndex((item) => item.kind === "external" && item.id === id);
		if (index < 0) throw new Error("Deferred local Shell command is no longer queued");
		this.#deferred.splice(index, 1);
	}

	cancelUserShell(): boolean {
		return this.#options.userShell?.cancel() ?? false;
	}

	abortAgent(): void {
		void this.#work.cancel().catch((error: unknown) => {
			this.#driverFailure ??= error;
		});
	}

	acknowledgeAgentRuntimeFailure(): void {
		this.#acknowledgedFailure = true;
		this.#driverFailure = undefined;
	}

	async waitForIdle(): Promise<void> {
		await this.#acceptanceTail;
		while (this.#active || this.#pump) {
			await Promise.allSettled([...(this.#active ? [this.#active] : []), ...(this.#pump ? [this.#pump] : [])]);
		}
		if (this.#driverFailure !== undefined) {
			const failure = this.#driverFailure;
			this.#driverFailure = undefined;
			throw failure;
		}
	}

	async close(): Promise<number> {
		if (this.#closed) return 0;
		this.#closed = true;
		this.#detach();
		const resources = [
			...(this.#pendingPrompt ? [this.#pendingPrompt.transaction] : []),
			...this.#pendingSteering.map(({ transaction }) => transaction),
		];
		this.#pendingPrompt = undefined;
		this.#pendingSteering.splice(0);
		for (const transaction of resources) await transaction.rollback();
		const dropped = this.pendingUserShellCount;
		for (let index = this.#deferred.length - 1; index >= 0; index--) {
			if (this.#deferred[index]?.kind === "external") this.#deferred.splice(index, 1);
		}
		return dropped;
	}

	async #submitPrompt(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		resources: readonly string[],
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | undefined> {
		const submission = await this.#recordComposerSubmission("prompt", composerText, undefined, references);
		try {
			await this.#startPrompt(input, transaction, resources);
			return submission;
		} catch (error) {
			if (submission) await this.#retractComposerSubmission(submission.id);
			await transaction.rollback();
			throw error;
		}
	}

	async #startPrompt(
		input: AgentInput,
		transaction: AttachmentTransaction,
		resources: readonly string[],
	): Promise<void> {
		if (this.#work.isBusy() || this.#active) throw new Error("This Session already owns active Work");
		this.#acknowledgedFailure = false;
		this.#pendingPrompt = { transaction };
		try {
			const begun = await this.#work.beginPrompt(input, resources);
			this.#track(begun.result);
		} catch (error) {
			this.#pendingPrompt = undefined;
			throw error;
		}
	}

	async #enqueueFollowUp(
		composerText: string,
		input: AgentInput,
		transaction: AttachmentTransaction,
		resources: readonly string[],
		references?: readonly ComposerExtensionReference[],
	): Promise<ComposerSubmission | string> {
		const id = this.#allocateQueueItem();
		const submission = await this.#recordComposerSubmission("follow_up", composerText, id, references);
		try {
			await this.#queueFollowUp(input, transaction, id, resources);
			if (submission) this.#submissionByQueueItemId.set(id, submission.id);
			return submission ?? id;
		} catch (error) {
			if (submission) await this.#retractComposerSubmission(submission.id);
			throw error;
		}
	}

	async #queueFollowUp(
		input: AgentInput,
		transaction: AttachmentTransaction,
		allocatedId?: QueueItemId,
		resources: readonly string[] = [],
	): Promise<QueueItemId> {
		this.#validateFollowUp(input);
		const id = allocatedId ?? this.#allocateQueueItem();
		await this.#options.session.record({ type: "follow_up_enqueued", item: { id, content: input } });
		if (this.#work.isBusy() && this.#deferred.length === 0) {
			this.#deliveredFollowUps.push(id);
			try {
				await this.#work.deliver("follow_up", input, resources);
				await transaction.commit();
				return id;
			} catch (error) {
				const index = this.#deliveredFollowUps.indexOf(id);
				if (index >= 0) this.#deliveredFollowUps.splice(index, 1);
				await this.#options.session.record({ type: "follow_up_canceled", id });
				await transaction.rollback();
				throw error;
			}
		}
		await transaction.commit();
		this.#deferred.push({ kind: "follow_up", id, input: structuredClone(input) });
		this.#scheduleQueue();
		return id;
	}

	#track(operation: ReturnType<SessionWorkController["prompt"]>): void {
		this.#active = operation;
		void operation
			.then(
				async (result) => {
					if (this.#pendingPrompt) {
						const pending = this.#pendingPrompt;
						this.#pendingPrompt = undefined;
						await pending.transaction.rollback();
					}
					if (result.state !== "succeeded" && !this.#consumeAcknowledgedFailure()) this.#queuePaused = true;
				},
				async (error: unknown) => {
					if (this.#pendingPrompt) {
						const pending = this.#pendingPrompt;
						this.#pendingPrompt = undefined;
						await pending.transaction.rollback();
					}
					if (!this.#consumeAcknowledgedFailure()) {
						this.#driverFailure ??= error;
						this.#queuePaused = true;
					}
				},
			)
			.finally(() => {
				if (this.#active === operation) this.#active = undefined;
				this.#scheduleQueue();
			});
	}

	#scheduleQueue(): void {
		if (
			this.#closed ||
			this.#pump ||
			this.#queuePaused ||
			this.#active ||
			this.#work.isBusy() ||
			this.#deferred.length === 0
		)
			return;
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
		while (!this.#queuePaused && !this.#active && !this.#work.isBusy()) {
			const item = this.#deferred.shift();
			if (!item) return;
			if (item.kind === "external") {
				await item.run();
				continue;
			}
			this.#queuedPromptId = item.id;
			const operation = this.#work.prompt(item.input);
			this.#active = operation;
			try {
				const result = await operation;
				if (result.state !== "succeeded") this.#queuePaused = true;
			} finally {
				if (this.#active === operation) this.#active = undefined;
				this.#queuedPromptId = undefined;
			}
		}
	}

	async #accept(event: AgentEvent): Promise<void> {
		if (event.type === "run_start") {
			if (event.source === "prompt" && this.#pendingPrompt) {
				const pending = this.#pendingPrompt;
				this.#pendingPrompt = undefined;
				await pending.transaction.commit();
			}
			const queuedId =
				event.source === "follow_up" ? this.#deliveredFollowUps.shift() : (this.#queuedPromptId ?? undefined);
			if (queuedId) await this.#options.session.record({ type: "follow_up_consumed", id: queuedId });
		}
		if (event.type === "turn_start" && event.steeringMessages.length > 0) {
			const consumed = this.#pendingSteering.splice(0, event.steeringMessages.length);
			for (const pending of consumed) await pending.transaction.commit();
		}
		if (event.type === "run_end" && this.#pendingSteering.length > 0) {
			const abandoned = this.#pendingSteering.splice(0);
			for (const pending of abandoned) await pending.transaction.rollback();
		}
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

	#resourceReferences(transaction: AttachmentTransaction, fallback: readonly string[]): readonly string[] {
		return transaction.resources ?? fallback;
	}

	#allocateQueueItem(): QueueItemId {
		return `queue_item:${this.#options.allocateId("composer_submission")}` as QueueItemId;
	}

	async #prepareInput(
		text: string,
		attachmentIds: readonly string[],
		kind: ComposerSubmissionKind,
		composerText: string,
		references: readonly ComposerExtensionReference[] = [],
	): Promise<{ readonly input: AgentInput; readonly transaction: AttachmentTransaction }> {
		const input = await this.#options.buildInput(text, attachmentIds, { kind, composerText, references });
		const transaction = await this.#options.prepareAttachments(attachmentIds);
		return { input, transaction };
	}

	#validateFollowUp(input: AgentInput): void {
		const count = this.#deferred.filter(({ kind }) => kind === "follow_up").length + this.#deliveredFollowUps.length;
		if (count >= MAXIMUM_PENDING_FOLLOW_UPS) {
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

	#consumeAcknowledgedFailure(): boolean {
		const acknowledged = this.#acknowledgedFailure;
		this.#acknowledgedFailure = false;
		return acknowledged;
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
