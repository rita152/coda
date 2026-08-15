import { type MarkdownRenderer, sanitizeTerminalText, wrapAnsi } from "@coda/tui";
import { renderRunEvidenceSummary } from "../run-evidence/presentation.ts";
import type { RunEvidenceEnvelope } from "../run-evidence/run-evidence.ts";
import type { ChatAttachment } from "./chat-component.ts";
import {
	actionFooter,
	followUpText,
	type LocalAttachmentHitRegion,
	recoverableStatus,
	renderTimelineEntry,
	renderUserCard,
} from "./chat-rendering.ts";
import type { SemanticTimeline, TimelineEntry } from "./semantic-timeline.ts";
import { renderStatusLine, type StatusLineSnapshot } from "./status-line.ts";
import type { TuiTheme } from "./theme.ts";
import {
	type MainTimelineBlock,
	type MainTimelineContentType,
	spaceMainTimelineBlocks,
	timelineEntryContentType,
} from "./timeline-presentation.ts";
import type { ViewportBlock } from "./timeline-viewport.ts";
import { isExplorationTool, renderExplorationGroup } from "./tool-presentation.ts";

export const IDLE_CTRL_C_CONFIRMATION_WINDOW_MS = 500;

export interface TimelineProvisionalCard {
	readonly id: string;
	readonly kind: "prompt" | "steering" | "follow_up" | "user_shell";
	readonly text: string;
	readonly attachments: readonly ChatAttachment[];
	readonly status?: string;
}

export interface TimelineRecoverableCard {
	readonly item: import("@coda/agent").FollowUp;
	readonly state: "paused" | "failed";
	readonly attachments: readonly ChatAttachment[];
	readonly messageId?: string;
	readonly failure?: string;
}

interface CachedTimelineBlock {
	readonly entry: TimelineEntry;
	readonly width: number;
	readonly transcriptMode: boolean;
	readonly toolResultImagesSupported: boolean;
	readonly attachments?: readonly ChatAttachment[];
	readonly status?: string;
	readonly attachmentFocusKey?: string;
	readonly lines: readonly string[];
	readonly regions: readonly LocalAttachmentHitRegion[];
}

export interface ChatTimelineRendererOptions {
	readonly markdown: MarkdownRenderer;
	readonly theme: TuiTheme;
	readonly motion: "full" | "reduced";
	readonly imagePreviewSupported: boolean;
	readonly toolResultImagesSupported: boolean;
	readonly statusLine: () => StatusLineSnapshot;
}

export interface RenderViewportBlocksInput {
	readonly width: number;
	readonly now: number;
	readonly timeline: SemanticTimeline;
	readonly provisionalCards: readonly TimelineProvisionalCard[];
	readonly recoverableCards: readonly TimelineRecoverableCard[];
	readonly activeFollowUp?: TimelineRecoverableCard;
	readonly messageAttachments: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly transcriptMode: boolean;
	readonly error?: string;
	readonly notice?: string;
	readonly runEvidence?: RunEvidenceEnvelope;
	readonly attachmentFocusKey?: string;
}

export interface RenderFooterInput {
	readonly width: number;
	readonly now: number;
	readonly imageModal: boolean;
	readonly focusedAttachmentSource?: "composer" | "timeline";
	readonly shellMode: boolean;
	readonly unreadUpdates: number;
	readonly transcriptMode: boolean;
	readonly running: boolean;
	readonly hasPausedQueue: boolean;
	readonly shellRunning: boolean;
	readonly lastIdleCtrlCAt?: number;
	readonly modelLabel: string;
	readonly reasoning: string;
}

