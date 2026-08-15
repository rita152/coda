import type { AgentEvent, FollowUp } from "@coda/agent";
import type { Editor, TerminalInput } from "@coda/tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { RecoverableFollowUp } from "../session/types.ts";
import { type ChatAttachmentController, normalizeAttachmentElements } from "./chat-attachments.ts";
import type { ChatAttachment, ChatComponentOptions } from "./chat-component.ts";
import { followUpText, shellActivation } from "./chat-rendering.ts";
import { IDLE_CTRL_C_CONFIRMATION_WINDOW_MS } from "./chat-timeline-renderer.ts";
import type { CommandComposer } from "./command-composer.ts";
import type { CommandFlowHost } from "./command-flow-host.ts";
import type { ComposerHistory } from "./composer-history.ts";
import { extensionReferencesFromMarkers } from "./extension-references.ts";
import type { UserShellSubmission } from "./input-types.ts";
import type { UserShellSnapshot } from "./user-shell.ts";

export interface ProvisionalPromptCard {
	readonly id: string;
	readonly kind: "prompt" | "steering" | "follow_up" | "user_shell";
	readonly text: string;
	readonly attachments: readonly ChatAttachment[];
	readonly queueItemId?: string;
	readonly status?: string;
}

export interface RecoverablePromptCard {
	readonly item: FollowUp;
	readonly state: "paused" | "failed";
	readonly attachments: readonly ChatAttachment[];
	readonly messageId?: string;
	readonly failure?: string;
}

export interface ChatComposerView {
	readonly shellMode: boolean;
	readonly hasPausedQueue: boolean;
	readonly provisionalCards: readonly ProvisionalPromptCard[];
	readonly recoverableCards: readonly RecoverablePromptCard[];
	readonly activeFollowUp?: RecoverablePromptCard;
}

export type ChatComposerProjection =
	| { readonly type: "before_agent_event"; readonly event: AgentEvent }
	| { readonly type: "after_agent_event"; readonly event: AgentEvent }
	| { readonly type: "user_shell"; readonly snapshot: UserShellSnapshot }
	| { readonly type: "resynchronize" };

export type ChatComposerMutation =
	| {
			readonly type: "create_provisional";
			readonly kind: ProvisionalPromptCard["kind"];
			readonly text: string;
			readonly attachments: readonly ChatAttachment[];
			readonly status?: string;
	  }
	| { readonly type: "remove_provisional"; readonly id: string }
	| { readonly type: "remove_recoverable"; readonly card: RecoverablePromptCard }
	| { readonly type: "set_queue_item"; readonly id: string; readonly queueItemId: string }
	| { readonly type: "set_shell_mode"; readonly value: boolean };

export interface ChatComposerHostView {
	readonly running: boolean;
	readonly agentRunning: boolean;
	readonly shellRunning: boolean;
	readonly lastIdleCtrlCAt?: number;
}

export type ChatComposerHostMutation =
	| { readonly type: "begin_agent_preparation" }
	| { readonly type: "cancel_agent_preparation" }
	| { readonly type: "set_error"; readonly value: string | undefined }
	| { readonly type: "set_notice"; readonly value: string | undefined }
	| { readonly type: "set_idle_ctrl_c"; readonly value: number | undefined }
	| { readonly type: "jump_to_end" }
	| { readonly type: "invalidate" };

export interface ChatComposerHost {
	view(): ChatComposerHostView;
	mutate(mutation: ChatComposerHostMutation): void;
}

export function isRunCancellationInput(input: TerminalInput): boolean {
	return (
		input.type === "key" &&
		input.action !== "release" &&
		((input.control && input.key === "c") || input.key === "escape")
	);
}

export class ChatComposerController {
	readonly #isQueuePaused?: () => boolean;
	readonly #attachments: ChatAttachmentController;
	readonly #editor: Editor;
	readonly #commands: CommandComposer;
	readonly #flow: CommandFlowHost;
	readonly #history: ComposerHistory;
	readonly #options: ChatComponentOptions;
	readonly #host: ChatComposerHost;
	#shellMode = false;
	#provisionalCards: ProvisionalPromptCard[] = [];
	#recoverableCards: RecoverablePromptCard[] = [];
	#activeFollowUp?: RecoverablePromptCard;
	#nextProvisionalId = 0;

