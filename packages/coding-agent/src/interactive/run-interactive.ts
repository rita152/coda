import type { Agent, AgentInput, QueueItemId } from "@coda/agent";
import type { ModelThinkingLevel } from "@coda/ai";
import {
	type DiagnosticSink,
	FullScreenTui,
	type Keybinding,
	type Scheduler,
	type Terminal,
	type TerminalImageSurface,
} from "@coda/tui";
import {
	type AuthCommandFlowOptions,
	type AuthProviderEntry,
	createAuthCommandFlow,
	createProviderAuthFlow,
} from "../commands/auth-flow.ts";
import { createContextOverflowFlow } from "../commands/context-overflow-flow.ts";
import { createEffortCommandFlow } from "../commands/effort-flow.ts";
import { type McpCommandFlowOptions, openMcpCommand } from "../commands/mcp-flow.ts";
import { createModelCommandFlow, type ModelCommandEntry } from "../commands/model-flow.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { createSessionCommandFlow, type SessionCommandEntry } from "../commands/session-flow.ts";
import { createSkillSelectionCommandFlow, createSkillsCommandFlow } from "../commands/skills-flow.ts";
import { isContextOverflowError, isProviderContextOverflow } from "../context-window/overflow-recovery.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { CustomProviderInput } from "../providers/types.ts";
import type { CatalogModel } from "../runtime/model-catalog.ts";
import { WorkspaceSessionRuntimes } from "../runtime/workspace-session-runtimes.ts";
import type { Session } from "../session/types.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import type { ActivitySummaryMode } from "./activity-status.ts";
import { type ChatAttachment, ChatComponent } from "./chat-component.ts";
import type { CommandFlowNavigation } from "./command-flow-host.ts";
import { type FullScreenOutputGate, FullScreenOutputScope } from "./full-screen-output.ts";
import { WorkspaceGitStatus } from "./git-status.ts";
import {
	type AttachmentTransaction,
	InteractiveInputController,
	type InteractiveInputControllerOptions,
} from "./input-controller.ts";
import type { ComposerExtensionReference } from "./input-types.ts";
import type { InteractiveMcpElicitationHandler } from "./mcp-elicitation.ts";
import {
	type InteractiveProcessLifecycle,
	type InteractiveTerminationSignal,
	interactiveSignalExitCode,
} from "./process-lifecycle.ts";
import type { SessionStatusLineSnapshot, StatusLineSnapshot } from "./status-line.ts";
import { SwitchableComponent } from "./switchable-component.ts";
import { UserShell } from "./user-shell.ts";

export interface InteractiveSessionOptions {
	readonly agent: Agent;
	readonly session: Session;
	readonly modelLabel: string;
	readonly activitySummaryMode?: ActivitySummaryMode;
	readonly statusLine: () => SessionStatusLineSnapshot;
	readonly modelCommand?: {
		readonly list: () => Promise<readonly ModelCommandEntry[]>;
		readonly currentKey: () => string;
		readonly select: (model: CatalogModel) => Promise<{
			readonly modelLabel: string;
			readonly reasoning: string;
			readonly activitySummaryMode: ActivitySummaryMode;
		}>;
		readonly authenticate: (providerId: string, navigation: CommandFlowNavigation) => Promise<void> | void;
	};
	readonly effortCommand?: {
		readonly snapshot: () => {
			readonly current: ModelThinkingLevel;
			readonly available: readonly ModelThinkingLevel[];
		};
		readonly select: (effort: ModelThinkingLevel) => Promise<ModelThinkingLevel> | ModelThinkingLevel;
	};
	readonly authCommand?: {
		readonly providers: () => Promise<readonly AuthProviderEntry[]>;
		readonly updateApiKey: (providerId: string, apiKey: string) => Promise<void> | void;
		readonly logout: (providerId: string) => Promise<void> | void;
		readonly addCustomProvider: (input: CustomProviderInput) => Promise<void> | void;
	};
	readonly skillsCommand?: {
		readonly snapshot: () => Promise<CodingSkillsSnapshot>;
		readonly refresh: () => Promise<CodingSkillsSnapshot>;
	};
	readonly mcpCommand?: McpCommandFlowOptions;
	readonly compactCommand?: {
		readonly run: (focus?: string) => Promise<string> | string;
	};
	readonly contextOverflowRecovery?: {
		takeUnrecoverable(): boolean;
	};
	readonly reasoning: string;
	readonly initialPrompt?: AgentInput;
	readonly initialAttachmentIds?: readonly string[];
	readonly initialAttachments?: readonly ChatAttachment[];
	readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly buildPrompt?: InteractiveInputControllerOptions["buildInput"];
	readonly prepareAttachments?: (attachmentIds: readonly string[]) => Promise<AttachmentTransaction>;
	readonly onDetach?: (attachmentId: string) => Promise<void>;
	readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
	readonly toolResultImagesSupported?: boolean;
	readonly onRetire?: () => Promise<void> | void;
	readonly resolveExtensionReferences?: (
		references: readonly ComposerExtensionReference[],
		composerText: string,
	) => Promise<void> | void;
}

