import type { AgentEvent, AgentSeed } from "@coda/agent";
import {
	type Clock,
	type ColorLevel,
	Component,
	type ComponentInputContext,
	type CursorPlacement,
	createMarkdownRenderer,
	Editor,
	type ImagePlacement,
	type MarkdownRenderer,
	type RenderContext,
	type TerminalAppearance,
	type TerminalInput,
} from "@coda/tui";
import { createCoreCommandRegistry } from "../commands/core-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { RunEvidenceEnvelope } from "../run-evidence/run-evidence.ts";
import type { ComposerExtensionReference, ComposerSubmission } from "../session/composer-submission.ts";
import type { RecoverableFollowUp, SessionToolLifecycle } from "../session/types.ts";
import type { ActivitySummaryMode } from "./activity-status.ts";
import { renderActivityStatus } from "./activity-status-presentation.ts";
import { ChatAttachmentController, type ChatAttachmentProjection } from "./chat-attachments.ts";
import { ChatComposerController } from "./chat-composer.ts";
import {
	MINIMUM_CHAT_COLUMNS,
	MINIMUM_CHAT_ROWS,
	renderHeader,
	renderPreviewOverlay,
	renderTooSmall,
} from "./chat-rendering.ts";
import { ChatStateController } from "./chat-state.ts";
import { ChatTimelineRenderer } from "./chat-timeline-renderer.ts";
import { CommandComposer, renderCommandPalette } from "./command-composer.ts";
import { CommandFlowHost, type CommandFlowScreen, renderCommandFlow } from "./command-flow-host.ts";
import { ComposerHistory } from "./composer-history.ts";
import type { UserShellSubmission } from "./input-types.ts";
import type { StatusLineSnapshot } from "./status-line.ts";
import { createCodaTheme, type TuiTheme } from "./theme.ts";
import { TimelineViewport, type ViewportBlock } from "./timeline-viewport.ts";
import type { UserShellSnapshot } from "./user-shell.ts";

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

export class ChatComponent extends Component {
	readonly #options: ChatComponentOptions;
	readonly #state: ChatStateController;
	readonly #markdown: MarkdownRenderer;
	readonly #theme: TuiTheme;
	readonly #timelineRenderer: ChatTimelineRenderer;
	readonly #viewport = new TimelineViewport();
	#lastViewportBlocks: readonly ViewportBlock[] = [];
	#lastViewportHeight = 0;
	readonly #editor = new Editor();
	readonly #commands: CommandComposer;
	readonly #commandFlow: CommandFlowHost;
	readonly #history: ComposerHistory;
	#lastCursor?: CursorPlacement;
	#lastDockRows = 5;
	#transcriptMode = false;
	#lastIdleCtrlCAt?: number;
	readonly #attachments: ChatAttachmentController;
	readonly #composer: ChatComposerController;