	constructor(input: {
		readonly isQueuePaused?: () => boolean;
		readonly attachments: ChatAttachmentController;
		readonly editor: Editor;
		readonly commands: CommandComposer;
		readonly flow: CommandFlowHost;
		readonly history: ComposerHistory;
		readonly options: ChatComponentOptions;
		readonly host: ChatComposerHost;
		readonly recoverableFollowUps?: readonly RecoverableFollowUp[];
		readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	}) {
		this.#isQueuePaused = input.isQueuePaused;
		this.#attachments = input.attachments;
		this.#editor = input.editor;
		this.#commands = input.commands;
		this.#flow = input.flow;
		this.#history = input.history;
		this.#options = input.options;
		this.#host = input.host;
		this.#recoverableCards = (input.recoverableFollowUps ?? []).map((recoverable) =>
			Object.freeze({
				item: recoverable.item,
				state: recoverable.state,
				attachments: Object.freeze([...(input.restoredAttachments?.get(recoverable.item.id) ?? [])]),
				...(recoverable.messageId ? { messageId: recoverable.messageId } : {}),
				...(recoverable.failure ? { failure: recoverable.failure.message } : {}),
			}),
		);
	}

	view(): ChatComposerView {
		return {
			shellMode: this.#shellMode,
			hasPausedQueue: this.#isQueuePaused?.() ?? this.#recoverableCards.some((card) => card.state === "paused"),
			provisionalCards: this.#provisionalCards,
			recoverableCards: this.#recoverableCards,
			...(this.#activeFollowUp ? { activeFollowUp: this.#activeFollowUp } : {}),
		};
	}

	mutate(mutation: ChatComposerMutation): ProvisionalPromptCard | undefined {
		switch (mutation.type) {
			case "create_provisional": {
				const provisional: ProvisionalPromptCard = Object.freeze({
					id: `provisional:${++this.#nextProvisionalId}`,
					kind: mutation.kind,
					text: mutation.text,
					attachments: Object.freeze(mutation.attachments),
					status: mutation.status,
				});
				this.#provisionalCards.push(provisional);
				return provisional;
			}
			case "remove_provisional":
				this.#provisionalCards = this.#provisionalCards.filter((card) => card.id !== mutation.id);
				return undefined;
			case "remove_recoverable":
				this.#recoverableCards = this.#recoverableCards.filter((card) => card !== mutation.card);
				return undefined;
			case "set_queue_item":
				this.#provisionalCards = this.#provisionalCards.map((card) =>
					card.id === mutation.id ? Object.freeze({ ...card, queueItemId: mutation.queueItemId }) : card,
				);
				return undefined;
			case "set_shell_mode":
				this.#shellMode = mutation.value;
				return undefined;
		}
	}

	project(projection: ChatComposerProjection): void {
		switch (projection.type) {
			case "resynchronize":
				this.#activeFollowUp = undefined;
				this.#provisionalCards = [];
				return;
			case "user_shell":
				if (projection.snapshot.status === "running") this.#removeRunningUserShell(projection.snapshot.id);
				return;
			case "before_agent_event":
				this.#beforeAgentEvent(projection.event);
				return;
			case "after_agent_event":
				this.#afterAgentEvent(projection.event);
				return;
		}
	}

	handleInput(input: TerminalInput, stagedAttachmentCount: number): void {
		if (input.type === "key" && input.action === "release") return;
		const hostView = this.#host.view();
		if (input.type === "key" && input.alt && input.key === "up") {
			void this.#reclaimLatestQueuedInput();
			return;
		}
		if (isRunCancellationInput(input)) {
			if (hostView.shellRunning) {
				this.#options.onAbortUserShell?.();
				return;
			}
			if (hostView.agentRunning) {
				this.#options.onAbort();
				return;
			}
		}
		if (input.type === "key" && input.control && input.key === "c") {
			if (this.#shellMode || this.#editor.text.length > 0) {
				this.#editor.clear();
				this.#shellMode = false;
				this.#attachments.restoreInlineElements();
				this.#history.reset();
				this.#host.mutate({ type: "invalidate" });
			} else if (input.action === "press") {
				const now = this.#options.clock.now();
				const previous = hostView.lastIdleCtrlCAt;
				if (previous !== undefined && now >= previous && now - previous <= IDLE_CTRL_C_CONFIRMATION_WINDOW_MS) {
					this.#host.mutate({ type: "set_idle_ctrl_c", value: undefined });
					this.#options.onExit();
				} else {
					this.#host.mutate({ type: "set_idle_ctrl_c", value: now });
					this.#host.mutate({ type: "invalidate" });
				}
			}
			return;
		}
		if (input.type === "key" && input.key === "escape") {
			if (this.#shellMode) {
				if (this.#editor.text.trim().length === 0) {
					this.#shellMode = false;
					this.#attachments.restoreInlineElements();
					this.#host.mutate({ type: "set_error", value: undefined });
					this.#host.mutate({ type: "invalidate" });
				}
				return;
			}
			return;
		}
		if (
			input.type === "key" &&
			input.control &&
			input.key === "d" &&
			!this.#shellMode &&
			!hostView.running &&
			this.#editor.text.length === 0
		) {
			this.#options.onExit();
			return;
		}
		if (
			!this.#shellMode &&
			input.type === "key" &&
			(input.key === "up" || input.key === "down") &&
			!input.control &&
			!input.alt &&
			!input.meta &&
			this.#history.navigate(input.key === "up" ? -1 : 1, this.#editor)
		) {
			this.#host.mutate({ type: "invalidate" });
			return;
		}

		let editorInput: TerminalInput = input;
		if (!this.#shellMode && (this.#editor.text.length === 0 || this.#attachments.hasOnlyInlineElements())) {
			const activation = shellActivation(input);
			if (activation) {
				this.#attachments.suspendInlineElements();
				this.#shellMode = true;
				this.#history.reset();
				this.#host.mutate({ type: "set_error", value: undefined });
				if (!activation.remainder) {
					this.#host.mutate({ type: "invalidate" });
					return;
				}
				editorInput = activation.remainder;
			}
		}
		if (this.#shellMode && editorInput.type === "key" && editorInput.key === "backspace") {
			const before = this.#editor.text;
			const result = this.#editor.handleInput(editorInput);
			if (result.type === "handled" && this.#editor.text === before) {
				this.#shellMode = false;
				this.#attachments.restoreInlineElements();
				this.#host.mutate({ type: "set_error", value: undefined });
			} else if (this.#editor.text !== before) {
				this.#host.mutate({ type: "set_error", value: undefined });
			}
			this.#host.mutate({ type: "invalidate" });
			return;
		}
		const before = this.#editor.text;
		const editorResult = this.#editor.handleInput(editorInput);
		if (editorResult.type === "handled") {
			if (!this.#shellMode && this.#editor.absorbPrefix("!")) {
				this.#shellMode = true;
				this.#history.reset();
				this.#host.mutate({ type: "set_error", value: undefined });
			} else if (this.#editor.text !== before) {
				this.#history.noteTextMutation();
				if (this.#shellMode) this.#host.mutate({ type: "set_error", value: undefined });
			}
			this.#host.mutate({ type: "invalidate" });
			return;
		}
		if (editorResult.type !== "submit") return;
		const displayText = editorResult.text.trim();
		const normalized = normalizeAttachmentElements(displayText, editorResult.markers ?? []);
		const value = normalized.text;
		const extensionReferences = extensionReferencesFromMarkers(normalized.markers);
		if (this.#shellMode) {
			if (!value) {
				this.#host.mutate({
					type: "set_error",
					value: "Prefix a command with ! to run it locally. Example: !ls",
				});
				this.#host.mutate({ type: "invalidate" });
				return;
			}
			this.#submitUserShell(value);
			return;
		}
		const commandInvocation = this.#commands.resolveSubmission(value);
		if (commandInvocation && commandInvocation.command.id !== "core:follow-up") {
			this.invokeCommand(commandInvocation.command, commandInvocation.argument);
			return;
		}
		if (value.length === 0 && stagedAttachmentCount === 0 && this.view().hasPausedQueue) {
			if (!this.#options.onResumeFollowUps) {
				this.#host.mutate({ type: "set_error", value: "Follow-up recovery is unavailable" });
				this.#host.mutate({ type: "invalidate" });
				return;
			}
			this.#host.mutate({ type: "begin_agent_preparation" });
			this.#host.mutate({ type: "set_error", value: undefined });
			try {
				const operation = Promise.resolve(this.#options.onResumeFollowUps());
				void operation.catch((error: unknown) => {
					this.#host.mutate({ type: "cancel_agent_preparation" });
					this.#host.mutate({
						type: "set_error",
						value: error instanceof Error ? error.message : String(error),
					});
					this.#host.mutate({ type: "invalidate" });
				});
			} catch (error) {
				this.#host.mutate({ type: "cancel_agent_preparation" });
				this.#host.mutate({
					type: "set_error",
					value: error instanceof Error ? error.message : String(error),
				});
			}
			this.#host.mutate({ type: "invalidate" });
			return;
		}
		if (extensionReferences.length > 0 && !this.#options.onResolveExtensionReferences) {
			this.#host.mutate({ type: "set_error", value: "Skill/MCP extension loading is unavailable" });
			this.#host.mutate({ type: "invalidate" });
			return;
		}
		const composerText = value;
		let submissionText = value.startsWith("\\!") ? value.slice(1) : value;
		let provisionalText = displayText.startsWith("\\!") ? displayText.slice(1) : displayText;
		const appendsPausedQueue = !hostView.agentRunning && this.view().hasPausedQueue;
		let kind: Exclude<ProvisionalPromptCard["kind"], "user_shell"> = hostView.agentRunning
			? editorResult.alternate
				? "follow_up"
				: "steering"
			: hostView.shellRunning
				? "follow_up"
				: appendsPausedQueue
					? "follow_up"
					: "prompt";
		if (hostView.agentRunning && /^\/follow-up\s+/iu.test(submissionText) && !submissionText.includes("\n")) {
			kind = "follow_up";
			submissionText = submissionText.replace(/^\/follow-up\s+/iu, "").trim();
			provisionalText = provisionalText.replace(/^\/follow-up\s+/iu, "").trim();
		}
		if (submissionText.length === 0 && stagedAttachmentCount === 0) return;
		const submittedAttachments = this.#attachments.mutate({
			type: "take_submission",
			prompt: kind === "prompt",
		})!;
		const submittedComposerState = this.#editor.captureState();
		const provisional = this.mutate({
			type: "create_provisional",
			kind,
			text: provisionalText,
			attachments: submittedAttachments,
			status: kind === "steering" ? "Steering queued" : kind === "follow_up" ? "Follow-up queued" : undefined,
		})!;
		this.#editor.clear();
		this.#history.reset();
		this.#host.mutate({ type: "set_error", value: undefined });
		this.#host.mutate({ type: "set_notice", value: undefined });
		if (!hostView.running && kind === "prompt") this.#host.mutate({ type: "begin_agent_preparation" });
		this.#host.mutate({ type: "jump_to_end" });
		this.#host.mutate({ type: "invalidate" });
		const attachmentIds = submittedAttachments.map((attachment) => attachment.id);
		const submitAccepted = () => {
			try {
				if (kind === "steering") {
					if (!this.#options.onSteer) throw new Error("Steering is unavailable");
					return Promise.resolve(
						extensionReferences.length > 0
							? this.#options.onSteer(submissionText, attachmentIds, composerText, extensionReferences)
							: composerText === submissionText
								? this.#options.onSteer(submissionText, attachmentIds)
								: this.#options.onSteer(submissionText, attachmentIds, composerText),
					);
				}
				if (kind === "follow_up" && !appendsPausedQueue) {
					if (!this.#options.onFollowUp) throw new Error("Follow-up is unavailable");
					return Promise.resolve(
						extensionReferences.length > 0
							? this.#options.onFollowUp(submissionText, attachmentIds, composerText, extensionReferences)
							: composerText === submissionText
								? this.#options.onFollowUp(submissionText, attachmentIds)
								: this.#options.onFollowUp(submissionText, attachmentIds, composerText),
					);
				}
				return Promise.resolve(
					extensionReferences.length > 0
						? this.#options.onSubmit(submissionText, attachmentIds, composerText, extensionReferences)
						: composerText === submissionText
							? this.#options.onSubmit(submissionText, attachmentIds)
							: this.#options.onSubmit(submissionText, attachmentIds, composerText),
				);
			} catch (error) {
				return Promise.reject(error);
			}
		};
		const operation = (() => {
			if (extensionReferences.length === 0) return submitAccepted();
			try {
				return Promise.resolve(this.#options.onResolveExtensionReferences!(extensionReferences, composerText)).then(
					submitAccepted,
				);
			} catch (error) {
				return Promise.reject(error);
			}
		})();
		void operation.then(
			(result) => {
				if (typeof result === "object") this.#history.record(result);
				const queueItemId = typeof result === "string" ? result : result?.queueItemId;
				if (kind !== "prompt" && typeof queueItemId === "string") {
					this.mutate({ type: "set_queue_item", id: provisional.id, queueItemId });
				}
				this.#host.mutate({ type: "invalidate" });
			},
			(error: unknown) => {
				if (kind === "prompt" || appendsPausedQueue) this.#host.mutate({ type: "cancel_agent_preparation" });
				this.mutate({ type: "remove_provisional", id: provisional.id });
				this.#attachments.mutate({ type: "restore_submission", attachments: submittedAttachments });
				if (!this.#editor.text) this.#editor.restoreState(submittedComposerState);
				this.#host.mutate({
					type: "set_error",
					value: error instanceof Error ? error.message : String(error),
				});
				this.#host.mutate({ type: "invalidate" });
			},
		);
	}

	invokeCommand(command: CommandDefinition, argument?: string): void {
		invokeChatCommand({
			command,
			...(argument === undefined ? {} : { argument }),
			editor: this.#editor,
			history: this.#history,
			flow: this.#flow,
			onCommand: this.#options.onCommand,
			setError: (value) => {
				this.#host.mutate({ type: "set_error", value });
			},
			setNotice: (value) => {
				this.#host.mutate({ type: "set_notice", value });
			},
			invalidate: () => this.#host.mutate({ type: "invalidate" }),
		});
	}

	#submitUserShell(command: string): void {
		const provisional = this.mutate({
			type: "create_provisional",
			kind: "user_shell",
			text: `!${command}`,
			attachments: [],
			status: "Shell queued",
		})!;
		this.#editor.clear();
		this.#shellMode = false;
		this.#attachments.restoreInlineElements();
		this.#history.reset();
		this.#host.mutate({ type: "set_error", value: undefined });
		this.#host.mutate({ type: "jump_to_end" });
		this.#host.mutate({ type: "invalidate" });
		let operation: Promise<UserShellSubmission>;
		try {
			if (!this.#options.onUserShell) throw new Error("Local Shell mode is unavailable");
			operation = Promise.resolve(this.#options.onUserShell(command));
		} catch (error) {
			operation = Promise.reject(error);
		}
		void operation.then(
			(submission) => {
				this.mutate({ type: "set_queue_item", id: provisional.id, queueItemId: submission.id });
				this.#host.mutate({ type: "invalidate" });
			},
			(error: unknown) => {
				this.mutate({ type: "remove_provisional", id: provisional.id });
				this.#attachments.suspendInlineElements();
				if (!this.#editor.text) this.#editor.setText(command);
				this.#shellMode = true;
				this.#host.mutate({
					type: "set_error",
					value: error instanceof Error ? error.message : String(error),
				});
				this.#host.mutate({ type: "invalidate" });
			},
		);
	}

	async #reclaimLatestQueuedInput(): Promise<void> {
		const provisional = [...this.#provisionalCards]
			.reverse()
			.find((card) => card.kind === "follow_up" || card.kind === "user_shell");
		if (provisional && !provisional.queueItemId) return;
		const recoverable = provisional ? undefined : this.#recoverableCards.at(-1);
		const queueItemId = provisional?.queueItemId ?? recoverable?.item.id;
		if (!queueItemId) return;
		try {
			if (provisional?.kind === "user_shell") {
				if (!this.#options.onReclaimUserShell) throw new Error("Local Shell queue recovery is unavailable");
				await this.#options.onReclaimUserShell(queueItemId);
			} else {
				if (!this.#options.onReclaimFollowUp) throw new Error("Follow-up recovery is unavailable");
				await this.#options.onReclaimFollowUp(queueItemId);
				this.#history.retractByQueueItemId(queueItemId);
			}
			const text =
				provisional?.kind === "user_shell"
					? provisional.text.slice(1)
					: (provisional?.text ?? (recoverable ? followUpText(recoverable.item) : ""));
			const attachments = provisional?.attachments ?? recoverable?.attachments ?? [];
			if (provisional) {
				this.mutate({ type: "remove_provisional", id: provisional.id });
			} else if (recoverable) {
				this.mutate({ type: "remove_recoverable", card: recoverable });
			}
			if (provisional?.kind === "user_shell") this.#attachments.suspendInlineElements();
			this.#editor.setText(text);
			this.#history.reset();
			this.#shellMode = provisional?.kind === "user_shell";
			this.#attachments.mutate({ type: "reclaim", attachments });
			this.#host.mutate({ type: "set_error", value: undefined });
		} catch (error) {
			this.#host.mutate({
				type: "set_error",
				value: error instanceof Error ? error.message : String(error),
			});
		}
		this.#host.mutate({ type: "invalidate" });
	}

	#beforeAgentEvent(event: AgentEvent): void {
		if (event.type === "run_start") {
			const exactIndex = this.#provisionalCards.findIndex((card) =>
				event.source === "follow_up" ? card.queueItemId === event.queueItemId : card.kind === "prompt",
			);
			const index =
				exactIndex >= 0 ? exactIndex : this.#provisionalCards.findIndex((card) => card.kind === "follow_up");
			let provisional: ProvisionalPromptCard | undefined;
			if (index >= 0) {
				[provisional] = this.#provisionalCards.splice(index, 1);
				if (event.source === "follow_up" && provisional && provisional.attachments.length > 0) {
					this.#attachments.mutate({
						type: "associate_message",
						messageId: event.inputMessage.id,
						attachments: provisional.attachments,
					});
				}
			}
			if (event.source === "follow_up" && event.queueItemId) {
				const recoveryIndex = this.#recoverableCards.findIndex((card) => card.item.id === event.queueItemId);
				const recovered = recoveryIndex >= 0 ? this.#recoverableCards.splice(recoveryIndex, 1)[0] : undefined;
				const active = provisional
					? {
							item: { id: event.queueItemId, content: provisional.text },
							state: "paused" as const,
							attachments: provisional.attachments,
							messageId: event.inputMessage.id,
						}
					: recovered
						? { ...recovered, messageId: event.inputMessage.id }
						: undefined;
				if (active) {
					this.#activeFollowUp = Object.freeze(active);
					if (active.attachments.length > 0) {
						this.#attachments.mutate({
							type: "associate_message",
							messageId: event.inputMessage.id,
							attachments: active.attachments,
						});
					}
				}
			}
		}
		if (event.type === "turn_start") {
			for (const message of event.steeringMessages) {
				const index = this.#provisionalCards.findIndex((card) => card.kind === "steering");
				if (index < 0) break;
				const [card] = this.#provisionalCards.splice(index, 1);
				if (card && card.attachments.length > 0) {
					this.#attachments.mutate({
						type: "associate_message",
						messageId: message.id,
						attachments: card.attachments,
					});
				}
			}
		}
	}

	#afterAgentEvent(event: AgentEvent): void {
		if (event.type !== "run_end") return;
		if (this.#activeFollowUp) {
			if (event.outcome !== "success") {
				this.#recoverableCards.push(
					Object.freeze({
						...this.#activeFollowUp,
						state: event.outcome === "error" ? "failed" : "paused",
						...(event.failure?.message ? { failure: event.failure.message } : {}),
					}),
				);
			}
			this.#activeFollowUp = undefined;
		}
		if (event.outcome === "success") return;
		const paused = this.#provisionalCards.filter(
			(card) => card.kind === "follow_up" && card.queueItemId !== undefined,
		);
		for (const card of paused) {
			this.#recoverableCards.push(
				Object.freeze({
					item: { id: card.queueItemId as FollowUp["id"], content: card.text },
					state: "paused",
					attachments: card.attachments,
				}),
			);
		}
		const pausedIds = new Set(paused.map(({ id }) => id));
		this.#provisionalCards = this.#provisionalCards.filter((card) => !pausedIds.has(card.id));
	}

	#removeRunningUserShell(id: string): void {
		const exact = this.#provisionalCards.findIndex((card) => card.kind === "user_shell" && card.queueItemId === id);
		const index =
			exact >= 0
				? exact
				: this.#provisionalCards.findIndex((card) => card.kind === "user_shell" && card.queueItemId === undefined);
		if (index >= 0) this.#provisionalCards.splice(index, 1);
	}
}

export function invokeChatCommand(input: {
	readonly command: CommandDefinition;
	readonly argument?: string;
	readonly editor: Editor;
	readonly history: ComposerHistory;
	readonly flow: CommandFlowHost;
	readonly onCommand: ChatComponentOptions["onCommand"];
	readonly setError: (value: string | undefined) => void;
	readonly setNotice: (value: string | undefined) => void;
	readonly invalidate: () => void;
}): void {
	input.editor.clear();
	input.history.reset();
	input.setError(undefined);
	input.setNotice(undefined);
	const operation = (() => {
		try {
			if (!input.onCommand) throw new Error(`${input.command.title} is unavailable`);
			return Promise.resolve(
				input.argument === undefined
					? input.onCommand(input.command.id, input.flow)
					: input.onCommand(input.command.id, input.flow, input.argument),
			);
		} catch (error) {
			return Promise.reject(error);
		}
	})();
	void operation.then(
		(notice) => {
			input.setNotice(notice || undefined);
			input.invalidate();
		},
		(error: unknown) => {
			input.setNotice(undefined);
			input.setError(error instanceof Error ? error.message : String(error));
			input.invalidate();
		},
	);
	input.invalidate();
}