export interface InteractiveSessionCommand {
	readonly list: () => Promise<readonly Omit<SessionCommandEntry, "status">[]>;
	readonly open: (sessionId: string) => Promise<InteractiveSessionOptions>;
	readonly create: () => Promise<InteractiveSessionOptions>;
}

export interface InteractiveRunOptions extends InteractiveSessionOptions {
	readonly terminal: Terminal;
	readonly clock: { now(): number };
	readonly scheduler: Scheduler;
	readonly imageSurface?: TerminalImageSurface;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly mcpElicitation?: InteractiveMcpElicitationHandler;
	readonly motion: "full" | "reduced";
	readonly commandRegistry?: CommandRegistry;
	readonly sessionCommand?: InteractiveSessionCommand;
	readonly onContextOverflowReplacement?: (replacement: InteractiveSessionOptions) => Promise<void> | void;
	readonly lifecycle?: InteractiveProcessLifecycle;
	readonly allocateId: (kind: "composer_submission" | "user_shell") => string;
	readonly processRunner: ProcessRunner;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly workspace: string;
	readonly homePath?: string;
	readonly onWarning?: (message: string) => Promise<void> | void;
}

export async function runInteractive(options: InteractiveRunOptions): Promise<number> {
	const components = new Set<ChatComponent>();
	const git = new WorkspaceGitStatus({
		processRunner: options.processRunner,
		workspace: options.workspace,
		environment: options.environment,
		scheduler: options.scheduler,
		onChange: () => {
			for (const component of components) component.invalidate();
		},
	});
	try {
		if (options.sessionCommand) return await runMultiSessionInteractive(options, git, components);
		return await runSingleSessionInteractive(options, git, components);
	} finally {
		git.dispose();
	}
}

interface InteractivePane {
	readonly id: string;
	readonly options: InteractiveSessionOptions;
	readonly component: ChatComponent;
	readonly input: InteractiveInputController;
	readonly userShell: UserShell;
	readonly detachAgent: () => void;
	initialStarted: boolean;
	needsAttention: boolean;
	contextOverflowPending: boolean;
	contextOverflowOffered: boolean;
	providerOverflowObserved: boolean;
	replacement?: Promise<void>;
}

