import type { Agent, AgentInput, QueueItemId } from "@coda/agent";
import {
	type DiagnosticSink,
	FullScreenTui,
	type Keybinding,
	type Scheduler,
	type Terminal,
	type TerminalImageSurface,
} from "@coda/tui";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Session } from "../session/types.ts";
import type { InteractiveApprovalHandler } from "./approval.ts";
import { type ChatAttachment, ChatComponent } from "./chat-component.ts";
import { type FullScreenOutputGate, FullScreenOutputScope } from "./full-screen-output.ts";
import { type AttachmentTransaction, InteractiveInputController } from "./input-controller.ts";
import {
	type InteractiveProcessLifecycle,
	type InteractiveTerminationSignal,
	interactiveSignalExitCode,
} from "./process-lifecycle.ts";
import { UserShell } from "./user-shell.ts";

export interface InteractiveRunOptions {
	readonly agent: Agent;
	readonly session: Session;
	readonly terminal: Terminal;
	readonly clock: { now(): number };
	readonly scheduler: Scheduler;
	readonly imageSurface?: TerminalImageSurface;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly approval?: InteractiveApprovalHandler;
	readonly modelLabel: string;
	readonly workspaceLabel?: string;
	readonly reasoning: string;
	readonly motion: "full" | "reduced";
	readonly initialPrompt?: AgentInput;
	readonly initialAttachmentIds?: readonly string[];
	readonly initialAttachments?: readonly ChatAttachment[];
	readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly buildPrompt?: (text: string, attachmentIds: readonly string[]) => Promise<AgentInput>;
	readonly prepareAttachments?: (attachmentIds: readonly string[]) => Promise<AttachmentTransaction>;
	readonly onAttach?: (path: string) => Promise<ChatAttachment>;
	readonly onDetach?: (attachmentId: string) => Promise<void>;
	readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
	readonly toolResultImagesSupported?: boolean;
	readonly lifecycle?: InteractiveProcessLifecycle;
	readonly allocateId: (kind: "composer_submission" | "user_shell") => string;
	readonly processRunner: ProcessRunner;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly workspace: string;
	readonly onWarning?: (message: string) => Promise<void> | void;
}