export class ChatTimelineRenderer {
	readonly #options: ChatTimelineRendererOptions;
	#cachedViewportBlocks?: {
		readonly entries: readonly TimelineEntry[];
		readonly width: number;
		readonly transcriptMode: boolean;
		readonly error?: string;
		readonly notice?: string;
		readonly runEvidence?: RunEvidenceEnvelope;
		readonly attachmentFocusKey?: string;
		readonly blocks: readonly ViewportBlock[];
	};
	#timelineAttachmentHitRegions = new Map<string, readonly LocalAttachmentHitRegion[]>();
	readonly #timelineBlockCache = new Map<string, CachedTimelineBlock>();

	constructor(options: ChatTimelineRendererOptions) {
		this.#options = options;
	}

	resetTimelineCaches(): void {
		this.#timelineBlockCache.clear();
		this.#timelineAttachmentHitRegions.clear();
	}

	attachmentHitRegions(blockId: string): readonly LocalAttachmentHitRegion[] {
		return this.#timelineAttachmentHitRegions.get(blockId) ?? [];
	}

	renderViewportBlocks(input: RenderViewportBlocksInput): readonly ViewportBlock[] {
		const entries = input.timeline.entries;
		const cache = this.#cachedViewportBlocks;
		if (
			!input.timeline.hasActiveTools &&
			input.provisionalCards.length === 0 &&
			input.recoverableCards.length === 0 &&
			!input.activeFollowUp &&
			cache?.entries === entries &&
			cache.width === input.width &&
			cache.transcriptMode === input.transcriptMode &&
			cache.error === input.error &&
			cache.notice === input.notice &&
			cache.runEvidence === input.runEvidence &&
			cache.attachmentFocusKey === input.attachmentFocusKey
		) {
			return cache.blocks;
		}
		this.#timelineAttachmentHitRegions = new Map();
		const presentationBlocks: MainTimelineBlock[] = [];
		const appendBlock = (block: ViewportBlock, contentType: MainTimelineContentType): void => {
			presentationBlocks.push({ ...block, contentType });
		};
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			if (!input.transcriptMode && entry.kind === "tool" && isExplorationTool(entry)) {
				const group = [entry];
				while (index + 1 < entries.length) {
					const candidate = entries[index + 1];
					if (candidate?.kind !== "tool" || !isExplorationTool(candidate) || candidate.turnId !== entry.turnId) {
						break;
					}
					group.push(candidate);
					index++;
				}
				appendBlock(
					{
						id: `exploration:${entry.id}`,
						lines: renderExplorationGroup(group, {
							width: input.width,
							now: input.now,
							transcript: false,
							theme: this.#options.theme,
							motion: this.#options.motion,
						}),
					},
					"exploration",
				);
				continue;
			}
			const recovery =
				entry.kind === "user"
					? (input.recoverableCards.find((card) => card.messageId === entry.messageId) ??
						(input.activeFollowUp?.messageId === entry.messageId ? input.activeFollowUp : undefined))
					: undefined;
			const rendered = this.#renderTimelineBlock(entry, recovery, input);
			this.#timelineAttachmentHitRegions.set(entry.id, rendered.regions);
			appendBlock({ id: entry.id, lines: rendered.lines }, timelineEntryContentType(entry));
		}
		for (const card of input.provisionalCards) {
			const layout = renderUserCard(
				card.text,
				input.width,
				this.#options.theme,
				card.attachments,
				card.status,
				card.id,
				input.attachmentFocusKey,
			);
			this.#timelineAttachmentHitRegions.set(card.id, layout.regions);
			appendBlock({ id: card.id, lines: layout.lines }, card.kind === "user_shell" ? "user_shell" : "user");
		}
		for (const card of input.recoverableCards) {
			if (card.messageId) continue;
			const blockId = `recoverable:${card.item.id}`;
			const layout = renderUserCard(
				followUpText(card.item),
				input.width,
				this.#options.theme,
				card.attachments,
				recoverableStatus(card),
				blockId,
				input.attachmentFocusKey,
			);
			this.#timelineAttachmentHitRegions.set(blockId, layout.regions);
			appendBlock({ id: blockId, lines: layout.lines }, "user");
		}
		if (input.error) {
			appendBlock(
				{
					id: "run-error",
					lines: wrapAnsi(
						this.#options.theme.style("error", `Error: ${sanitizeTerminalText(input.error)}`),
						input.width,
					),
				},
				"error",
			);
		}
		if (input.runEvidence) {
			appendBlock(
				{
					id: `run-evidence:${input.runEvidence.runId}`,
					lines: renderRunEvidenceSummary(input.runEvidence, input.width).map((line) =>
						this.#options.theme.style("muted", line),
					),
				},
				"evidence",
			);
		}
		if (input.notice) {
			appendBlock(
				{
					id: "command-notice",
					lines: wrapAnsi(this.#options.theme.style("success", sanitizeTerminalText(input.notice)), input.width),
				},
				"notice",
			);
		}
		const blocks: readonly ViewportBlock[] = input.transcriptMode
			? presentationBlocks
			: spaceMainTimelineBlocks(presentationBlocks);
		const snapshot = Object.freeze([...blocks]);
		if (
			!input.timeline.hasActiveTools &&
			input.provisionalCards.length === 0 &&
			input.recoverableCards.length === 0 &&
			!input.activeFollowUp
		) {
			this.#cachedViewportBlocks = Object.freeze({
				entries,
				width: input.width,
				transcriptMode: input.transcriptMode,
				error: input.error,
				notice: input.notice,
				runEvidence: input.runEvidence,
				attachmentFocusKey: input.attachmentFocusKey,
				blocks: snapshot,
			});
		}
		return snapshot;
	}

	renderFooter(input: RenderFooterInput): readonly string[] {
		if (input.imageModal) return actionFooter(input.width, ["Image preview • Esc/q closes"]);
		if (input.focusedAttachmentSource) {
			const canDetach = input.focusedAttachmentSource === "composer";
			return this.#options.imagePreviewSupported
				? actionFooter(input.width, [
						`Attachment • Enter expands${canDetach ? " • Delete detaches" : ""} • Tab returns to editor`,
						`Enter expands${canDetach ? " • Delete detaches" : ""} • Tab returns`,
						"Enter expands • Tab returns",
					])
				: actionFooter(input.width, [
						`Attachment • Enter opens system viewer${canDetach ? " • Delete detaches" : ""} • Tab returns to editor`,
						`Enter opens viewer${canDetach ? " • Delete detaches" : ""} • Tab returns`,
						"Enter opens viewer • Tab returns",
					]);
		}
		if (input.shellMode) return actionFooter(input.width, [this.#options.theme.style("error", "Shell mode")]);
		if (input.unreadUpdates > 0) {
			return actionFooter(input.width, [
				`down ${input.unreadUpdates} update${input.unreadUpdates === 1 ? "" : "s"} - Ctrl+End`,
			]);
		}
		if (input.transcriptMode) {
			return actionFooter(input.width, [
				"Transcript • PgUp/PgDn scroll • Esc closes • Ctrl+End latest",
				"Transcript • PgUp/PgDn • Esc closes",
				"Transcript • Esc closes",
			]);
		}
		if (!input.running && input.hasPausedQueue) {
			return actionFooter(input.width, [
				"Paused queue • Enter resumes • Alt+Up edits latest • typing appends",
				"Enter resumes • Alt+Up edits • typing appends",
				"Enter resumes • Alt+Up edits",
			]);
		}
		if (input.shellRunning) {
			return actionFooter(input.width, [
				"Local command running • Enter queues • Alt+Up edits • Ctrl-C cancels",
				"Enter queues • Alt+Up edits • Ctrl-C cancels",
				"Ctrl-C cancels the command",
			]);
		}
		if (
			input.lastIdleCtrlCAt !== undefined &&
			input.now >= input.lastIdleCtrlCAt &&
			input.now - input.lastIdleCtrlCAt < IDLE_CTRL_C_CONFIRMATION_WINDOW_MS
		) {
			return actionFooter(input.width, ["Press Ctrl-C again to exit"]);
		}
		return renderStatusLine(
			this.#options.statusLine(),
			{ modelLabel: input.modelLabel, reasoning: input.reasoning },
			input.width,
			this.#options.theme,
		);
	}

	#renderTimelineBlock(
		entry: TimelineEntry,
		recovery: TimelineRecoverableCard | undefined,
		input: RenderViewportBlocksInput,
	): CachedTimelineBlock {
		const attachments =
			entry.kind === "user"
				? (input.messageAttachments.get(entry.messageId) ?? recovery?.attachments ?? [])
				: undefined;
		const status = recovery
			? input.activeFollowUp === recovery
				? "Running"
				: recoverableStatus(recovery)
			: undefined;
		const attachmentFocusKey = input.attachmentFocusKey?.startsWith(`${entry.id}\u0000`)
			? input.attachmentFocusKey
			: undefined;
		const animated = entry.kind === "tool" && entry.state === "running" && this.#options.motion === "full";
		const cached = this.#timelineBlockCache.get(entry.id);
		if (
			!animated &&
			cached?.entry === entry &&
			cached.width === input.width &&
			cached.transcriptMode === input.transcriptMode &&
			cached.toolResultImagesSupported === this.#options.toolResultImagesSupported &&
			cached.attachments === attachments &&
			cached.status === status &&
			cached.attachmentFocusKey === attachmentFocusKey
		) {
			return cached;
		}
		const layout =
			entry.kind === "user"
				? renderUserCard(
						entry.text,
						input.width,
						this.#options.theme,
						attachments,
						status,
						entry.id,
						attachmentFocusKey,
					)
				: {
						lines: renderTimelineEntry(
							entry,
							input.width,
							input.transcriptMode,
							this.#options.markdown,
							this.#options.theme,
							input.now,
							this.#options.motion,
							this.#options.toolResultImagesSupported,
						),
						regions: [],
					};
		const rendered = Object.freeze({
			entry,
			width: input.width,
			transcriptMode: input.transcriptMode,
			toolResultImagesSupported: this.#options.toolResultImagesSupported,
			attachments,
			status,
			attachmentFocusKey,
			lines: layout.lines,
			regions: layout.regions,
		});
		this.#timelineBlockCache.set(entry.id, rendered);
		return rendered;
	}
}