async function runMultiSessionInteractive(
	options: InteractiveRunOptions,
	git: WorkspaceGitStatus,
	components: Set<ChatComponent>,
): Promise<number> {
	const sessionCommand = options.sessionCommand!;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	let tui!: FullScreenTui;
	let root!: SwitchableComponent;
	let runtimes!: WorkspaceSessionRuntimes<InteractivePane>;
	let terminationSignal: InteractiveTerminationSignal | undefined;
	let fatalError: unknown;
	let suspendTask: Promise<void> | undefined;

	const authOptionsFor = async (sessionOptions: InteractiveSessionOptions): Promise<AuthCommandFlowOptions> => {
		if (!sessionOptions.authCommand) throw new Error("Authentication management is unavailable");
		return {
			providers: await sessionOptions.authCommand.providers(),
			onUpdateApiKey: sessionOptions.authCommand.updateApiKey,
			onLogout: sessionOptions.authCommand.logout,
			onAddCustomProvider: sessionOptions.authCommand.addCustomProvider,
		};
	};

	const sessionEntries = async (): Promise<readonly SessionCommandEntry[]> => {
		const activeId = runtimes.active.id;
		const listed = [...(await sessionCommand.list())];
		const listedIds = new Set(listed.map(({ id }) => id));
		for (const pane of runtimes.open) {
			if (listedIds.has(pane.id)) continue;
			listed.push(
				Object.freeze({
					id: pane.id,
					label: pane.id,
					description: "Open in this CLI",
				}),
			);
		}
		return listed.map((entry) => {
			const open = runtimes.get(entry.id);
			return Object.freeze({
				...entry,
				status:
					entry.id === activeId
						? "current"
						: open?.needsAttention
							? "needs attention"
							: open?.options.agent.state.status === "running"
								? "running"
								: "idle",
			});
		});
	};

	const selectPane = async (sessionId: string): Promise<void> => {
		const pane = await runtimes.focus(sessionId, async () => createPane(await sessionCommand.open(sessionId)));
		root.select(pane.component);
		pane.needsAttention = false;
		options.mcpElicitation?.setActiveSession(pane.id);
		await startPane(pane);
		if (pane.contextOverflowPending) offerContextOverflowRecovery(pane);
	};

	const createSession = async (): Promise<void> => {
		const result = await runtimes.create(async () => createPane(await sessionCommand.create()));
		root.select(result.runtime.component);
		result.runtime.needsAttention = false;
		options.mcpElicitation?.setActiveSession(result.runtime.id);
		await startPane(result.runtime);
	};

	const replaceAfterContextOverflow = async (pane: InteractivePane): Promise<void> => {
		if (pane.replacement) return pane.replacement;
		const operation = (async () => {
			const replacementOptions = await sessionCommand.create();
			assertEmptyReplacementSession(pane.options, replacementOptions);
			const replacement = createPane(replacementOptions);
			const replaced = runtimes.replaceActive(replacement);
			if (replaced !== pane) throw new Error("Context Overflow replacement no longer matches the active Session");
			root.select(replacement.component);
			replacement.needsAttention = false;
			options.mcpElicitation?.setActiveSession(replacement.id);
			await startPane(replacement);
			await options.onContextOverflowReplacement?.(replacement.options);
			try {
				await retirePane(pane);
			} catch (error) {
				await options.onWarning?.(
					`Could not fully close overflowed Session ${pane.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		})();
		pane.replacement = operation;
		try {
			await operation;
		} finally {
			if (pane.replacement === operation) pane.replacement = undefined;
		}
	};

	const offerContextOverflowRecovery = (pane: InteractivePane): void => {
		if (pane.contextOverflowOffered) return;
		pane.contextOverflowOffered = true;
		pane.component.openCommandFlow(
			createContextOverflowFlow({
				openEmptySession: () => replaceAfterContextOverflow(pane),
			}),
		);
	};

	const retirePane = async (pane: InteractivePane): Promise<void> => {
		pane.detachAgent();
		components.delete(pane.component);
		const failures: unknown[] = [];
		let droppedShells = 0;
		try {
			droppedShells = await pane.input.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await pane.options.onRetire?.();
		} catch (error) {
			failures.push(error);
		}
		try {
			await pane.options.session.close();
		} catch (error) {
			failures.push(error);
		}
		if (droppedShells > 0) {
			await options.onWarning?.(
				`Dropped ${droppedShells} queued local Shell command${droppedShells === 1 ? "" : "s"} from overflowed Session ${pane.id}`,
			);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Could not retire overflowed Session runtime");
	};

	const createPane = (sessionOptions: InteractiveSessionOptions): InteractivePane => {
		let component!: ChatComponent;
		const userShell = new UserShell({
			processRunner: options.processRunner,
			platform: options.platform,
			workspace: options.workspace,
			environment: options.environment,
			clock: options.clock,
			onUpdate: (snapshot) => {
				component.acceptUserShell(snapshot);
				if (snapshot.status !== "running") void git.refresh();
			},
		});
		const input = new InteractiveInputController({
			agent: sessionOptions.agent,
			session: sessionOptions.session,
			buildInput: sessionOptions.buildPrompt ?? (async (text) => text),
			prepareAttachments: sessionOptions.prepareAttachments ?? (async () => emptyAttachmentTransaction()),
			allocateId: options.allocateId,
			userShell,
		});
		component = new ChatComponent({
			modelLabel: sessionOptions.modelLabel,
			activitySummaryMode: sessionOptions.activitySummaryMode,
			reasoning: sessionOptions.reasoning,
			statusLine: () => statusLineSnapshot(options, sessionOptions, git),
			clock: options.clock,
			colorLevel: options.terminal.capabilities.colorLevel,
			appearance: options.terminal.capabilities.appearance,
			motion: options.motion,
			commandRegistry: options.commandRegistry,
			seed: {
				version: 1,
				messages: sessionOptions.agent.state.messages,
				pendingFollowUps: sessionOptions.agent.state.pendingFollowUps,
			},
			initialAttachments: sessionOptions.initialAttachments,
			restoredAttachments: sessionOptions.restoredAttachments,
			recoverableFollowUps: sessionOptions.session.recoverableFollowUps,
			restoredToolInvocations: sessionOptions.session.toolInvocations,
			composerSubmissions: sessionOptions.session.composerSubmissions,
			onResolveExtensionReferences: sessionOptions.resolveExtensionReferences,
			onSubmit: (text, attachmentIds, composerText, references) =>
				input.submit(text, attachmentIds, composerText, references),
			onSteer: (text, attachmentIds, composerText, references) =>
				input.steer(text, attachmentIds, composerText, references),
			onFollowUp: (text, attachmentIds, composerText, references) =>
				input.followUp(text, attachmentIds, composerText, references),
			onUserShell: (command) => input.submitUserShell(command),
			onCommand: async (commandId, flow, argument) => {
				if (commandId === "core:auth") {
					flow.open(createAuthCommandFlow(await authOptionsFor(sessionOptions)));
					return;
				}
				if (commandId === "core:model") {
					if (!sessionOptions.modelCommand) throw new Error("Model selection is unavailable");
					flow.open(
						createModelCommandFlow({
							currentKey: sessionOptions.modelCommand.currentKey(),
							models: await sessionOptions.modelCommand.list(),
							onSelect: async (selected) => {
								const presentation = await sessionOptions.modelCommand!.select(selected);
								component.setModelPresentation(
									presentation.modelLabel,
									presentation.reasoning,
									presentation.activitySummaryMode,
								);
							},
							onAuthenticate: async (providerId, navigation) => {
								if (!sessionOptions.authCommand) {
									await sessionOptions.modelCommand!.authenticate(providerId, navigation);
									return;
								}
								const authOptions = await authOptionsFor(sessionOptions);
								const provider = authOptions.providers.find(({ id }) => id === providerId);
								if (!provider) throw new Error(`Unknown provider: ${providerId}`);
								navigation.push(createProviderAuthFlow(provider, authOptions));
							},
						}),
					);
					return;
				}
				if (commandId === "core:effort") {
					if (!sessionOptions.effortCommand) throw new Error("Reasoning effort selection is unavailable");
					const snapshot = sessionOptions.effortCommand.snapshot();
					flow.open(
						createEffortCommandFlow({
							...snapshot,
							onSelect: async (selected) => {
								const reasoning = await sessionOptions.effortCommand!.select(selected);
								component.setReasoning(reasoning);
							},
						}),
					);
					return;
				}
				if (commandId === "core:skills") {
					if (!sessionOptions.skillsCommand) throw new Error("Skills management is unavailable");
					flow.open(
						createSkillsCommandFlow({
							snapshot: await sessionOptions.skillsCommand.snapshot(),
							onRefresh: sessionOptions.skillsCommand.refresh,
						}),
					);
					return;
				}
				if (commandId === "core:skill") {
					if (!sessionOptions.skillsCommand) throw new Error("Skill selection is unavailable");
					flow.open(
						createSkillSelectionCommandFlow({
							snapshot: await sessionOptions.skillsCommand.snapshot(),
							onSelect: (selectedCommandId, navigation) => {
								component.insertSkillReference(selectedCommandId);
								navigation.close();
							},
						}),
					);
					return;
				}
				if (commandId === "core:mcp") {
					if (!sessionOptions.mcpCommand) throw new Error("MCP management is unavailable");
					await openMcpCommand(flow, argument, sessionOptions.mcpCommand);
					return;
				}
				if (commandId === "core:session") {
					flow.open(
						createSessionCommandFlow({
							sessions: await sessionEntries(),
							onSelect: selectPane,
						}),
					);
					return;
				}
				if (commandId === "core:new") {
					await createSession();
					return;
				}
				if (commandId === "core:compact") {
					if (!sessionOptions.compactCommand) throw new Error("Context compaction is unavailable");
					component.setActivityOverride("command:compact", "Compacting context...", true, "active");
					try {
						return await sessionOptions.compactCommand.run(argument);
					} finally {
						component.setActivityOverride("command:compact", "", false);
					}
				}
				throw new Error(`Command is not available yet: ${commandId}`);
			},
			onResumeFollowUps: () => input.resumeQueue(),
			isQueuePaused: () => input.queuePaused,
			onReclaimFollowUp: (queueItemId) => input.reclaimFollowUp(queueItemId as QueueItemId),
			onReclaimUserShell: (id) => input.reclaimUserShell(id),
			onDetach: sessionOptions.onDetach,
			onOpenAttachment: sessionOptions.onOpenAttachment,
			imagePreviewSupported: options.imageSurface?.capability !== null,
			toolResultImagesSupported: sessionOptions.toolResultImagesSupported,
			onAbort: () => input.abortAgent(),
			onAbortUserShell: () => {
				input.cancelUserShell();
			},
			onExit: resolveExit,
		});
		acceptLatestRunEvidence(component, sessionOptions.session);
		components.add(component);
		let pane!: InteractivePane;
		const detachAgent = sessionOptions.agent.onEvent((event) => {
			component.accept(event);
			if (event.type === "run_end") acceptLatestRunEvidence(component, sessionOptions.session, event.runId);
			if (event.type === "tool_execution_end" || event.type === "tool_execution_rejected") void git.refresh();
			if (event.type === "run_start") {
				pane.contextOverflowPending = false;
				pane.contextOverflowOffered = false;
				pane.providerOverflowObserved = false;
			}
			if (
				event.type === "attempt_end" &&
				event.outcome === "error" &&
				isProviderContextOverflow(event.candidate.message)
			) {
				pane.providerOverflowObserved = true;
			}
			if (event.type === "retry_scheduled" && event.reason === "context overflow compacted") {
				pane.providerOverflowObserved = false;
			}
			if (event.type === "run_end") {
				const runtimeOverflow = sessionOptions.contextOverflowRecovery?.takeUnrecoverable() ?? false;
				if (
					event.outcome === "error" &&
					(pane.providerOverflowObserved ||
						runtimeOverflow ||
						isContextOverflowError(event.failure?.message ?? ""))
				) {
					if (event.failure?.kind === "runtime") pane.input.acknowledgeAgentRuntimeFailure();
					pane.contextOverflowPending = true;
					if (pane === runtimes.active) offerContextOverflowRecovery(pane);
					else pane.needsAttention = true;
				}
			}
		});
		pane = {
			id: sessionOptions.session.descriptor.id,
			options: sessionOptions,
			component,
			input,
			userShell,
			detachAgent,
			initialStarted: false,
			needsAttention: false,
			contextOverflowPending: false,
			contextOverflowOffered: false,
			providerOverflowObserved: false,
		};
		return pane;
	};

	const startPane = async (pane: InteractivePane): Promise<void> => {
		if (pane.initialStarted) return;
		pane.initialStarted = true;
		if (pane.options.initialPrompt !== undefined) {
			await pane.input.submitInput(pane.options.initialPrompt, pane.options.initialAttachmentIds);
		}
	};

	const initialPane = createPane(options);
	runtimes = new WorkspaceSessionRuntimes(initialPane, {
		id: (pane) => pane.id,
		isEmpty: (pane) =>
			pane.options.agent.state.status === "idle" &&
			pane.options.agent.state.messages.length === 0 &&
			pane.options.agent.state.pendingFollowUps.length === 0,
	});
	root = new SwitchableComponent(initialPane.component);
	tui = new FullScreenTui({
		terminal: options.terminal,
		root,
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
	const abortAll = (): void => {
		for (const pane of runtimes.open) {
			if (pane.options.agent.state.status === "running") {
				try {
					pane.options.agent.abort();
				} catch {}
			}
			pane.input.cancelUserShell();
		}
	};
	const requestTermination = (signal: InteractiveTerminationSignal): void => {
		terminationSignal ??= signal;
		options.mcpElicitation?.unbind();
		abortAll();
		resolveExit();
	};
	const requestFatalExit = (error: unknown): void => {
		fatalError ??= error;
		options.mcpElicitation?.unbind();
		abortAll();
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
	options.mcpElicitation?.bind(tui, options.terminal, (request, sessionId, waiting) => {
		const pane = sessionId ? runtimes.get(sessionId) : runtimes.active;
		if (!pane) return;
		pane.component.setActivityOverride(
			`mcp:${request.execution.invocationId}`,
			`Waiting for MCP input — ${request.tool.remoteName}`,
			waiting,
		);
		if (waiting && pane !== runtimes.active) pane.needsAttention = true;
	});
	options.mcpElicitation?.setActiveSession(initialPane.id);
	if (terminationSignal || fatalError !== undefined) {
		options.mcpElicitation?.unbind();
	}
	try {
		if (!(await startFullScreen())) {
			throw new Error("Interactive full-screen mode is unavailable; use --no-tui for print mode");
		}
		git.start();
		await startPane(initialPane);
		await exited;
		abortAll();
		for (const pane of runtimes.open) {
			try {
				await pane.input.discardPendingFollowUps();
				if (pane.options.agent.state.status !== "idle") await pane.options.agent.waitForIdle();
				await pane.input.waitForIdle();
			} catch (error) {
				fatalError ??= error;
			}
		}
		if (fatalError !== undefined) throw fatalError;
		return terminationSignal ? interactiveSignalExitCode(terminationSignal) : 0;
	} finally {
		unsubscribeLifecycle?.();
		options.mcpElicitation?.unbind();
		let droppedShells = 0;
		for (const pane of runtimes.open) {
			pane.detachAgent();
			droppedShells += await pane.input.dispose();
		}
		root.dispose();
		await stopFullScreen();
		if (droppedShells > 0) {
			await options.onWarning?.(
				`Dropped ${droppedShells} queued local Shell command${droppedShells === 1 ? "" : "s"} on exit`,
			);
		}
	}
}

async function runSingleSessionInteractive(
	options: InteractiveRunOptions,
	git: WorkspaceGitStatus,
	components: Set<ChatComponent>,
): Promise<number> {
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	let tui!: FullScreenTui;
	let terminationSignal: InteractiveTerminationSignal | undefined;
	let fatalError: unknown;
	let suspendTask: Promise<void> | undefined;
	let component!: ChatComponent;
	const authFlowOptions = async (): Promise<AuthCommandFlowOptions> => {
		if (!options.authCommand) throw new Error("Authentication management is unavailable");
		return {
			providers: await options.authCommand.providers(),
			onUpdateApiKey: options.authCommand.updateApiKey,
			onLogout: options.authCommand.logout,
			onAddCustomProvider: options.authCommand.addCustomProvider,
		};
	};
	const userShell = new UserShell({
		processRunner: options.processRunner,
		platform: options.platform,
		workspace: options.workspace,
		environment: options.environment,
		clock: options.clock,
		onUpdate: (snapshot) => {
			component.acceptUserShell(snapshot);
			if (snapshot.status !== "running") void git.refresh();
		},
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
		activitySummaryMode: options.activitySummaryMode,
		reasoning: options.reasoning,
		statusLine: () => statusLineSnapshot(options, options, git),
		clock: options.clock,
		colorLevel: options.terminal.capabilities.colorLevel,
		appearance: options.terminal.capabilities.appearance,
		motion: options.motion,
		commandRegistry: options.commandRegistry,
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
		onResolveExtensionReferences: options.resolveExtensionReferences,
		onSubmit: (text, attachmentIds, composerText, references) =>
			inputController.submit(text, attachmentIds, composerText, references),
		onSteer: (text, attachmentIds, composerText, references) =>
			inputController.steer(text, attachmentIds, composerText, references),
		onFollowUp: (text, attachmentIds, composerText, references) =>
			inputController.followUp(text, attachmentIds, composerText, references),
		onUserShell: (command) => inputController.submitUserShell(command),
		onCommand: async (commandId, flow, argument) => {
			if (commandId === "core:auth") {
				flow.open(createAuthCommandFlow(await authFlowOptions()));
				return;
			}
			if (commandId === "core:model") {
				if (!options.modelCommand) throw new Error("Model selection is unavailable");
				flow.open(
					createModelCommandFlow({
						currentKey: options.modelCommand.currentKey(),
						models: await options.modelCommand.list(),
						onSelect: async (selected) => {
							const presentation = await options.modelCommand!.select(selected);
							component.setModelPresentation(
								presentation.modelLabel,
								presentation.reasoning,
								presentation.activitySummaryMode,
							);
						},
						onAuthenticate: async (providerId, navigation) => {
							if (!options.authCommand) {
								await options.modelCommand!.authenticate(providerId, navigation);
								return;
							}
							const authOptions = await authFlowOptions();
							const provider = authOptions.providers.find(({ id }) => id === providerId);
							if (!provider) throw new Error(`Unknown provider: ${providerId}`);
							navigation.push(createProviderAuthFlow(provider, authOptions));
						},
					}),
				);
				return;
			}
			if (commandId === "core:effort") {
				if (!options.effortCommand) throw new Error("Reasoning effort selection is unavailable");
				const snapshot = options.effortCommand.snapshot();
				flow.open(
					createEffortCommandFlow({
						...snapshot,
						onSelect: async (selected) => {
							const reasoning = await options.effortCommand!.select(selected);
							component.setReasoning(reasoning);
						},
					}),
				);
				return;
			}
			if (commandId === "core:skills") {
				if (!options.skillsCommand) throw new Error("Skills management is unavailable");
				flow.open(
					createSkillsCommandFlow({
						snapshot: await options.skillsCommand.snapshot(),
						onRefresh: options.skillsCommand.refresh,
					}),
				);
				return;
			}
			if (commandId === "core:skill") {
				if (!options.skillsCommand) throw new Error("Skill selection is unavailable");
				flow.open(
					createSkillSelectionCommandFlow({
						snapshot: await options.skillsCommand.snapshot(),
						onSelect: (selectedCommandId, navigation) => {
							component.insertSkillReference(selectedCommandId);
							navigation.close();
						},
					}),
				);
				return;
			}
			if (commandId === "core:mcp") {
				if (!options.mcpCommand) throw new Error("MCP management is unavailable");
				await openMcpCommand(flow, argument, options.mcpCommand);
				return;
			}
			if (commandId === "core:compact") {
				if (!options.compactCommand) throw new Error("Context compaction is unavailable");
				component.setActivityOverride("command:compact", "Compacting context...", true, "active");
				try {
					return await options.compactCommand.run(argument);
				} finally {
					component.setActivityOverride("command:compact", "", false);
				}
			}
			throw new Error(`Command is not available yet: ${commandId}`);
		},
		onResumeFollowUps: () => inputController.resumeQueue(),
		isQueuePaused: () => inputController.queuePaused,
		onReclaimFollowUp: (queueItemId) => inputController.reclaimFollowUp(queueItemId as QueueItemId),
		onReclaimUserShell: (id) => inputController.reclaimUserShell(id),
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
	acceptLatestRunEvidence(component, options.session);
	components.add(component);
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
		options.mcpElicitation?.unbind();
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
		options.mcpElicitation?.unbind();
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
	options.mcpElicitation?.bind(tui, options.terminal, (request, _sessionId, waiting) => {
		component.setActivityOverride(
			`mcp:${request.execution.invocationId}`,
			`Waiting for MCP input — ${request.tool.remoteName}`,
			waiting,
		);
	});
	options.mcpElicitation?.setActiveSession(options.session.descriptor.id);
	if (terminationSignal || fatalError !== undefined) {
		options.mcpElicitation?.unbind();
	}
	const detach = options.agent.onEvent((event) => {
		component.accept(event);
		if (event.type === "run_end") acceptLatestRunEvidence(component, options.session, event.runId);
		if (event.type === "tool_execution_end" || event.type === "tool_execution_rejected") void git.refresh();
	});
	try {
		if (!(await startFullScreen())) {
			throw new Error("Interactive full-screen mode is unavailable; use --no-tui for print mode");
		}
		git.start();
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
		options.mcpElicitation?.unbind();
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

function assertEmptyReplacementSession(
	current: InteractiveSessionOptions,
	replacement: InteractiveSessionOptions,
): void {
	if (replacement.session.descriptor.id === current.session.descriptor.id) {
		throw new Error("Context Overflow replacement must have a fresh Session identity");
	}
	if (
		replacement.session.descriptor.workspace.id !== current.session.descriptor.workspace.id ||
		replacement.session.descriptor.workspace.path !== current.session.descriptor.workspace.path
	) {
		throw new Error("Context Overflow replacement must belong to the same Workspace");
	}
	const restoredAttachmentCount = [...(replacement.restoredAttachments?.values() ?? [])].reduce(
		(total, attachments) => total + attachments.length,
		0,
	);
	if (
		replacement.agent.state.status !== "idle" ||
		replacement.agent.state.messages.length > 0 ||
		replacement.agent.state.pendingSteering.length > 0 ||
		replacement.agent.state.pendingFollowUps.length > 0 ||
		replacement.session.seed.messages.length > 0 ||
		replacement.session.seed.pendingFollowUps.length > 0 ||
		replacement.session.recoverableFollowUps.length > 0 ||
		replacement.session.composerSubmissions.length > 0 ||
		replacement.session.toolInvocations.length > 0 ||
		replacement.session.runEvidence.length > 0 ||
		replacement.session.compactionCheckpoint !== undefined ||
		replacement.session.mediaReferences.size > 0 ||
		replacement.initialPrompt !== undefined ||
		(replacement.initialAttachmentIds?.length ?? 0) > 0 ||
		(replacement.initialAttachments?.length ?? 0) > 0 ||
		restoredAttachmentCount > 0
	) {
		throw new Error("Context Overflow replacement Session runtime is not empty");
	}
}

function acceptLatestRunEvidence(component: ChatComponent, session: Session, runId?: string): void {
	const evidence = session.runEvidence.at(-1);
	if (evidence && (runId === undefined || evidence.runId === runId)) component.acceptRunEvidence(evidence);
}

function emptyAttachmentTransaction(): AttachmentTransaction {
	return {
		commit: async () => undefined,
		rollback: async () => undefined,
	};
}

function statusLineSnapshot(
	run: InteractiveRunOptions,
	session: InteractiveSessionOptions,
	git: WorkspaceGitStatus,
): StatusLineSnapshot {
	return {
		...session.statusLine(),
		workspacePath: run.workspace,
		...(run.homePath || run.environment.HOME || run.environment.USERPROFILE
			? { homePath: run.homePath ?? run.environment.HOME ?? run.environment.USERPROFILE }
			: {}),
		...(git.snapshot ? { git: git.snapshot } : {}),
	};
}
