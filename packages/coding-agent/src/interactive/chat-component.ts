import type { AgentEvent, AgentSeed, FollowUp } from "@coda/agent";
import {
	type Clock,
	type ColorLevel,
	Component,
	type ComponentInputContext,
	type CursorPlacement,
	clipAnsi,
	createMarkdownRenderer,
	displayWidth,
	Editor,
	type ImagePlacement,
	type MarkdownRenderer,
	type RenderContext,
	sanitizeTerminalText,
	sliceAnsi,
	type TerminalAppearance,
	type TerminalInput,
	wrapAnsi,
} from "@coda/tui";
import { createCoreCommandRegistry } from "../commands/core-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { CommandDefinition } from "../commands/types.ts";
import { renderRunEvidenceSummary } from "../run-evidence/presentation.ts";
import type { RunEvidenceEnvelope } from "../run-evidence/run-evidence.ts";
import type { ComposerExtensionReference, ComposerSubmission } from "../session/composer-submission.ts";
import type { RecoverableFollowUp, SessionToolLifecycle } from "../session/types.ts";
import { renderVisibleUserText } from "../skills/context.ts";
import { ActivityProjection, type ActivitySummaryMode } from "./activity-status.ts";
import { renderActivityStatus } from "./activity-status-presentation.ts";
import { CommandComposer, renderCommandPalette } from "./command-composer.ts";
import { CommandFlowHost, type CommandFlowScreen, renderCommandFlow } from "./command-flow-host.ts";
import { ComposerHistory } from "./composer-history.ts";
import { extensionReferencesFromMarkers } from "./extension-references.ts";
import type { UserShellSubmission } from "./input-types.ts";
import { SemanticTimeline, type TimelineEntry } from "./semantic-timeline.ts";
import { renderStatusLine, type StatusLineSnapshot } from "./status-line.ts";
import { createCodaTheme, type TuiTheme } from "./theme.ts";
import {
	type MainTimelineBlock,
	type MainTimelineContentType,
	spaceMainTimelineBlocks,
	timelineEntryContentType,
} from "./timeline-presentation.ts";
import { TimelineViewport, type ViewportBlock } from "./timeline-viewport.ts";
import { isExplorationTool, renderExplorationGroup, renderToolInvocation } from "./tool-presentation.ts";
import type { UserShellSnapshot } from "./user-shell.ts";
import { renderUserShellEntry } from "./user-shell-presentation.ts";

const MINIMUM_COLUMNS = 40;
const MINIMUM_ROWS = 10;
const IDLE_CTRL_C_CONFIRMATION_WINDOW_MS = 500;

export interface ChatAttachmentPreview {
	readonly png: Uint8Array;
	readonly generation: string;
	readonly width: number;
	readonly height: number;
}

export interface ChatAttachment {
	readonly id: string;
	readonly filename: string;
	readonly mimeType: string;
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	readonly preview?: ChatAttachmentPreview;
}

export interface ChatComponentOptions {
	readonly modelLabel: string;
	readonly reasoning: string;
	readonly clock: Clock;
	readonly statusLine: () => StatusLineSnapshot;
	readonly onSubmit: (
		input: string,
		attachmentIds: readonly string[],
		composerText?: string,
		references?: readonly ComposerExtensionReference[],
	) => Promise<ComposerSubmission | string | undefined> | ComposerSubmission | string | undefined;
	readonly onSteer?: (
		input: string,
		attachmentIds: readonly string[],
		composerText?: string,
		references?: readonly ComposerExtensionReference[],
	) => Promise<ComposerSubmission | string> | ComposerSubmission | string;
	readonly onFollowUp?: (
		input: string,
		attachmentIds: readonly string[],
		composerText?: string,
		references?: readonly ComposerExtensionReference[],
	) => Promise<ComposerSubmission | string> | ComposerSubmission | string;
	readonly onResolveExtensionReferences?: (
		references: readonly ComposerExtensionReference[],
		composerText: string,
	) => Promise<void> | void;
	readonly onUserShell?: (command: string) => Promise<UserShellSubmission> | UserShellSubmission;
	readonly onReclaimUserShell?: (id: string) => Promise<void> | void;
	readonly onAbortUserShell?: () => void;
	readonly onDetach?: (attachmentId: string) => Promise<void>;
	readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
	readonly onResumeFollowUps?: () => Promise<void> | void;
	/** Reads the controller-owned mixed Follow-up/User Shell queue state. */
	readonly isQueuePaused?: () => boolean;
	readonly onReclaimFollowUp?: (queueItemId: string) => Promise<void> | void;
	readonly imagePreviewSupported?: boolean;
	readonly initialAttachments?: readonly ChatAttachment[];
	readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly recoverableFollowUps?: readonly RecoverableFollowUp[];
	readonly toolResultImagesSupported?: boolean;
	readonly onAbort: () => void;
	readonly onExit: () => void;
	readonly seed?: AgentSeed;
	readonly composerSubmissions?: readonly ComposerSubmission[];
	readonly restoredToolInvocations?: readonly SessionToolLifecycle[];
	readonly markdownRenderer?: MarkdownRenderer;
	readonly colorLevel?: ColorLevel;
	readonly appearance?: TerminalAppearance;
	readonly motion?: "full" | "reduced";
	readonly activitySummaryMode?: ActivitySummaryMode;
	readonly commandRegistry?: CommandRegistry;
	readonly onCommand?: (
		commandId: string,
		flow: CommandFlowHost,
		argument?: string,
		// biome-ignore lint/suspicious/noConfusingVoidType: Existing command handlers may synchronously return void.
	) => Promise<string | undefined> | string | void;
}

interface ProvisionalPromptCard {
	readonly id: string;
	readonly kind: "prompt" | "steering" | "follow_up" | "user_shell";
	readonly text: string;
	readonly attachments: readonly ChatAttachment[];
	readonly queueItemId?: string;
	readonly status?: string;
}

interface RecoverablePromptCard {
	readonly item: FollowUp;
	readonly state: "paused" | "failed";
	readonly attachments: readonly ChatAttachment[];
	readonly messageId?: string;
	readonly failure?: string;
}

interface AttachmentTarget {
	readonly key: string;
	readonly source: "composer" | "timeline";
	readonly attachment: ChatAttachment;
	readonly composerIndex?: number;
}

