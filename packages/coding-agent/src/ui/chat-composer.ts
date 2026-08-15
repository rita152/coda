import type { AgentEvent, FollowUp } from "@coda/agent";
import type { Editor } from "@coda/tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { RecoverableFollowUp } from "../session/types.ts";
import type { ChatAttachmentController } from "./chat-attachments.ts";
import type { ChatAttachment, ChatComponentOptions } from "./chat-component.ts";
import type { CommandFlowHost } from "./command-flow-host.ts";
import type { ComposerHistory } from "./composer-history.ts";
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

export class ChatComposerController {
	readonly #isQueuePaused?: () => boolean;
	readonly #attachments: ChatAttachmentController;
	#shellMode = false;
	#provisionalCards: ProvisionalPromptCard[] = [];
	#recoverableCards: RecoverablePromptCard[] = [];
	#activeFollowUp?: RecoverablePromptCard;
	#nextProvisionalId = 0;

	constructor(input: {
		readonly isQueuePaused?: () => boolean;
		readonly attachments: ChatAttachmentController;
		readonly recoverableFollowUps?: readonly RecoverableFollowUp[];
		readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	}) {
		this.#isQueuePaused = input.isQueuePaused;
		this.#attachments = input.attachments;
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