	constructor(options: ChatComponentOptions) {
		super({ focusable: true });
		this.#options = options;
		this.#history = new ComposerHistory(options.composerSubmissions);
		this.#theme = createCodaTheme(options.colorLevel ?? 0, options.appearance);
		this.#attachments = new ChatAttachmentController({
			theme: this.#theme,
			imagePreviewSupported: options.imagePreviewSupported ?? false,
			initialAttachments: options.initialAttachments,
			restoredAttachments: options.restoredAttachments,
			onDetach: options.onDetach,
			onOpenAttachment: options.onOpenAttachment,
			invalidate: () => this.invalidate(),
			reportError: (message) => {
				this.#state.mutate({ type: "set_error", value: message });
			},
		});
		this.#state = new ChatStateController({
			modelLabel: options.modelLabel,
			reasoning: options.reasoning,
			clock: options.clock,
			activitySummaryMode: options.activitySummaryMode,
			motion: options.motion ?? "full",
			colorLevel: this.#theme.colorLevel,
			seed: options.seed,
			restoredToolInvocations: options.restoredToolInvocations,
			host: {
				mutate: (mutation) => {
					switch (mutation.type) {
						case "accept_run_start_attachment":
							this.#attachments.mutate({ type: "accept_run_start", messageId: mutation.messageId });
							return;
						case "project_composer":
							this.#composer.project(mutation.projection);
							return;
						case "note_timeline_update":
							this.#viewport.noteUpdate();
							return;
						case "reset_timeline_caches":
							this.#timelineRenderer.resetTimelineCaches();
							return;
						case "invalidate":
							this.invalidate();
							return;
					}
				},
			},
		});
		this.#commands = new CommandComposer(options.commandRegistry ?? createCoreCommandRegistry(), this.#editor, {
			isAvailable: (command) => command.id !== "core:follow-up" || this.#state.view().agentRunning,
		});
		this.#commandFlow = new CommandFlowHost({
			onChange: () => this.invalidate(),
			onError: (error) => {
				this.#state.mutate({
					type: "set_error",
					value: error instanceof Error ? error.message : String(error),
				});
				this.invalidate();
			},
		});
		this.#composer = new ChatComposerController({
			isQueuePaused: options.isQueuePaused,
			attachments: this.#attachments,
			editor: this.#editor,
			commands: this.#commands,
			flow: this.#commandFlow,
			history: this.#history,
			options,
			host: {
				view: () => {
					const stateView = this.#state.view();
					return {
						running: stateView.running,
						agentRunning: stateView.agentRunning,
						shellRunning: stateView.shellRunning,
						...(this.#lastIdleCtrlCAt === undefined ? {} : { lastIdleCtrlCAt: this.#lastIdleCtrlCAt }),
					};
				},
				mutate: (mutation) => {
					switch (mutation.type) {
						case "begin_agent_preparation":
							this.#state.mutate({ type: "begin_agent_preparation" });
							return;
						case "cancel_agent_preparation":
							this.#state.mutate({ type: "cancel_agent_preparation" });
							return;
						case "set_error":
							this.#state.mutate({ type: "set_error", value: mutation.value });
							return;
						case "set_notice":
							this.#state.mutate({ type: "set_notice", value: mutation.value });
							return;
						case "set_idle_ctrl_c":
							this.#lastIdleCtrlCAt = mutation.value;
							return;
						case "jump_to_end":
							this.#viewport.jumpToEnd();
							return;
						case "invalidate":
							this.invalidate();
							return;
					}
				},
			},
			recoverableFollowUps: options.recoverableFollowUps,
			restoredAttachments: options.restoredAttachments,
		});
		this.#markdown = options.markdownRenderer ?? createMarkdownRenderer({ colorLevel: options.colorLevel ?? 0 });
		this.#timelineRenderer = new ChatTimelineRenderer({
			markdown: this.#markdown,
			theme: this.#theme,
			motion: options.motion ?? "full",
			imagePreviewSupported: options.imagePreviewSupported ?? false,
			toolResultImagesSupported: options.toolResultImagesSupported ?? false,
			statusLine: options.statusLine,
		});
	}

	get running(): boolean {
		return this.#state.view().running;
	}

	setModelPresentation(modelLabel: string, reasoning: string, activitySummaryMode?: ActivitySummaryMode): void {
		this.#state.mutate({
			type: "set_model_presentation",
			modelLabel,
			reasoning,
			...(activitySummaryMode ? { activitySummaryMode } : {}),
		});
	}

	setReasoning(reasoning: string): void {
		this.#state.mutate({ type: "set_reasoning", reasoning });
	}

	openCommandFlow(screen: CommandFlowScreen): void {
		this.#commandFlow.open(screen);
	}

	insertSkillReference(commandId: string): void {
		this.#commands.insertSkillReference(commandId);
		this.#history.noteTextMutation();
		this.#state.mutate({ type: "set_error", value: undefined });
		this.invalidate();
	}

	stageAttachment(attachment: ChatAttachment): void {
		this.#attachments.mutate({ type: "stage", attachment });
		this.#state.mutate({ type: "set_error", value: undefined });
		this.invalidate();
	}

	override animationInterval(context: RenderContext): number | undefined {
		return this.#state.animationInterval(context, this.#lastIdleCtrlCAt);
	}

	setActivityOverride(key: string, text: string, present: boolean, motion: "active" | "waiting" = "waiting"): void {
		this.#state.mutate({ type: "set_activity_override", key, text, present, motion });
	}

	acceptRunEvidence(evidence: RunEvidenceEnvelope): void {
		this.#state.mutate({ type: "accept_run_evidence", evidence });
	}

	resynchronize(seed: AgentSeed, toolInvocations: readonly SessionToolLifecycle[], running: boolean): void {
		this.#state.mutate({ type: "resynchronize", seed, toolInvocations, running });
	}

	accept(event: AgentEvent): void {
		this.#state.project({ type: "agent_event", event });
	}

	acceptUserShell(snapshot: UserShellSnapshot): void {
		this.#state.project({ type: "user_shell", snapshot });
	}

	render({ width, height, now }: RenderContext): string[] {
		if (width < MINIMUM_CHAT_COLUMNS || height < MINIMUM_CHAT_ROWS)
			return renderTooSmall(width, height, this.running);

		const stateView = this.#state.view(now);
		const composerView = this.#composer.view();
		const attachmentProjection = this.#attachmentProjection();
		const attachmentView = this.#attachments.view(attachmentProjection);
		const focusedAttachmentTarget = attachmentView.focusedTarget;
		const editorFocused =
			this.focused &&
			focusedAttachmentTarget === undefined &&
			!attachmentView.imageModal &&
			this.#commandFlow.view === undefined;
		const editorFrame = this.#editor.render({
			width,
			height,
			focused: editorFocused,
			cursorMode: this.#theme.colorLevel === 0 ? "native" : "software",
			styleBorder: (value) =>
				this.#shellMode
					? this.#theme.style("error", value)
					: this.#theme.styleEditorBorder(stateView.reasoning, editorFocused, value),
			...(this.#shellMode ? { prefix: this.#theme.style("error", "! ") } : {}),
		});
		const attachmentLayout = this.#attachments.layout(width);
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
		const activity = stateView.activity;
		const activityRows = activity ? 1 : 0;
		const footerLines = this.#timelineRenderer.renderFooter({
			width,
			now,
			imageModal: attachmentView.imageModal,
			focusedAttachmentSource: focusedAttachmentTarget?.source,
			shellMode: this.#shellMode,
			unreadUpdates: this.#viewport.unreadUpdates,
			transcriptMode: this.#transcriptMode,
			running: stateView.agentRunning,
			hasPausedQueue: this.#hasPausedQueue,
			shellRunning: stateView.shellRunning,
			lastIdleCtrlCAt: this.#lastIdleCtrlCAt,
			modelLabel: stateView.modelLabel,
			reasoning: stateView.reasoning,
		});
		const dockRows = editorFrame.lines.length + attachmentRows + drawerRows + activityRows + footerLines.length;
		this.#lastDockRows = dockRows;
		const viewportHeight = height - 1 - dockRows;
		const blocks = this.#timelineRenderer.renderViewportBlocks({
			width,
			now,
			timeline: stateView.timeline,
			provisionalCards: composerView.provisionalCards,
			recoverableCards: composerView.recoverableCards,
			activeFollowUp: composerView.activeFollowUp,
			messageAttachments: attachmentView.messageAttachments,
			transcriptMode: this.#transcriptMode,
			error: stateView.error,
			notice: stateView.notice,
			runEvidence: stateView.runEvidence,
			attachmentFocusKey: attachmentView.focusKey,
		});
		this.#lastViewportBlocks = blocks;
		this.#lastViewportHeight = viewportHeight;
		const viewport = this.#viewport.layout(blocks, viewportHeight);
		const transcript = [...viewport.lines];
		while (transcript.length < viewportHeight) transcript.push("");

		const attachmentRow = height - dockRows + drawerRows;
		this.#attachments.setHitRegions([
			...viewport.sourceRows.flatMap((source, row) =>
				this.#timelineRenderer
					.attachmentHitRegions(source.blockId)
					.filter((region) => region.row === source.lineOffset)
					.map((region) => ({ ...region, row: 1 + row })),
			),
			...attachmentLayout.regions.map((region) => ({
				...region,
				row: attachmentRow + region.row,
			})),
		]);
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
		const preview = this.#attachments.preview({ width, height, now }, this.#lastDockRows, attachmentProjection);
		return preview ? renderPreviewOverlay(frame, preview.geometry, preview.attachment, width) : frame;
	}

	override cursorPlacement(): CursorPlacement | undefined {
		return this.#lastCursor;
	}

	override imagePlacements(context: RenderContext): readonly ImagePlacement[] {
		return this.#attachments.preview(context, this.#lastDockRows, this.#attachmentProjection())?.placements ?? [];
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		const attachmentProjection = this.#attachmentProjection();
		const attachmentView = this.#attachments.view(attachmentProjection);
		const attachmentPorts = {
			scrollBy: (delta: number) =>
				this.#viewport.scrollBy(this.#lastViewportBlocks, this.#lastViewportHeight, delta),
			requestImmediateRender: () => context.requestImmediateRender(),
		};
		const idleCtrlCPress =
			input.type === "key" &&
			input.action === "press" &&
			input.control &&
			input.key === "c" &&
			!this.running &&
			!this.#shellMode &&
			!this.#transcriptMode &&
			!attachmentView.imageModal &&
			attachmentView.focusedTarget === undefined &&
			this.#commandFlow.view === undefined &&
			this.#editor.text.trim().length === 0;
		if (input.type !== "key" || input.action !== "release") {
			if (!idleCtrlCPress) this.#lastIdleCtrlCAt = undefined;
		}
		if (input.type === "resize") return;
		if (this.#attachments.handleInput("overlay", input, attachmentProjection, attachmentPorts)) return;
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
				this.#composer.invokeCommand(commandResult.command);
				return;
			}
		}
		if (input.type === "key" && input.action !== "release") {
			if (this.#attachments.handleInput("entry", input, this.#attachmentProjection(), attachmentPorts)) return;
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
		this.#composer.handleInput(input, attachmentView.staged.length);
	}

	get #hasPausedQueue(): boolean {
		return this.#composer.view().hasPausedQueue;
	}

	get #shellMode(): boolean {
		return this.#composer.view().shellMode;
	}

	#attachmentProjection(): ChatAttachmentProjection {
		const composerView = this.#composer.view();
		return {
			timelineEntries: this.#state.view().timeline.entries,
			provisionalCards: composerView.provisionalCards,
			recoverableCards: composerView.recoverableCards,
			...(composerView.activeFollowUp ? { activeFollowUp: composerView.activeFollowUp } : {}),
		};
	}
	#requestNavigationRender(context: ComponentInputContext): void {
		this.invalidate();
		context.requestImmediateRender();
	}
}