interface AttachmentHitRegion {
	readonly targetKey: string;
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

interface LocalAttachmentHitRegion extends Omit<AttachmentHitRegion, "row"> {
	readonly row: number;
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

export class ChatComponent extends Component {
	readonly #options: ChatComponentOptions;
	readonly #timeline: SemanticTimeline;
	readonly #activity: ActivityProjection;
	readonly #markdown: MarkdownRenderer;
	readonly #theme: TuiTheme;
	readonly #viewport = new TimelineViewport();
	#lastViewportBlocks: readonly ViewportBlock[] = [];
	#lastViewportHeight = 0;
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
	readonly #editor = new Editor();
	readonly #commands: CommandComposer;
	readonly #commandFlow: CommandFlowHost;
	readonly #history: ComposerHistory;
	#lastCursor?: CursorPlacement;
	#lastDockRows = 5;
	#running = false;
	#shellRunning = false;
	#shellMode = false;
	#transcriptMode = false;
	#lastIdleCtrlCAt?: number;
	#error?: string;
	#notice?: string;
	#runEvidence?: RunEvidenceEnvelope;
	#attachments: ChatAttachment[] = [];
	#attachmentFocusKey?: string;
	#attachmentFocusOrigin?: "keyboard" | "mouse";
	#attachmentHitRegions: AttachmentHitRegion[] = [];
	#timelineAttachmentHitRegions = new Map<string, readonly LocalAttachmentHitRegion[]>();
	readonly #timelineBlockCache = new Map<string, CachedTimelineBlock>();
	#imageModal = false;
	#nextRunAttachments?: readonly ChatAttachment[];
	readonly #messageAttachments = new Map<string, readonly ChatAttachment[]>();
	#provisionalCards: ProvisionalPromptCard[] = [];
	#recoverableCards: RecoverablePromptCard[] = [];
	#activeFollowUp?: RecoverablePromptCard;
	#nextProvisionalId = 0;
	#modelLabel: string;
	#reasoning: string;

