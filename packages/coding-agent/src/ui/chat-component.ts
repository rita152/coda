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
import type { CommandDefinition } from "../commands/types.ts";
import type { RunEvidenceEnvelope } from "../run-evidence/run-evidence.ts";
import type { ComposerExtensionReference, ComposerSubmission } from "../session/composer-submission.ts";
import type { RecoverableFollowUp, SessionToolLifecycle } from "../session/types.ts";
import { ActivityProjection, type ActivitySummaryMode } from "./activity-status.ts";
import { renderActivityStatus } from "./activity-status-presentation.ts";
import { ChatAttachmentController, type ChatAttachmentProjection } from "./chat-attachments.ts";
import { ChatComposerController, invokeChatCommand, type ProvisionalPromptCard } from "./chat-composer.ts";
import {
	followUpText,
	MINIMUM_CHAT_COLUMNS,
	MINIMUM_CHAT_ROWS,
	renderHeader,
	renderPreviewOverlay,
	renderTooSmall,
	shellActivation,
} from "./chat-rendering.ts";
import { ChatTimelineRenderer, IDLE_CTRL_C_CONFIRMATION_WINDOW_MS } from "./chat-timeline-renderer.ts";
import { CommandComposer, renderCommandPalette } from "./command-composer.ts";
import { CommandFlowHost, type CommandFlowScreen, renderCommandFlow } from "./command-flow-host.ts";
import { ComposerHistory } from "./composer-history.ts";
import { extensionReferencesFromMarkers } from "./extension-references.ts";
import type { UserShellSubmission } from "./input-types.ts";
import { SemanticTimeline } from "./semantic-timeline.ts";
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
	#timeline: SemanticTimeline;
	#activity: ActivityProjection;
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
	#running = false;
	#shellRunning = false;
	#transcriptMode = false;
	#lastIdleCtrlCAt?: number;
	#error?: string;
	#notice?: string;
	#runEvidence?: RunEvidenceEnvelope;
	readonly #attachments: ChatAttachmentController;
	readonly #composer: ChatComposerController;
	#modelLabel: string;
	#reasoning: string;

	constructor(options: ChatComponentOptions) {
		super({ focusable: true });
		this.#options = options;
		this.#timeline = new SemanticTimeline(options.seed, options.restoredToolInvocations);
		this.#activity = new ActivityProjection(options.activitySummaryMode);
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
				this.#error = message;
			},
		});
		this.#composer = new ChatComposerController({
			isQueuePaused: options.isQueuePaused,
			attachments: this.#attachments,
			recoverableFollowUps: options.recoverableFollowUps,
			restoredAttachments: options.restoredAttachments,
		});
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
		this.#attachments.mutate({ type: "stage", attachment });
		this.#error = undefined;
		this.invalidate();
	}

	override animationInterval(context: RenderContext): number | undefined {
		if (context.width < MINIMUM_CHAT_COLUMNS || context.height < MINIMUM_CHAT_ROWS) return undefined;
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

	resynchronize(seed: AgentSeed, toolInvocations: readonly SessionToolLifecycle[], running: boolean): void {
		this.#timeline = new SemanticTimeline(seed, toolInvocations);
		this.#activity = new ActivityProjection(this.#options.activitySummaryMode);
		this.#running = running;
		this.#composer.project({ type: "resynchronize" });
		this.#timelineRenderer.resetTimelineCaches();
		this.invalidate();
	}

	accept(event: AgentEvent): void {
		this.#activity.accept(event);
		if (event.type === "run_start") {
			this.#attachments.mutate({ type: "accept_run_start", messageId: event.inputMessage.id });
		}
		this.#composer.project({ type: "before_agent_event", event });
		const mutation = this.#timeline.accept(event);
		switch (event.type) {
			case "run_start":
				this.#running = true;
				this.#notice = undefined;
				this.#runEvidence = undefined;
				break;
			case "run_end":
				this.#running = false;
				if (event.outcome === "error") {
					this.#error = event.failure?.message ?? "Run failed";
				}
				break;
		}
		this.#composer.project({ type: "after_agent_event", event });
		if (mutation.changed) this.#viewport.noteUpdate();
		this.invalidate();
	}

	acceptUserShell(snapshot: UserShellSnapshot): void {
		this.#activity.acceptUserShell(snapshot, this.#options.clock.now());
		if (snapshot.status === "running") {
			// A resumed mixed queue may optimistically mark an Agent Run as pending before
			// discovering that its next item is a local Shell command.
			this.#running = false;
		}
		this.#composer.project({ type: "user_shell", snapshot });
		this.#shellRunning = snapshot.status === "running";
		this.#timeline.acceptUserShell(snapshot);
		this.#viewport.noteUpdate();
		this.invalidate();
	}

	render({ width, height, now }: RenderContext): string[] {
		if (width < MINIMUM_CHAT_COLUMNS || height < MINIMUM_CHAT_ROWS)
			return renderTooSmall(width, height, this.running);

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
					: this.#theme.styleEditorBorder(this.#reasoning, editorFocused, value),
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
		const activity = this.#activity.status(now);
		const activityRows = activity ? 1 : 0;
		const footerLines = this.#timelineRenderer.renderFooter({
			width,
			now,
			imageModal: attachmentView.imageModal,
			focusedAttachmentSource: focusedAttachmentTarget?.source,
			shellMode: this.#shellMode,
			unreadUpdates: this.#viewport.unreadUpdates,
			transcriptMode: this.#transcriptMode,
			running: this.#running,
			hasPausedQueue: this.#hasPausedQueue,
			shellRunning: this.#shellRunning,
			lastIdleCtrlCAt: this.#lastIdleCtrlCAt,
			modelLabel: this.#modelLabel,
			reasoning: this.#reasoning,
		});
		const dockRows = editorFrame.lines.length + attachmentRows + drawerRows + activityRows + footerLines.length;
		this.#lastDockRows = dockRows;
		const viewportHeight = height - 1 - dockRows;
		const blocks = this.#timelineRenderer.renderViewportBlocks({
			width,
			now,
			timeline: this.#timeline,
			provisionalCards: composerView.provisionalCards,
			recoverableCards: composerView.recoverableCards,
			activeFollowUp: composerView.activeFollowUp,
			messageAttachments: attachmentView.messageAttachments,
			transcriptMode: this.#transcriptMode,
			error: this.#error,
			notice: this.#notice,
			runEvidence: this.#runEvidence,
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
				this.#invokeCommand(commandResult.command);
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
		if (input.type === "key" && input.alt && input.key === "up") {
			void this.#reclaimLatestQueuedInput();
			return;
		}
		if (input.type === "key" && input.control && input.key === "c") {
			if (this.#shellRunning) this.#options.onAbortUserShell?.();
			else if (this.#running) this.#options.onAbort();
			else if (this.#shellMode || this.#editor.text.length > 0) {
				this.#editor.clear();
				this.#composer.mutate({ type: "set_shell_mode", value: false });
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
					this.#composer.mutate({ type: "set_shell_mode", value: false });
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
				this.#composer.mutate({ type: "set_shell_mode", value: true });
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
				this.#composer.mutate({ type: "set_shell_mode", value: false });
				this.#error = undefined;
			} else if (this.#editor.text !== before) this.#error = undefined;
			this.invalidate();
			return;
		}
		const before = this.#editor.text;
		const editorResult = this.#editor.handleInput(editorInput);
		if (editorResult.type === "handled") {
			if (!this.#shellMode && this.#editor.absorbPrefix("!")) {
				this.#composer.mutate({ type: "set_shell_mode", value: true });
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
		if (value.length === 0 && attachmentView.staged.length === 0 && this.#hasPausedQueue) {
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
		if (submissionText.length === 0 && attachmentView.staged.length === 0) return;
		const submittedAttachments = this.#attachments.mutate({
			type: "take_submission",
			prompt: kind === "prompt",
		})!;
		const submittedComposerState = this.#editor.captureState();
		const provisional = this.#composer.mutate({
			type: "create_provisional",
			kind,
			text: submissionText,
			attachments: submittedAttachments,
			status: kind === "steering" ? "Steering queued" : kind === "follow_up" ? "Follow-up queued" : undefined,
		})!;
		this.#editor.clear();
		this.#history.reset();
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
					this.#composer.mutate({ type: "set_queue_item", id: provisional.id, queueItemId });
				}
				this.invalidate();
			},
			(error: unknown) => {
				if (kind === "prompt" || appendsPausedQueue) {
					this.#running = false;
					this.#activity.cancelPreparation();
				}
				this.#composer.mutate({ type: "remove_provisional", id: provisional.id });
				this.#attachments.mutate({ type: "restore_submission", attachments: submittedAttachments });
				if (!this.#editor.text) this.#editor.restoreState(submittedComposerState);
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
			},
		);
	}

	get #hasPausedQueue(): boolean {
		return this.#composer.view().hasPausedQueue;
	}

	get #shellMode(): boolean {
		return this.#composer.view().shellMode;
	}

	#submitUserShell(command: string): void {
		const provisional = this.#composer.mutate({
			type: "create_provisional",
			kind: "user_shell",
			text: `!${command}`,
			attachments: [],
			status: "Shell queued",
		})!;
		this.#editor.clear();
		this.#composer.mutate({ type: "set_shell_mode", value: false });
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
				this.#composer.mutate({ type: "set_queue_item", id: provisional.id, queueItemId: submission.id });
				this.invalidate();
			},
			(error: unknown) => {
				this.#composer.mutate({ type: "remove_provisional", id: provisional.id });
				if (!this.#editor.text) this.#editor.setText(command);
				this.#composer.mutate({ type: "set_shell_mode", value: true });
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
			},
		);
	}

	async #reclaimLatestQueuedInput(): Promise<void> {
		const composerView = this.#composer.view();
		const provisional = [...composerView.provisionalCards]
			.reverse()
			.find((card) => card.kind === "follow_up" || card.kind === "user_shell");
		if (provisional && !provisional.queueItemId) return;
		const recoverable = provisional ? undefined : composerView.recoverableCards.at(-1);
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
				this.#composer.mutate({ type: "remove_provisional", id: provisional.id });
			} else if (recoverable) {
				this.#composer.mutate({ type: "remove_recoverable", card: recoverable });
			}
			this.#editor.setText(text);
			this.#history.reset();
			this.#composer.mutate({ type: "set_shell_mode", value: provisional?.kind === "user_shell" });
			this.#attachments.mutate({ type: "reclaim", attachments });
			this.#error = undefined;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.invalidate();
	}

	#attachmentProjection(): ChatAttachmentProjection {
		const composerView = this.#composer.view();
		return {
			timelineEntries: this.#timeline.entries,
			provisionalCards: composerView.provisionalCards,
			recoverableCards: composerView.recoverableCards,
			...(composerView.activeFollowUp ? { activeFollowUp: composerView.activeFollowUp } : {}),
		};
	}

	#invokeCommand(command: CommandDefinition, argument?: string): void {
		invokeChatCommand({
			command,
			...(argument === undefined ? {} : { argument }),
			editor: this.#editor,
			history: this.#history,
			flow: this.#commandFlow,
			onCommand: this.#options.onCommand,
			setError: (value) => {
				this.#error = value;
			},
			setNotice: (value) => {
				this.#notice = value;
			},
			invalidate: () => this.invalidate(),
		});
	}

	#requestNavigationRender(context: ComponentInputContext): void {
		this.invalidate();
		context.requestImmediateRender();
	}
}
