import { createHash } from "node:crypto";
import type { AgentInput, Clock, IdGenerator } from "@coda/agent";
import type { Api, Model, MutableModels, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult } from "@coda/mcp";
import { createTerminalImageSurface, type DiagnosticSink, type Keybinding, type Scheduler } from "@coda/tui";
import type { ModelCommandEntry } from "../commands/model-flow.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Workspace } from "../host/workspace.ts";
import type { McpAgentElicitation } from "../mcp/run-capability.ts";
import type { MediaLibrary } from "../media/media-library.ts";
import type { ModelCapabilityResolver } from "../models/model-capabilities.ts";
import { catalogModelFromRuntime } from "../models/model-catalog.ts";
import type { ProviderManager } from "../models/provider-manager.ts";
import { effectiveReasoningEffort } from "../models/reasoning-effort.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { AgentRunControlBinding, RunControlConfiguration } from "../run-control/index.ts";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import type { WorkspaceInputResources } from "../runtime/workspace-input-resources.ts";
import type { WorkspaceWorkCoordinator } from "../runtime/workspace-work-coordinator.ts";
import { DraftSession } from "../session/draft-session.ts";
import type { Session, SessionId, SessionManager } from "../session/types.ts";
import type { SettingsStore, UserSettings } from "../settings/types.ts";
import type { CodingSkillsManager } from "../skills/manager.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import { activitySummaryModeForApi } from "../ui/activity-status.ts";
import type { FullScreenOutputGate } from "../ui/full-screen-output.ts";
import type { InteractiveMcpElicitationHandler } from "../ui/mcp-elicitation.ts";
import type { InteractiveProcessLifecycle } from "../ui/process-lifecycle.ts";
import type { PromptRuntime } from "../ui/prompts.ts";
import { type InteractiveSessionOptions, runInteractive } from "../ui/run-interactive.ts";
import { finalText, findModel } from "./argument-parsing.ts";
import { persistCustomProviders, refreshProviderAuth } from "./auth-flows.ts";
import {
	bindInteractiveRunControl,
	createInteractiveSessionOptions,
	createSessionMediaLibrary,
	openInteractiveRuntime,
	restoreSessionMedia,
} from "./interactive-session-options.ts";
import { chatAttachment, hasAgentInput, pathSafeIdentity, type RestoredChatMedia } from "./media-attachments.ts";
import { createSessionPresentation } from "./session-presentation.ts";
import { closeSecondarySessionResources, trackWorkspaceDiffs, type WorkspaceDiffTracker } from "./workspace-session.ts";

export interface InteractiveRunApplicationOptions {
	readonly models: MutableModels;
	readonly settings: SettingsStore;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly io: Pick<ApplicationIO, "stdout" | "stderr">;
	readonly keybindings?: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly runtime: {
		readonly homeDirectory: string;
		readonly platform: NodeJS.Platform;
		readonly environment: Readonly<Record<string, string | undefined>>;
		readonly clock: Clock;
		readonly idGenerator: IdGenerator;
		readonly scheduler?: Scheduler;
		readonly interactiveLifecycle?: InteractiveProcessLifecycle;
	};
}

export interface RunInteractiveApplicationInput {
	readonly options: InteractiveRunApplicationOptions;
	readonly providerManager: ProviderManager;
	readonly settings: UserSettings;
	readonly sessions: SessionManager;
	readonly workspace: Workspace;
	readonly workspaceId: string;
	readonly session: Session;
	readonly work: SessionWorkController;
	readonly mediaLibrary: MediaLibrary;
	readonly restoredMedia: RestoredChatMedia;
	readonly inputResources: WorkspaceInputResources;
	readonly processSessionManager: ProcessSessionManager;
	readonly coordinator: WorkspaceWorkCoordinator;
	readonly skillsManager: CodingSkillsManager;
	readonly skillsSnapshot: CodingSkillsSnapshot;
	readonly skillsCommand: NonNullable<InteractiveSessionOptions["skillsCommand"]>;
	readonly mcpCommand: NonNullable<InteractiveSessionOptions["mcpCommand"]>;
	readonly commandRegistry: CommandRegistry;
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly apiKey?: string;
	readonly runControl?: RunControlConfiguration;
	readonly interactiveRuntime: PromptRuntime;
	readonly mcpElicitation?: InteractiveMcpElicitationHandler;
	readonly workspaceDiffs: WorkspaceDiffTracker;
	readonly initialInput: AgentInput;
	readonly initialAttachmentIds: readonly string[];
	readonly noAnimations: boolean;
}