	constructor(options: ChatComponentOptions) {
		super({ focusable: true });
		this.#options = options;
		this.#timeline = new SemanticTimeline(options.seed, options.restoredToolInvocations);
		this.#activity = new ActivityProjection(options.activitySummaryMode);
		this.#history = new ComposerHistory(options.composerSubmissions);
		this.#theme = createCodaTheme(options.colorLevel ?? 0, options.appearance);
		this.#commands = new CommandComposer(options.commandRegistry ?? createCoreCommandRegistry(), this.#editor, {
			isAvailable: (command) => command.id !== "core:follow-up" || this.#running,
		});
		this.#commandFlow = new CommandFlowHost({
			onChange: () => this.invalidate(),
			onError: (error) => {
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
			},
		});
		this.#modelLabel = options.modelLabel;
		this.#reasoning = options.reasoning;
		this.#markdown = options.markdownRenderer ?? createMarkdownRenderer({ colorLevel: options.colorLevel ?? 0 });
		this.#nextRunAttachments = options.initialAttachments;
		for (const [messageId, attachments] of options.restoredAttachments ?? []) {
			this.#messageAttachments.set(messageId, [...attachments]);
		}
		this.#recoverableCards = (options.recoverableFollowUps ?? []).map((recoverable) =>
			Object.freeze({
				item: recoverable.item,
				state: recoverable.state,
				attachments: Object.freeze([...(options.restoredAttachments?.get(recoverable.item.id) ?? [])]),
				...(recoverable.messageId ? { messageId: recoverable.messageId } : {}),
				...(recoverable.failure ? { failure: recoverable.failure.message } : {}),
			}),
		);
	}

	get running(): boolean {
		return this.#running || this.#shellRunning;
	}

	setModelPresentation(modelLabel: string, reasoning: string, activitySummaryMode?: ActivitySummaryMode): void {
		this.#modelLabel = modelLabel;
		this.#reasoning = reasoning;
		if (activitySummaryMode) this.#activity.setSummaryMode(activitySummaryMode);
		this.invalidate();
	}

	setReasoning(reasoning: string): void {
		this.#reasoning = reasoning;
		this.invalidate();
	}

	openCommandFlow(screen: CommandFlowScreen): void {
		this.#commandFlow.open(screen);
	}

	insertSkillReference(commandId: string): void {
		this.#commands.insertSkillReference(commandId);
		this.#history.noteTextMutation();
		this.#error = undefined;
		this.invalidate();
	}

	stageAttachment(attachment: ChatAttachment): void {
		if (this.#attachments.some(({ id }) => id === attachment.id)) {
			throw new Error(`Attachment is already staged: ${attachment.id}`);
		}
		this.#attachments.push(attachment);
		this.#attachmentFocusKey = undefined;
		this.#attachmentFocusOrigin = undefined;
		this.#error = undefined;
		this.invalidate();
	}

	override animationInterval(context: RenderContext): number | undefined {
		if (context.width < MINIMUM_COLUMNS || context.height < MINIMUM_ROWS) return undefined;
		const intervals: number[] = [];
		const activity = this.#activity.status(context.now);
		if (activity) {
			intervals.push(1_000);
			if (
				(this.#options.motion ?? "full") === "full" &&
				activity.motion === "active" &&
				this.#theme.colorLevel > 0
			) {
				intervals.push(32);
			}
		}
		if (
			(this.#options.motion ?? "full") === "full" &&
			activity?.motion !== "waiting" &&
			this.#timeline.hasActiveTools
		) {
			intervals.push(this.#theme.colorLevel === 3 ? 80 : 600);
		}
		if (this.#lastIdleCtrlCAt !== undefined) {
			const remaining = IDLE_CTRL_C_CONFIRMATION_WINDOW_MS - (context.now - this.#lastIdleCtrlCAt);
			if (remaining > 0) intervals.push(remaining);
		}
		return intervals.length > 0 ? Math.min(...intervals) : undefined;
	}

	setActivityOverride(key: string, text: string, present: boolean, motion: "active" | "waiting" = "waiting"): void {
		this.#activity.setOverride(key, text, present, this.#options.clock.now(), motion);
		this.invalidate();
	}

	acceptRunEvidence(evidence: RunEvidenceEnvelope): void {
		this.#runEvidence = structuredClone(evidence);
		this.invalidate();
	}

	accept(event: AgentEvent): void {
		this.#activity.accept(event);
		if (event.type === "run_start" && this.#nextRunAttachments && this.#nextRunAttachments.length > 0) {
			this.#messageAttachments.set(event.inputMessage.id, this.#nextRunAttachments);
			this.#nextRunAttachments = undefined;
		}
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
					this.#messageAttachments.set(event.inputMessage.id, provisional.attachments);
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
						this.#messageAttachments.set(event.inputMessage.id, active.attachments);
					}
				}
			}
		}
		if (event.type === "turn_start") {
			for (const message of event.steeringMessages) {
				const index = this.#provisionalCards.findIndex((card) => card.kind === "steering");
				if (index < 0) break;
				const [card] = this.#provisionalCards.splice(index, 1);
				if (card && card.attachments.length > 0) this.#messageAttachments.set(message.id, card.attachments);
			}
		}
		const mutation = this.#timeline.accept(event);
		switch (event.type) {
			case "run_start":
				this.#running = true;
				this.#notice = undefined;
				this.#runEvidence = undefined;
				break;
			case "run_end":
				this.#running = false;
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
				if (event.outcome !== "success") {
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
				if (event.outcome === "error") {
					this.#error = event.failure?.message ?? "Run failed";
				}
				break;
		}
		if (mutation.changed) this.#viewport.noteUpdate();
		this.invalidate();
	}

	acceptUserShell(snapshot: UserShellSnapshot): void {
		this.#activity.acceptUserShell(snapshot, this.#options.clock.now());
		if (snapshot.status === "running") {
			// A resumed mixed queue may optimistically mark an Agent Run as pending before
			// discovering that its next item is a local Shell command.
			this.#running = false;
			const exact = this.#provisionalCards.findIndex(
				(card) => card.kind === "user_shell" && card.queueItemId === snapshot.id,
			);
			const index =
				exact >= 0
					? exact
					: this.#provisionalCards.findIndex(
							(card) => card.kind === "user_shell" && card.queueItemId === undefined,
						);
			if (index >= 0) this.#provisionalCards.splice(index, 1);
		}
		this.#shellRunning = snapshot.status === "running";
		this.#timeline.acceptUserShell(snapshot);
		this.#viewport.noteUpdate();
		this.invalidate();
	}

	render({ width, height, now }: RenderContext): string[] {
		if (width < MINIMUM_COLUMNS || height < MINIMUM_ROWS) return renderTooSmall(width, height, this.running);

		const editorFocused =
			this.focused &&
			this.#focusedAttachmentTarget === undefined &&
			!this.#imageModal &&
			this.#commandFlow.view === undefined;
		const editorFrame = this.#editor.render({
			width,
			height,
			focused: editorFocused,
			cursorMode: this.#theme.colorLevel === 0 ? "native" : "software",
			styleBorder: (value) =>
				this.#shellMode
					? this.#theme.style("error", value)
					: this.#theme.styleEditorBorder(this.#reasoning, editorFocused, value),
			...(this.#shellMode ? { prefix: this.#theme.style("error", "! ") } : {}),
		});
		const attachmentLayout = this.#layoutAttachmentRows(width);
		const attachmentRows = attachmentLayout.lines.length;
		const flowView = this.#commandFlow.view;
		const palette = !flowView && !this.#shellMode ? this.#commands.palette : undefined;
		const maximumDrawerItems = Math.max(0, Math.min(6, height - editorFrame.lines.length - attachmentRows - 5));
		const drawerLines =
			maximumDrawerItems === 0
				? []
				: flowView
					? renderCommandFlow(flowView, width, maximumDrawerItems, this.#theme)
					: palette
						? renderCommandPalette(palette, width, maximumDrawerItems, this.#theme)
						: [];
		const drawerRows = drawerLines.length;
		const activity = this.#activity.status(now);
		const activityRows = activity ? 1 : 0;
		const footerLines = this.#renderFooter(width, now);
		const dockRows = editorFrame.lines.length + attachmentRows + drawerRows + activityRows + footerLines.length;
		this.#lastDockRows = dockRows;
		const viewportHeight = height - 1 - dockRows;
		const blocks = this.#renderViewportBlocks(width, now);
		this.#lastViewportBlocks = blocks;
		this.#lastViewportHeight = viewportHeight;
		const viewport = this.#viewport.layout(blocks, viewportHeight);
		const transcript = [...viewport.lines];
		while (transcript.length < viewportHeight) transcript.push("");

		const attachmentRow = height - dockRows + drawerRows;
		this.#attachmentHitRegions = [
			...viewport.sourceRows.flatMap((source, row) =>
				(this.#timelineAttachmentHitRegions.get(source.blockId) ?? [])
					.filter((region) => region.row === source.lineOffset)
					.map((region) => ({ ...region, row: 1 + row })),
			),
			...attachmentLayout.regions.map((region) => ({
				...region,
				row: attachmentRow + region.row,
			})),
		];
		const editorRow = 1 + viewportHeight + drawerRows + attachmentRows + activityRows;
		this.#lastCursor = editorFrame.cursor
			? {
					row: editorRow + editorFrame.cursor.row,
					column: editorFrame.cursor.column,
					visible: editorFrame.cursor.visible,
				}
			: undefined;
		const frame = [
			renderHeader(width, this.#transcriptMode),
			...transcript,
			...drawerLines,
			...attachmentLayout.lines,
			...(activity
				? [
						renderActivityStatus(activity, {
							width,
							now,
							theme: this.#theme,
							motion: this.#options.motion ?? "full",
						}),
					]
				: []),
			...editorFrame.lines,
			...footerLines,
		];
		const geometry = this.#previewGeometry({ width, height, now });
		return geometry ? renderPreviewOverlay(frame, geometry, this.#focusedAttachment!, width) : frame;
	}

	override cursorPlacement(): CursorPlacement | undefined {
		return this.#lastCursor;
	}

	override imagePlacements(context: RenderContext): readonly ImagePlacement[] {
		if (!this.#options.imagePreviewSupported) return [];
		const attachment = this.#focusedAttachment;
		const geometry = attachment ? this.#previewGeometry(context) : undefined;
		if (!attachment?.preview || !geometry) return [];
		return [
			{
				stableKey: `attachment-preview:${attachment.id}`,
				generation: attachment.preview.generation,
				png: attachment.preview.png,
				row: geometry.imageRow,
				column: geometry.imageColumn,
				width: geometry.imageWidth,
				height: geometry.imageHeight,
			},
		];
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		const idleCtrlCPress =
			input.type === "key" &&
			input.action === "press" &&
			input.control &&
			input.key === "c" &&
			!this.running &&
			!this.#shellMode &&
			!this.#transcriptMode &&
			!this.#imageModal &&
			this.#focusedAttachmentTarget === undefined &&
			this.#commandFlow.view === undefined &&
			this.#editor.text.trim().length === 0;
		if (input.type !== "key" || input.action !== "release") {
			if (!idleCtrlCPress) this.#lastIdleCtrlCAt = undefined;
		}
		if (input.type === "resize") return;
		if (input.type === "mouse") {
			this.#handleMouse(input, context);
			return;
		}
		if (input.type === "key" && input.action !== "release" && this.#imageModal) {
			if (input.key === "escape" || input.key === "q") {
				this.#imageModal = false;
				this.#requestNavigationRender(context);
			}
			return;
		}
		if (input.type === "key" && input.action !== "release" && this.#focusedAttachmentTarget) {
			if (input.key === "tab") {
				this.#moveAttachmentFocus(input.shift ? -1 : 1);
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "left" || input.key === "right") {
				this.#moveAttachmentFocus(input.key === "left" ? -1 : 1, true);
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "escape") {
				this.#attachmentFocusKey = undefined;
				this.#attachmentFocusOrigin = undefined;
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "delete" || input.key === "backspace") {
				if (this.#focusedAttachmentTarget.source === "composer") void this.#detachFocused();
				return;
			}
			if (input.key === "enter") {
				if (this.#options.imagePreviewSupported && this.#focusedAttachment?.preview) {
					this.#imageModal = true;
					this.#requestNavigationRender(context);
				} else if (this.#focusedAttachment && this.#options.onOpenAttachment) {
					void this.#openFocusedAttachment();
				}
				return;
			}
			return;
		}
		if (this.#commandFlow.view) {
			this.#commandFlow.handleInput(input);
			this.invalidate();
			return;
		}
		if (!this.#shellMode) {
			const before = this.#editor.text;
			const commandResult = this.#commands.handleInput(input);
			if (commandResult.type === "handled") {
				if (this.#editor.text !== before) this.#history.noteTextMutation();
				this.invalidate();
				return;
			}
			if (commandResult.type === "invoke") {
				this.#invokeCommand(commandResult.command);
				return;
			}
		}
		if (input.type === "key" && input.action !== "release") {
			const attachmentTargets = this.#attachmentTargets();
			if (input.key === "tab" && attachmentTargets.length > 0) {
				this.#attachmentFocusKey = input.shift ? attachmentTargets.at(-1)!.key : attachmentTargets[0]!.key;
				this.#attachmentFocusOrigin = "keyboard";
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "page-up" && !input.control) {
				this.#viewport.pageUp(this.#lastViewportBlocks, this.#lastViewportHeight);
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "page-down" && !input.control) {
				this.#viewport.pageDown(this.#lastViewportBlocks, this.#lastViewportHeight);
				this.#requestNavigationRender(context);
				return;
			}
			if (input.control && input.key === "home") {
				this.#viewport.jumpToStart(this.#lastViewportBlocks);
				this.#requestNavigationRender(context);
				return;
			}
			if (input.control && input.key === "end") {
				this.#viewport.jumpToEnd();
				this.#requestNavigationRender(context);
				return;
			}
			if (input.control && input.key === "t") {
				this.#transcriptMode = !this.#transcriptMode;
				this.#requestNavigationRender(context);
				return;
			}
			if (input.key === "escape" && this.#transcriptMode) {
				this.#transcriptMode = false;
				this.#requestNavigationRender(context);
				return;
			}
		}
		if (input.type === "key" && input.action === "release") return;
		if (input.type === "key" && input.alt && input.key === "up") {
			void this.#reclaimLatestQueuedInput();
			return;
		}
		if (input.type === "key" && input.control && input.key === "c") {
			if (this.#shellRunning) this.#options.onAbortUserShell?.();
			else if (this.#running) this.#options.onAbort();
			else if (this.#shellMode || this.#editor.text.length > 0) {
				this.#editor.clear();
				this.#shellMode = false;
				this.#history.reset();
				this.invalidate();
			} else if (input.action === "press") {
				const now = this.#options.clock.now();
				const previous = this.#lastIdleCtrlCAt;
				if (previous !== undefined && now >= previous && now - previous <= IDLE_CTRL_C_CONFIRMATION_WINDOW_MS) {
					this.#lastIdleCtrlCAt = undefined;
					this.#options.onExit();
				} else {
					this.#lastIdleCtrlCAt = now;
					this.invalidate();
				}
			}
			return;
		}
		if (input.type === "key" && input.key === "escape") {
			if (this.#shellMode) {
				if (this.#editor.text.trim().length === 0) {
					this.#shellMode = false;
					this.#error = undefined;
					this.invalidate();
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
			!this.running &&
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
			this.invalidate();
			return;
		}

		let editorInput: TerminalInput = input;
		if (!this.#shellMode && this.#editor.text.length === 0) {
			const activation = shellActivation(input);
			if (activation) {
				this.#shellMode = true;
				this.#history.reset();
				this.#error = undefined;
				if (!activation.remainder) {
					this.invalidate();
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
				this.#error = undefined;
			} else if (this.#editor.text !== before) this.#error = undefined;
			this.invalidate();
			return;
		}
		const before = this.#editor.text;
		const editorResult = this.#editor.handleInput(editorInput);
		if (editorResult.type === "handled") {
			if (!this.#shellMode && this.#editor.absorbPrefix("!")) {
				this.#shellMode = true;
				this.#history.reset();
				this.#error = undefined;
			} else if (this.#editor.text !== before) {
				this.#history.noteTextMutation();
				if (this.#shellMode) this.#error = undefined;
			}
			this.invalidate();
			return;
		}
		if (editorResult.type !== "submit") return;
		const value = editorResult.text.trim();
		const extensionReferences = extensionReferencesFromMarkers(editorResult.markers ?? []);
		if (this.#shellMode) {
			if (!value) {
				this.#error = "Prefix a command with ! to run it locally. Example: !ls";
				this.invalidate();
				return;
			}
			this.#submitUserShell(value);
			return;
		}
		const commandInvocation = this.#commands.resolveSubmission(value);
		if (commandInvocation && commandInvocation.command.id !== "core:follow-up") {
			this.#invokeCommand(commandInvocation.command, commandInvocation.argument);
			return;
		}
		if (value.length === 0 && this.#attachments.length === 0 && this.#hasPausedQueue) {
			if (!this.#options.onResumeFollowUps) {
				this.#error = "Follow-up recovery is unavailable";
				this.invalidate();
				return;
			}
			this.#running = true;
			this.#activity.beginPreparation(this.#options.clock.now());
			this.#error = undefined;
			try {
				const operation = Promise.resolve(this.#options.onResumeFollowUps());
				void operation.catch((error: unknown) => {
					this.#running = false;
					this.#activity.cancelPreparation();
					this.#error = error instanceof Error ? error.message : String(error);
					this.invalidate();
				});
			} catch (error) {
				this.#running = false;
				this.#activity.cancelPreparation();
				this.#error = error instanceof Error ? error.message : String(error);
			}
			this.invalidate();
			return;
		}
		if (extensionReferences.length > 0 && !this.#options.onResolveExtensionReferences) {
			this.#error = "Skill/MCP extension loading is unavailable";
			this.invalidate();
			return;
		}
		const composerText = value;
		let submissionText = value.startsWith("\\!") ? value.slice(1) : value;
		const appendsPausedQueue = !this.#running && this.#hasPausedQueue;
		let kind: Exclude<ProvisionalPromptCard["kind"], "user_shell"> = this.#running
			? editorResult.alternate
				? "follow_up"
				: "steering"
			: this.#shellRunning
				? "follow_up"
				: appendsPausedQueue
					? "follow_up"
					: "prompt";
		if (this.#running && /^\/follow-up\s+/iu.test(submissionText) && !submissionText.includes("\n")) {
			kind = "follow_up";
			submissionText = submissionText.replace(/^\/follow-up\s+/iu, "").trim();
		}
		if (submissionText.length === 0 && this.#attachments.length === 0) return;
		const submittedAttachments = [...this.#attachments];
		const submittedComposerState = this.#editor.captureState();
		const provisional: ProvisionalPromptCard = Object.freeze({
			id: `provisional:${++this.#nextProvisionalId}`,
			kind,
			text: submissionText,
			attachments: Object.freeze(submittedAttachments),
			status: kind === "steering" ? "Steering queued" : kind === "follow_up" ? "Follow-up queued" : undefined,
		});
		this.#provisionalCards.push(provisional);
		if (kind === "prompt") this.#nextRunAttachments = submittedAttachments;
		this.#editor.clear();
		this.#history.reset();
		this.#attachments = [];
		this.#attachmentFocusKey = undefined;
		this.#attachmentFocusOrigin = undefined;
		this.#error = undefined;
		this.#notice = undefined;
		if (!this.running && kind === "prompt") {
			this.#running = true;
			this.#activity.beginPreparation(this.#options.clock.now());
		}
		this.#viewport.jumpToEnd();
		this.invalidate();
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
					this.#provisionalCards = this.#provisionalCards.map((card) =>
						card.id === provisional.id ? Object.freeze({ ...card, queueItemId }) : card,
					);
				}
				this.invalidate();
			},
			(error: unknown) => {
				if (kind === "prompt" || appendsPausedQueue) {
					this.#running = false;
					this.#activity.cancelPreparation();
				}
				if (this.#nextRunAttachments === submittedAttachments) this.#nextRunAttachments = undefined;
				this.#provisionalCards = this.#provisionalCards.filter((card) => card.id !== provisional.id);
				this.#attachments = [...submittedAttachments, ...this.#attachments];
				if (!this.#editor.text) this.#editor.restoreState(submittedComposerState);
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
			},
		);
	}

	get #hasPausedQueue(): boolean {
		return this.#options.isQueuePaused?.() ?? this.#recoverableCards.some((card) => card.state === "paused");
	}

	#submitUserShell(command: string): void {
		const provisional: ProvisionalPromptCard = Object.freeze({
			id: `provisional:${++this.#nextProvisionalId}`,
			kind: "user_shell",
			text: `!${command}`,
			attachments: Object.freeze([]),
			status: "Shell queued",
		});
		this.#provisionalCards.push(provisional);
		this.#editor.clear();
		this.#shellMode = false;
		this.#history.reset();
		this.#error = undefined;
		this.#viewport.jumpToEnd();
		this.invalidate();
		let operation: Promise<UserShellSubmission>;
		try {
			if (!this.#options.onUserShell) throw new Error("Local Shell mode is unavailable");
			operation = Promise.resolve(this.#options.onUserShell(command));
		} catch (error) {
			operation = Promise.reject(error);
		}
		void operation.then(
			(submission) => {
				this.#provisionalCards = this.#provisionalCards.map((card) =>
					card.id === provisional.id ? Object.freeze({ ...card, queueItemId: submission.id }) : card,
				);
				this.invalidate();
			},
			(error: unknown) => {
				this.#provisionalCards = this.#provisionalCards.filter((card) => card.id !== provisional.id);
				if (!this.#editor.text) this.#editor.setText(command);
				this.#shellMode = true;
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
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
				this.#provisionalCards = this.#provisionalCards.filter((card) => card.id !== provisional.id);
			} else {
				this.#recoverableCards = this.#recoverableCards.filter((card) => card !== recoverable);
			}
			this.#editor.setText(text);
			this.#history.reset();
			this.#shellMode = provisional?.kind === "user_shell";
			const known = new Set(this.#attachments.map(({ id }) => id));
			this.#attachments.push(...attachments.filter(({ id }) => !known.has(id)));
			this.#attachmentFocusKey = undefined;
			this.#attachmentFocusOrigin = undefined;
			this.#error = undefined;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.invalidate();
	}

	get #focusedAttachmentTarget(): AttachmentTarget | undefined {
		if (!this.#attachmentFocusKey) return undefined;
		return this.#attachmentTargets().find((target) => target.key === this.#attachmentFocusKey);
	}

	get #focusedAttachment(): ChatAttachment | undefined {
		return this.#focusedAttachmentTarget?.attachment;
	}

	#attachmentTargets(): readonly AttachmentTarget[] {
		const targets: AttachmentTarget[] = this.#attachments.map((attachment, composerIndex) => ({
			key: attachmentTargetKey("composer", attachment.id, composerIndex),
			source: "composer",
			attachment,
			composerIndex,
		}));
		const addTimeline = (blockId: string, attachments: readonly ChatAttachment[]): void => {
			for (const [index, attachment] of attachments.entries()) {
				targets.push({
					key: attachmentTargetKey(blockId, attachment.id, index),
					source: "timeline",
					attachment,
				});
			}
		};
		for (const entry of this.#timeline.entries) {
			if (entry.kind !== "user") continue;
			const recovery =
				this.#recoverableCards.find((card) => card.messageId === entry.messageId) ??
				(this.#activeFollowUp?.messageId === entry.messageId ? this.#activeFollowUp : undefined);
			addTimeline(entry.id, this.#messageAttachments.get(entry.messageId) ?? recovery?.attachments ?? []);
		}
		for (const card of this.#provisionalCards) addTimeline(card.id, card.attachments);
		for (const card of this.#recoverableCards) {
			if (!card.messageId) addTimeline(`recoverable:${card.item.id}`, card.attachments);
		}
		return targets;
	}

	async #detachFocused(): Promise<void> {
		const target = this.#focusedAttachmentTarget;
		const index = target?.composerIndex;
		const attachment = target?.attachment;
		if (target?.source !== "composer" || index === undefined || !attachment) return;
		try {
			await this.#options.onDetach?.(attachment.id);
			this.#attachments.splice(index, 1);
			this.#imageModal = false;
			const nextIndex = Math.min(index, this.#attachments.length - 1);
			const next = this.#attachments[nextIndex];
			this.#attachmentFocusKey = next ? attachmentTargetKey("composer", next.id, nextIndex) : undefined;
			this.#attachmentFocusOrigin = this.#attachmentFocusKey === undefined ? undefined : "keyboard";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.invalidate();
	}

	async #openFocusedAttachment(): Promise<void> {
		const attachment = this.#focusedAttachment;
		if (!attachment || !this.#options.onOpenAttachment) return;
		try {
			await this.#options.onOpenAttachment(attachment.id);
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			this.invalidate();
		}
	}

	#moveAttachmentFocus(delta: number, wrap = false): void {
		const targets = this.#attachmentTargets();
		const current = targets.findIndex((target) => target.key === this.#attachmentFocusKey);
		if (current < 0 || targets.length === 0) return;
		const next = current + delta;
		if (!wrap && (next < 0 || next >= targets.length)) {
			this.#attachmentFocusKey = undefined;
			this.#attachmentFocusOrigin = undefined;
			return;
		}
		this.#attachmentFocusKey = targets[(next + targets.length) % targets.length]!.key;
		this.#attachmentFocusOrigin = "keyboard";
	}

	#layoutAttachmentRows(width: number): {
		readonly lines: readonly string[];
		readonly regions: readonly LocalAttachmentHitRegion[];
	} {
		if (this.#attachments.length === 0) return { lines: [], regions: [] };
		interface Token {
			readonly targetKey: string;
			readonly text: string;
			readonly width: number;
		}
		const rows: Token[][] = [[]];
		for (const [index, attachment] of this.#attachments.entries()) {
			const targetKey = attachmentTargetKey("composer", attachment.id, index);
			const focused = targetKey === this.#attachmentFocusKey;
			const label = `[${sanitizeTerminalText(attachment.filename).replace(/[\r\n]+/g, " ")}]`;
			const plain = clipAnsi(focused ? `›${label}` : label, width);
			const token: Token = {
				targetKey,
				text: focused ? this.#theme.style("accent", plain) : plain,
				width: displayWidth(plain),
			};
			let row = rows.at(-1)!;
			const used = row.reduce((total, entry) => total + entry.width, Math.max(0, row.length - 1));
			if (row.length > 0 && used + 1 + token.width > width) {
				row = [];
				rows.push(row);
			}
			row.push(token);
		}

		let hidden = rows.slice(2).reduce((total, row) => total + row.length, 0);
		const visible = rows.slice(0, 2);
		if (hidden > 0) {
			const last = visible[1] ?? [];
			if (!visible[1]) visible.push(last);
			while (last.length > 0) {
				const indicator = `… +${hidden}`;
				const used = last.reduce((total, entry) => total + entry.width, Math.max(0, last.length - 1));
				if (used + 1 + displayWidth(indicator) <= width) break;
				last.pop();
				hidden++;
			}
		}

		const regions: LocalAttachmentHitRegion[] = [];
		const lines = visible.map((row, rowIndex) => {
			let column = 0;
			const parts: string[] = [];
			for (const token of row) {
				if (parts.length > 0) column++;
				parts.push(token.text);
				regions.push({ targetKey: token.targetKey, row: rowIndex, start: column, end: column + token.width });
				column += token.width;
			}
			if (hidden > 0 && rowIndex === visible.length - 1) parts.push(clipAnsi(`… +${hidden}`, width));
			return clipAnsi(parts.join(" "), width);
		});
		return { lines, regions };
	}

	#handleMouse(input: Extract<TerminalInput, { type: "mouse" }>, context: ComponentInputContext): void {
		if (this.#imageModal) return;
		if (input.action === "press" && (input.button === "wheel-up" || input.button === "wheel-down")) {
			this.#viewport.scrollBy(
				this.#lastViewportBlocks,
				this.#lastViewportHeight,
				input.button === "wheel-up" ? -3 : 3,
			);
			this.#requestNavigationRender(context);
			return;
		}
		const hit = this.#attachmentHitRegions.find(
			(region) => region.row === input.row && input.column >= region.start && input.column < region.end,
		);
		if (input.action === "move") {
			if (hit) {
				this.#attachmentFocusKey = hit.targetKey;
				this.#attachmentFocusOrigin = "mouse";
			} else if (this.#attachmentFocusOrigin === "mouse") {
				this.#attachmentFocusKey = undefined;
				this.#attachmentFocusOrigin = undefined;
			}
			this.#requestNavigationRender(context);
			return;
		}
		if (input.button !== "left" || !hit) return;
		this.#attachmentFocusKey = hit.targetKey;
		this.#attachmentFocusOrigin = "mouse";
		this.#requestNavigationRender(context);
		if (input.action === "release" && !this.#options.imagePreviewSupported) void this.#openFocusedAttachment();
	}

	#previewGeometry(context: RenderContext): PreviewGeometry | undefined {
		const attachment = this.#focusedAttachment;
		if (!attachment) return undefined;
		return previewGeometry(context.width, context.height, this.#lastDockRows, attachment, this.#imageModal);
	}

	#renderViewportBlocks(width: number, now: number): readonly ViewportBlock[] {
		const entries = this.#timeline.entries;
		const cache = this.#cachedViewportBlocks;
		if (
			!this.#timeline.hasActiveTools &&
			this.#provisionalCards.length === 0 &&
			this.#recoverableCards.length === 0 &&
			!this.#activeFollowUp &&
			cache?.entries === entries &&
			cache.width === width &&
			cache.transcriptMode === this.#transcriptMode &&
			cache.error === this.#error &&
			cache.notice === this.#notice &&
			cache.runEvidence === this.#runEvidence &&
			cache.attachmentFocusKey === this.#attachmentFocusKey
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
			if (!this.#transcriptMode && entry.kind === "tool" && isExplorationTool(entry)) {
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
							width,
							now,
							transcript: false,
							theme: this.#theme,
							motion: this.#options.motion ?? "full",
						}),
					},
					"exploration",
				);
				continue;
			}
			const recovery =
				entry.kind === "user"
					? (this.#recoverableCards.find((card) => card.messageId === entry.messageId) ??
						(this.#activeFollowUp?.messageId === entry.messageId ? this.#activeFollowUp : undefined))
					: undefined;
			const rendered = this.#renderTimelineBlock(entry, recovery, width, now);
			this.#timelineAttachmentHitRegions.set(entry.id, rendered.regions);
			appendBlock({ id: entry.id, lines: rendered.lines }, timelineEntryContentType(entry));
		}
		for (const card of this.#provisionalCards) {
			const layout = renderUserCard(
				card.text,
				width,
				this.#theme,
				card.attachments,
				card.status,
				card.id,
				this.#attachmentFocusKey,
			);
			this.#timelineAttachmentHitRegions.set(card.id, layout.regions);
			appendBlock({ id: card.id, lines: layout.lines }, card.kind === "user_shell" ? "user_shell" : "user");
		}
		for (const card of this.#recoverableCards) {
			if (card.messageId) continue;
			const blockId = `recoverable:${card.item.id}`;
			const layout = renderUserCard(
				followUpText(card.item),
				width,
				this.#theme,
				card.attachments,
				recoverableStatus(card),
				blockId,
				this.#attachmentFocusKey,
			);
			this.#timelineAttachmentHitRegions.set(blockId, layout.regions);
			appendBlock({ id: blockId, lines: layout.lines }, "user");
		}
		if (this.#error) {
			appendBlock(
				{
					id: "run-error",
					lines: wrapAnsi(this.#theme.style("error", `Error: ${sanitizeTerminalText(this.#error)}`), width),
				},
				"error",
			);
		}
		if (this.#runEvidence) {
			appendBlock(
				{
					id: `run-evidence:${this.#runEvidence.runId}`,
					lines: renderRunEvidenceSummary(this.#runEvidence, width).map((line) =>
						this.#theme.style("muted", line),
					),
				},
				"evidence",
			);
		}
		if (this.#notice) {
			appendBlock(
				{
					id: "command-notice",
					lines: wrapAnsi(this.#theme.style("success", sanitizeTerminalText(this.#notice)), width),
				},
				"notice",
			);
		}
		const blocks: readonly ViewportBlock[] = this.#transcriptMode
			? presentationBlocks
			: spaceMainTimelineBlocks(presentationBlocks);
		const snapshot = Object.freeze([...blocks]);
		if (
			!this.#timeline.hasActiveTools &&
			this.#provisionalCards.length === 0 &&
			this.#recoverableCards.length === 0 &&
			!this.#activeFollowUp
		) {
			this.#cachedViewportBlocks = Object.freeze({
				entries,
				width,
				transcriptMode: this.#transcriptMode,
				error: this.#error,
				notice: this.#notice,
				runEvidence: this.#runEvidence,
				attachmentFocusKey: this.#attachmentFocusKey,
				blocks: snapshot,
			});
		}
		return snapshot;
	}

	#renderTimelineBlock(
		entry: TimelineEntry,
		recovery: RecoverablePromptCard | undefined,
		width: number,
		now: number,
	): CachedTimelineBlock {
		const attachments =
			entry.kind === "user"
				? (this.#messageAttachments.get(entry.messageId) ?? recovery?.attachments ?? [])
				: undefined;
		const status = recovery
			? this.#activeFollowUp === recovery
				? "Running"
				: recoverableStatus(recovery)
			: undefined;
		const attachmentFocusKey = this.#attachmentFocusKey?.startsWith(`${entry.id}\u0000`)
			? this.#attachmentFocusKey
			: undefined;
		const toolResultImagesSupported = this.#options.toolResultImagesSupported ?? false;
		const animated =
			entry.kind === "tool" && entry.state === "running" && (this.#options.motion ?? "full") === "full";
		const cached = this.#timelineBlockCache.get(entry.id);
		if (
			!animated &&
			cached?.entry === entry &&
			cached.width === width &&
			cached.transcriptMode === this.#transcriptMode &&
			cached.toolResultImagesSupported === toolResultImagesSupported &&
			cached.attachments === attachments &&
			cached.status === status &&
			cached.attachmentFocusKey === attachmentFocusKey
		) {
			return cached;
		}
		const layout =
			entry.kind === "user"
				? renderUserCard(entry.text, width, this.#theme, attachments, status, entry.id, attachmentFocusKey)
				: {
						lines: renderTimelineEntry(
							entry,
							width,
							this.#transcriptMode,
							this.#markdown,
							this.#theme,
							now,
							this.#options.motion ?? "full",
							toolResultImagesSupported,
						),
						regions: [],
					};
		const rendered = Object.freeze({
			entry,
			width,
			transcriptMode: this.#transcriptMode,
			toolResultImagesSupported,
			attachments,
			status,
			attachmentFocusKey,
			lines: layout.lines,
			regions: layout.regions,
		});
		this.#timelineBlockCache.set(entry.id, rendered);
		return rendered;
	}

	#renderFooter(width: number, now: number): readonly string[] {
		if (this.#imageModal) return actionFooter(width, ["Image preview • Esc/q closes"]);
		const attachmentTarget = this.#focusedAttachmentTarget;
		if (attachmentTarget) {
			const canDetach = attachmentTarget.source === "composer";
			return this.#options.imagePreviewSupported
				? actionFooter(width, [
						`Attachment • Enter expands${canDetach ? " • Delete detaches" : ""} • Tab returns to editor`,
						`Enter expands${canDetach ? " • Delete detaches" : ""} • Tab returns`,
						"Enter expands • Tab returns",
					])
				: actionFooter(width, [
						`Attachment • Enter opens system viewer${canDetach ? " • Delete detaches" : ""} • Tab returns to editor`,
						`Enter opens viewer${canDetach ? " • Delete detaches" : ""} • Tab returns`,
						"Enter opens viewer • Tab returns",
					]);
		}
		if (this.#shellMode) return actionFooter(width, [this.#theme.style("error", "Shell mode")]);
		const unread = this.#viewport.unreadUpdates;
		if (unread > 0) return actionFooter(width, [`down ${unread} update${unread === 1 ? "" : "s"} - Ctrl+End`]);
		if (this.#transcriptMode) {
			return actionFooter(width, [
				"Transcript • PgUp/PgDn scroll • Esc closes • Ctrl+End latest",
				"Transcript • PgUp/PgDn • Esc closes",
				"Transcript • Esc closes",
			]);
		}
		if (!this.#running && this.#hasPausedQueue) {
			return actionFooter(width, [
				"Paused queue • Enter resumes • Alt+Up edits latest • typing appends",
				"Enter resumes • Alt+Up edits • typing appends",
				"Enter resumes • Alt+Up edits",
			]);
		}
		if (this.#shellRunning) {
			return actionFooter(width, [
				"Local command running • Enter queues • Alt+Up edits • Ctrl-C cancels",
				"Enter queues • Alt+Up edits • Ctrl-C cancels",
				"Ctrl-C cancels the command",
			]);
		}
		if (
			this.#lastIdleCtrlCAt !== undefined &&
			now >= this.#lastIdleCtrlCAt &&
			now - this.#lastIdleCtrlCAt < IDLE_CTRL_C_CONFIRMATION_WINDOW_MS
		) {
			return actionFooter(width, ["Press Ctrl-C again to exit"]);
		}
		return renderStatusLine(
			this.#options.statusLine(),
			{ modelLabel: this.#modelLabel, reasoning: this.#reasoning },
			width,
			this.#theme,
		);
	}

	#invokeCommand(command: CommandDefinition, argument?: string): void {
		this.#editor.clear();
		this.#history.reset();
		this.#error = undefined;
		this.#notice = undefined;
		const operation = (() => {
			try {
				if (!this.#options.onCommand) throw new Error(`${command.title} is unavailable`);
				return Promise.resolve(
					argument === undefined
						? this.#options.onCommand(command.id, this.#commandFlow)
						: this.#options.onCommand(command.id, this.#commandFlow, argument),
				);
			} catch (error) {
				return Promise.reject(error);
			}
		})();
		void operation.then(
			(notice) => {
				this.#notice = notice || undefined;
				this.invalidate();
			},
			(error: unknown) => {
				this.#notice = undefined;
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
			},
		);
		this.invalidate();
	}

	#requestNavigationRender(context: ComponentInputContext): void {
		this.invalidate();
		context.requestImmediateRender();
	}
}

interface PreviewGeometry {
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly height: number;
	readonly imageRow: number;
	readonly imageColumn: number;
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly modal: boolean;
}

function previewGeometry(
	screenWidth: number,
	screenHeight: number,
	dockRows: number,
	attachment: ChatAttachment,
	modal: boolean,
): PreviewGeometry | undefined {
	const availableHeight = screenHeight - 1 - dockRows;
	if (availableHeight < 4 || screenWidth < 8) return undefined;
	const maximumWidth = modal ? Math.floor(screenWidth * 0.9) : Math.floor(screenWidth * 0.75);
	const maximumHeight = modal ? Math.floor(availableHeight * 0.9) : Math.floor(availableHeight * 0.75);
	const width = Math.min(screenWidth, Math.max(Math.min(28, screenWidth), maximumWidth));
	const height = Math.min(availableHeight, Math.max(Math.min(8, availableHeight), maximumHeight));
	const row = 1 + Math.floor((availableHeight - height) / 2);
	const column = Math.floor((screenWidth - width) / 2);
	const innerWidth = Math.max(1, width - 2);
	const innerHeight = Math.max(1, height - 3);
	const sourceWidth = attachment.preview?.width ?? attachment.width;
	const sourceHeight = attachment.preview?.height ?? attachment.height;
	const widthFromHeight = Math.max(1, Math.floor((innerHeight * sourceWidth * 2) / Math.max(1, sourceHeight)));
	const imageWidth = Math.max(1, Math.min(innerWidth, widthFromHeight));
	const imageHeight = Math.max(1, Math.min(innerHeight, Math.ceil((imageWidth * sourceHeight) / (sourceWidth * 2))));
	return {
		row,
		column,
		width,
		height,
		imageRow: row + 1 + Math.floor((innerHeight - imageHeight) / 2),
		imageColumn: column + 1 + Math.floor((innerWidth - imageWidth) / 2),
		imageWidth,
		imageHeight,
		modal,
	};
}

function renderPreviewOverlay(
	frame: readonly string[],
	geometry: PreviewGeometry,
	attachment: ChatAttachment,
	screenWidth: number,
): string[] {
	const title = geometry.modal ? ` Image preview • ${attachment.filename} ` : ` ${attachment.filename} `;
	const top = `┌${clipPlain(title, geometry.width - 2, "─")}┐`;
	const bottom = `└${"─".repeat(Math.max(0, geometry.width - 2))}┘`;
	const metadata = `${attachment.width}×${attachment.height} • ${attachment.mimeType} • ${formatBytes(attachment.bytes)}`;
	const box = Array.from({ length: geometry.height }, (_, index) => {
		if (index === 0) return top;
		if (index === geometry.height - 1) return bottom;
		if (index === geometry.height - 2) return `│${centerPlain(metadata, geometry.width - 2)}│`;
		return `│${" ".repeat(Math.max(0, geometry.width - 2))}│`;
	});
	return frame.map((line, row) => {
		const overlay = box[row - geometry.row];
		if (overlay === undefined) return line;
		const left = sliceAnsi(line, 0, geometry.column).padEnd(geometry.column);
		const rightStart = geometry.column + geometry.width;
		const right = sliceAnsi(line, rightStart, Math.max(0, screenWidth - rightStart));
		return clipAnsi(`${left}${overlay}${right}`, screenWidth);
	});
}

function clipPlain(value: string, width: number, fill: string): string {
	const clipped = clipAnsi(sanitizeTerminalText(value).replace(/[\r\n]+/g, " "), Math.max(0, width));
	return `${clipped}${fill.repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function centerPlain(value: string, width: number): string {
	const clipped = clipAnsi(sanitizeTerminalText(value), Math.max(0, width));
	const clippedWidth = displayWidth(clipped);
	const left = Math.max(0, Math.floor((width - clippedWidth) / 2));
	return `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, width - left - clippedWidth))}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function renderTimelineEntry(
	entry: TimelineEntry,
	width: number,
	transcriptMode: boolean,
	markdown: MarkdownRenderer,
	theme: TuiTheme,
	now: number,
	motion: "full" | "reduced",
	toolResultImagesSupported: boolean,
): readonly string[] {
	switch (entry.kind) {
		case "user":
			return renderUserCard(entry.text, width, theme).lines;
		case "assistant":
			return markdown.render(entry.text, { width, phase: entry.phase });
		case "thinking": {
			const thinkingWidth = theme.colorLevel === 0 ? Math.max(1, width - 2) : width;
			const lines = markdown.render(entry.text, { width: thinkingWidth, phase: entry.phase });
			if (theme.colorLevel > 0) return lines.map((line) => theme.style("thinking", line));
			return ["Thinking", ...lines.map((line) => clipAnsi(`  ${line}`, width))];
		}
		case "tool":
			return renderToolInvocation(entry, {
				width,
				now,
				transcript: transcriptMode,
				theme,
				motion,
				toolResultImagesSupported,
			});
		case "user_shell":
			return renderUserShellEntry(entry, { width, now, theme });
	}
}

function renderUserCard(
	source: string,
	width: number,
	theme: TuiTheme,
	attachments: readonly ChatAttachment[] = [],
	status?: string,
	blockId = "user",
	focusedAttachmentKey?: string,
): { readonly lines: readonly string[]; readonly regions: readonly LocalAttachmentHitRegion[] } {
	const safeSource = sanitizeTerminalText(source);
	const lines = safeSource ? safeSource.split("\n").flatMap((line) => (line ? wrapAnsi(line, width) : [""])) : [];
	const border = theme.style("muted", "─".repeat(width));
	const bottom = status ? theme.style("muted", renderStatusBorder(width, status)) : border;
	const attachmentLayout = renderTimelineAttachments(attachments, width, blockId, focusedAttachmentKey, theme);
	return Object.freeze({
		lines: Object.freeze([border, ...attachmentLayout.lines, ...lines, bottom]),
		regions: Object.freeze(
			attachmentLayout.regions.map((region) => Object.freeze({ ...region, row: region.row + 1 })),
		),
	});
}

function followUpText(item: FollowUp): string {
	return renderVisibleUserText(item.content);
}

function recoverableStatus(card: RecoverablePromptCard): string {
	return card.state === "failed" ? `Failed${card.failure ? `: ${card.failure}` : ""}` : "Paused";
}

function renderStatusBorder(width: number, status: string): string {
	const safeStatus = sanitizeTerminalText(status).replace(/[\r\n]+/g, " ");
	if (displayWidth(safeStatus) + 3 > width) return clipAnsi(safeStatus, width);
	return `${"─".repeat(width - displayWidth(safeStatus) - 2)} ${safeStatus} `;
}

function renderTimelineAttachments(
	attachments: readonly ChatAttachment[],
	width: number,
	blockId: string,
	focusedAttachmentKey: string | undefined,
	theme: TuiTheme,
): { readonly lines: readonly string[]; readonly regions: readonly LocalAttachmentHitRegion[] } {
	if (attachments.length === 0) return { lines: [], regions: [] };
	const lines: string[] = [];
	const regions: LocalAttachmentHitRegion[] = [];
	let tokens: Array<{ readonly targetKey: string; readonly text: string; readonly width: number }> = [];
	const flush = (): void => {
		if (tokens.length === 0) return;
		let column = 0;
		const row = lines.length;
		lines.push(
			tokens
				.map((token) => {
					const start = column;
					column += token.width + 1;
					regions.push({ targetKey: token.targetKey, row, start, end: start + token.width });
					return token.text;
				})
				.join(" "),
		);
		tokens = [];
	};
	for (const [index, attachment] of attachments.entries()) {
		const targetKey = attachmentTargetKey(blockId, attachment.id, index);
		const focused = targetKey === focusedAttachmentKey;
		const label = clipAnsi(
			`${focused ? "›" : ""}[${sanitizeTerminalText(attachment.filename).replace(/[\r\n]+/g, " ")}]`,
			width,
		);
		const labelWidth = displayWidth(label);
		const used = tokens.reduce((total, token) => total + token.width, Math.max(0, tokens.length - 1));
		if (tokens.length > 0 && used + 1 + labelWidth > width) flush();
		tokens.push({ targetKey, text: focused ? theme.style("accent", label) : label, width: labelWidth });
	}
	flush();
	return { lines, regions };
}

function attachmentTargetKey(owner: string, attachmentId: string, index: number): string {
	return `${owner}\u0000${attachmentId}\u0000${index}`;
}

function shellActivation(input: TerminalInput): { readonly remainder?: TerminalInput } | undefined {
	if (input.type === "text" || input.type === "paste") {
		if (!input.text.startsWith("!")) return undefined;
		const remainder = input.text.slice(1);
		return remainder ? { remainder: { ...input, text: remainder } } : {};
	}
	if (
		input.type !== "key" ||
		input.action === "release" ||
		input.control ||
		input.alt ||
		input.meta ||
		!input.text?.startsWith("!")
	) {
		return undefined;
	}
	const remainder = input.text.slice(1);
	return remainder ? { remainder: { ...input, text: remainder } } : {};
}

function renderHeader(width: number, transcriptMode: boolean): string {
	return clipAnsi(transcriptMode ? "Coda • Transcript" : "Coda", width);
}

function renderTooSmall(width: number, height: number, running: boolean): string[] {
	const lines = [
		"Coda",
		"Terminal too small",
		`Resize to at least ${MINIMUM_COLUMNS} x ${MINIMUM_ROWS}`,
		"",
		running ? "Ctrl-C aborts" : "Ctrl-C twice exits",
	].map((line) => clipAnsi(line, width));
	return Array.from({ length: height }, (_, row) => lines[row] ?? "");
}

function fitFooter(width: number, candidates: readonly string[]): string {
	const candidate = candidates.find((value) => displayWidth(value) <= width) ?? candidates.at(-1) ?? "";
	return clipAnsi(candidate, width);
}

function actionFooter(width: number, candidates: readonly string[]): readonly [string, string] {
	return [fitFooter(width, candidates), ""];
}