export async function runInteractive(options: InteractiveRunOptions): Promise<number> {
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	let tui!: FullScreenTui;
	let terminationSignal: InteractiveTerminationSignal | undefined;
	let fatalError: unknown;
	let suspendTask: Promise<void> | undefined;
	let component!: ChatComponent;
	const userShell = new UserShell({
		processRunner: options.processRunner,
		platform: options.platform,
		workspace: options.workspace,
		environment: options.environment,
		clock: options.clock,
		onUpdate: (snapshot) => component.acceptUserShell(snapshot),
	});
	const inputController = new InteractiveInputController({
		agent: options.agent,
		session: options.session,
		buildInput: options.buildPrompt ?? (async (text) => text),
		prepareAttachments: options.prepareAttachments ?? (async () => emptyAttachmentTransaction()),
		allocateId: options.allocateId,
		userShell,
	});
	component = new ChatComponent({
		modelLabel: options.modelLabel,
		workspaceLabel: options.workspaceLabel,
		reasoning: options.reasoning,
		colorLevel: options.terminal.capabilities.colorLevel,
		motion: options.motion,
		seed: {
			version: 1,
			messages: options.agent.state.messages,
			pendingFollowUps: options.agent.state.pendingFollowUps,
		},
		initialAttachments: options.initialAttachments,
		restoredAttachments: options.restoredAttachments,
		recoverableFollowUps: options.session.recoverableFollowUps,
		restoredToolInvocations: options.session.toolInvocations,
		composerSubmissions: options.session.composerSubmissions,
		onSubmit: (text, attachmentIds, composerText) => inputController.submit(text, attachmentIds, composerText),
		onSteer: (text, attachmentIds, composerText) => inputController.steer(text, attachmentIds, composerText),
		onFollowUp: (text, attachmentIds, composerText) => inputController.followUp(text, attachmentIds, composerText),
		onUserShell: (command) => inputController.submitUserShell(command),
		onResumeFollowUps: () => inputController.resumeQueue(),
		isQueuePaused: () => inputController.queuePaused,
		onReclaimFollowUp: (queueItemId) => inputController.reclaimFollowUp(queueItemId as QueueItemId),
		onReclaimUserShell: (id) => inputController.reclaimUserShell(id),
		onAttach: options.onAttach,
		onDetach: options.onDetach,
		onOpenAttachment: options.onOpenAttachment,
		imagePreviewSupported: options.imageSurface?.capability !== null,
		toolResultImagesSupported: options.toolResultImagesSupported,
		onAbort: () => inputController.abortAgent(),
		onAbortUserShell: () => {
			inputController.cancelUserShell();
		},
		onExit: resolveExit,
	});
	tui = new FullScreenTui({
		terminal: options.terminal,
		root: component,
		clock: options.clock,
		scheduler: options.scheduler,
		imageSurface: options.imageSurface,
		keybindings: options.keybindings,
		diagnostics: options.diagnostics,
	});
	const outputScope = new FullScreenOutputScope(options.fullScreenOutput, {
		presentDiagnostic: (diagnostic) => tui.presentDiagnostic(diagnostic),
	});
	const startFullScreen = () => outputScope.start(() => tui.start());
	const stopFullScreen = () => outputScope.stop(() => tui.stop());
	const requestTermination = (signal: InteractiveTerminationSignal): void => {
		terminationSignal ??= signal;
		if (options.agent.state.status === "running") {
			try {
				options.agent.abort();
			} catch {}
		}
		inputController.cancelUserShell();
		resolveExit();
	};
	const requestFatalExit = (error: unknown): void => {
		fatalError ??= error;
		if (options.agent.state.status === "running") {
			try {
				options.agent.abort();
			} catch {}
		}
		inputController.cancelUserShell();
		resolveExit();
	};
	const unsubscribeLifecycle = options.lifecycle?.subscribe({
		terminate: requestTermination,
		fatal: requestFatalExit,
		suspend: () => {
			if (suspendTask) return;
			suspendTask = (async () => {
				if (tui.started) await stopFullScreen();
				await options.lifecycle!.suspend();
				if (!(await startFullScreen())) throw new Error("Terminal was unavailable after process resume");
			})().catch(requestFatalExit);
			void suspendTask.finally(() => {
				suspendTask = undefined;
			});
		},
	});
	options.approval?.bind(tui, options.terminal, (request) => component.setAwaitingApproval(request));
	const detach = options.agent.onEvent((event) => {
		component.accept(event);
	});
	try {
		if (!(await startFullScreen())) {
			throw new Error("Interactive full-screen mode is unavailable; use --no-tui for print mode");
		}
		if (options.initialPrompt !== undefined) {
			await inputController.submitInput(options.initialPrompt, options.initialAttachmentIds);
		}
		await exited;
		if (options.agent.state.status !== "idle") {
			try {
				await options.agent.waitForIdle();
			} catch (error) {
				fatalError ??= error;
			}
		}
		await inputController.waitForIdle();
		if (fatalError !== undefined) throw fatalError;
		return terminationSignal ? interactiveSignalExitCode(terminationSignal) : 0;
	} finally {
		unsubscribeLifecycle?.();
		options.approval?.unbind();
		detach();
		const droppedShells = await inputController.dispose();
		await stopFullScreen();
		if (droppedShells > 0) {
			await options.onWarning?.(
				`Dropped ${droppedShells} queued local Shell command${droppedShells === 1 ? "" : "s"} on exit`,
			);
		}
	}
}

function emptyAttachmentTransaction(): AttachmentTransaction {
	return {
		commit: async () => undefined,
		rollback: async () => undefined,
	};
}