export async function runInteractiveApplication(input: RunInteractiveApplicationInput): Promise<number> {
	let settings = input.settings;
	const secondaryResources = new Map<
		string,
		{
			readonly session: Session;
			readonly work: SessionWorkController;
			readonly mediaLibrary: MediaLibrary;
			readonly runControl?: AgentRunControlBinding;
		}
	>();
	const saveCustomProviders = async (): Promise<void> => {
		settings = persistCustomProviders(settings, input.providerManager.configurations);
		await input.options.settings.save(settings);
	};
	const updateProviderAuth = (providerId: string): Promise<void> =>
		refreshProviderAuth({
			providerId,
			targets: [
				{ work: input.work, apiKey: input.apiKey },
				...[...secondaryResources.values()].map(({ work }) => ({ work, apiKey: undefined })),
			],
			models: input.options.models,
			clock: input.options.runtime.clock,
		});
	const imageSurface = createTerminalImageSurface({
		terminal: input.interactiveRuntime.terminal,
		environment: input.options.runtime.environment,
		allocateId: terminalImageIdAllocator(input.options.runtime.idGenerator),
	});
	const listModelEntries = async (): Promise<readonly ModelCommandEntry[]> => {
		const configuredProviders = new Set(
			(
				await Promise.all(
					input.options.models.getProviders().map(async (provider) => {
						try {
							return (await input.options.models.checkAuth(provider.id)) ? provider.id : undefined;
						} catch {
							return undefined;
						}
					}),
				)
			).filter((providerId): providerId is string => providerId !== undefined),
		);
		return input.options.models.getModels().map(
			(modelEntry): ModelCommandEntry => ({
				catalog:
					input.providerManager.catalogModel(modelEntry.provider, modelEntry.id) ??
					catalogModelFromRuntime(modelEntry),
				auth: configuredProviders.has(modelEntry.provider) ? "configured" : "authentication_required",
			}),
		);
	};
	const authCommand = {
		providers: () => input.providerManager.authenticationEntries(),
		updateApiKey: async (providerId: string, apiKey: string) => {
			await input.providerManager.updateApiKey(providerId, apiKey);
			await saveCustomProviders();
			await updateProviderAuth(providerId);
		},
		logout: async (providerId: string) => {
			await input.providerManager.logout(providerId);
			await updateProviderAuth(providerId);
		},
		addCustomProvider: async (provider: Parameters<ProviderManager["addCustomProvider"]>[0]) => {
			await input.providerManager.addCustomProvider(provider);
			await saveCustomProviders();
		},
	};
	const createSecondarySessionOptions = async (
		targetSession: Session,
		fresh: boolean,
	): Promise<InteractiveSessionOptions> => {
		const targetMcpElicitation =
			input.options.mcpElicitation ?? input.mcpElicitation?.forSession(targetSession.descriptor.id);
		const targetMediaLibrary = createSessionMediaLibrary(targetSession, input.options);
		let targetRuntimeToClose: SessionWorkController | undefined;
		let targetRunControlToDispose: AgentRunControlBinding | undefined;
		try {
			const targetSelection = targetSession.restored.model ?? settings.defaultModel;
			if (!targetSelection) throw new Error("A new Session requires a configured default Model");
			const targetModel = findModel(input.options.models, targetSelection);
			const targetReasoning = effectiveReasoningEffort(
				targetModel,
				targetSession.restored.reasoning ?? settings.defaultReasoning ?? "medium",
			);
			const targetAuth = await input.options.models.getAuth(targetModel, { clock: input.options.runtime.clock });
			if (!targetSession.restored.model) {
				const initialModelSelection = {
					type: "model_selected",
					model: { provider: targetModel.provider, id: targetModel.id },
					reasoning: targetReasoning,
				} as const;
				if (fresh && targetSession instanceof DraftSession) {
					targetSession.stageInitialChanges([initialModelSelection]);
				} else {
					await targetSession.record(initialModelSelection);
				}
			}
			const targetRuntime = await openInteractiveRuntime({
				coordinator: input.coordinator,
				session: targetSession,
				selection: {
					model: targetModel,
					reasoning: targetReasoning,
					authSnapshot: targetAuth,
				},
				mcpElicitation: targetMcpElicitation,
			});
			targetRuntimeToClose = targetRuntime;
			const targetRunControl = bindInteractiveRunControl({
				work: targetRuntime,
				configuration: input.runControl,
				clock: input.options.runtime.clock,
				scheduler: input.options.runtime.scheduler,
			});
			targetRunControlToDispose = targetRunControl;
			const targetRestoredMedia = await restoreSessionMedia(targetSession, input.options.fileSystem);
			trackWorkspaceDiffs({
				work: targetRuntime,
				session: targetSession,
				mode: "interactive",
				tracker: input.workspaceDiffs,
			});
			secondaryResources.set(targetSession.descriptor.id, {
				session: targetSession,
				work: targetRuntime,
				mediaLibrary: targetMediaLibrary,
				...(targetRunControl ? { runControl: targetRunControl } : {}),
			});
			return createInteractiveSessionOptions({
				session: targetSession,
				work: targetRuntime,
				mediaLibrary: targetMediaLibrary,
				restoredMedia: targetRestoredMedia,
				model: targetModel,
				modelLabel: `${targetModel.provider}/${targetModel.id}`,
				activitySummaryMode: activitySummaryModeForApi(targetModel.api),
				listModelEntries,
				authCommand,
				skillsCommand: input.skillsCommand,
				mcpCommand: input.mcpCommand,
				reasoning: targetReasoning,
				skillsManager: input.skillsManager,
				skillsSnapshot: input.skillsSnapshot,
				inputResources: input.inputResources,
				options: input.options,
				workspace: input.workspace.root,
				mode: { type: "secondary" },
				onRetire: () => input.processSessionManager.retireSession(targetSession.descriptor.id),
			});
		} catch (error) {
			targetRunControlToDispose?.dispose();
			if (targetRuntimeToClose) await targetRuntimeToClose.close().catch(() => undefined);
			else await targetSession.close().catch(() => undefined);
			await targetMediaLibrary.dispose().catch(() => undefined);
			throw error;
		}
	};
	let exitCode: number;
	let overflowReplacement: InteractiveSessionOptions | undefined;
	const primarySessionOptions = createInteractiveSessionOptions({
		session: input.session,
		work: input.work,
		mediaLibrary: input.mediaLibrary,
		restoredMedia: input.restoredMedia,
		model: input.model,
		modelLabel: `${input.model.provider}/${input.model.id}`,
		reasoning: input.reasoning,
		activitySummaryMode: activitySummaryModeForApi(input.model.api),
		listModelEntries,
		authCommand,
		skillsCommand: input.skillsCommand,
		mcpCommand: input.mcpCommand,
		skillsManager: input.skillsManager,
		skillsSnapshot: input.skillsSnapshot,
		inputResources: input.inputResources,
		options: input.options,
		workspace: input.workspace.root,
		mode: { type: "primary", providerId: input.model.provider, apiKey: input.apiKey },
		onRetire: () => input.processSessionManager.retireSession(input.session.descriptor.id),
	});
	const initialMessageCount = input.work.state().messages.length;
	const initialAttachments = await Promise.all(
		input.initialAttachmentIds.map((attachmentId) => chatAttachment(input.mediaLibrary, attachmentId)),
	);
	try {
		exitCode = await runInteractive({
			...primarySessionOptions,
			terminal: input.interactiveRuntime.terminal,
			clock: input.options.runtime.clock,
			scheduler: input.interactiveRuntime.scheduler,
			imageSurface,
			keybindings: input.options.keybindings ?? [],
			diagnostics: input.options.diagnostics,
			fullScreenOutput: input.options.fullScreenOutput,
			mcpElicitation: input.mcpElicitation,
			motion: input.noAnimations ? "reduced" : (settings.ui?.motion ?? "full"),
			commandRegistry: input.commandRegistry,
			sessionCommand: {
				list: async () =>
					(await input.sessions.list({ id: input.workspaceId, path: input.workspace.root })).map((descriptor) => ({
						id: descriptor.id,
						label: descriptor.id,
						description: new Date(descriptor.createdAt).toISOString(),
					})),
				open: async (sessionId) => {
					const targetSession = await input.sessions.open({
						workspace: { id: input.workspaceId, path: input.workspace.root },
						mode: "interactive",
						resumeId: sessionId,
						persistent: input.session.descriptor.persistent,
					});
					return createSecondarySessionOptions(targetSession, false);
				},
				create: async () => {
					const draftId = `session-${pathSafeIdentity(
						input.options.runtime.idGenerator.generate("queue_item"),
					)}` as SessionId;
					const targetSession = new DraftSession({
						descriptor: {
							id: draftId,
							workspace: { id: input.workspaceId, path: input.workspace.root },
							createdAt: input.options.runtime.clock.now(),
							persistent: input.session.descriptor.persistent,
						},
						materialize: () =>
							input.sessions.open({
								workspace: { id: input.workspaceId, path: input.workspace.root },
								mode: "interactive",
								persistent: input.session.descriptor.persistent,
								createId: draftId,
							}),
					});
					return createSecondarySessionOptions(targetSession, true);
				},
			},
			onContextOverflowReplacement: (replacement) => {
				overflowReplacement = replacement;
			},
			lifecycle: input.options.runtime.interactiveLifecycle,
			allocateId: () => input.options.runtime.idGenerator.generate("queue_item"),
			processRunner: input.options.processRunner,
			platform: input.options.runtime.platform,
			environment: input.options.runtime.environment,
			workspace: input.workspace.root,
			homePath: input.options.runtime.homeDirectory,
			onWarning: (message) => input.options.io.stderr.write(`coda: ${message}\n`),
			initialPrompt: hasAgentInput(input.initialInput) ? input.initialInput : undefined,
			initialAttachmentIds: input.initialAttachmentIds,
			initialAttachments,
		});
	} finally {
		await closeSecondarySessionResources(secondaryResources.values(), input.workspaceDiffs);
	}
	const finalWork = overflowReplacement?.work ?? input.work;
	const finalAgent = finalWork.state();
	const finalPresentation = overflowReplacement?.presentation ?? createSessionPresentation(input.session);
	const interactiveMessages = finalAgent.messages.slice(overflowReplacement ? 0 : initialMessageCount);
	const finalAssistant = [...interactiveMessages]
		.reverse()
		.find(({ message }) => message.role === "assistant" && finalText(message).trim().length > 0)?.message;
	if (finalAssistant?.role === "assistant") {
		await input.options.io.stdout.write(`${finalText(finalAssistant)}\n`);
	}
	if (finalPresentation.descriptor.persistent && finalPresentation.descriptor.path) {
		await input.options.io.stdout.write(
			`Session ${finalPresentation.descriptor.id} • resume with: coda --resume ${finalPresentation.descriptor.id}\n`,
		);
	}
	if (finalAgent.lastRun && finalAgent.lastRun.outcome !== "success") {
		await input.options.io.stderr.write(
			`coda: ${finalAgent.lastRun.failure?.message ?? `Run ended with outcome ${finalAgent.lastRun.outcome}`}\n`,
		);
	}
	return exitCode;
}

function terminalImageIdAllocator(idGenerator: IdGenerator): () => number {
	const allocated = new Set<number>();
	return () => {
		for (let attempt = 0; attempt < 100; attempt++) {
			const identity = idGenerator.generate("queue_item");
			const id = createHash("sha256").update(identity).digest().readUInt32BE(0);
			if (id === 0 || allocated.has(id)) continue;
			allocated.add(id);
			return id;
		}
		throw new Error("Could not allocate a unique terminal image ID");
	};
}
