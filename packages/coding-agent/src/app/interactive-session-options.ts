import { join } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import type { Api, AuthResult, Model, MutableModels, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult } from "@coda/mcp";
import type { Scheduler } from "@coda/tui";
import type { ModelCommandEntry } from "../commands/model-flow.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { McpAgentElicitation } from "../mcp/run-capability.ts";
import { MediaLibrary } from "../media/media-library.ts";
import type { ModelCapabilityResolver } from "../models/model-capabilities.ts";
import { resolveModelRuntimeCapabilities } from "../models/model-capabilities.ts";
import { effectiveReasoningEffort } from "../models/reasoning-effort.ts";
import {
	type AgentRunControlBinding,
	bindAgentRunControl,
	type RunControlConfiguration,
} from "../run-control/index.ts";
import type { SessionWorkController, SessionWorkSelection } from "../runtime/session-work-controller.ts";
import type { WorkspaceInputResources } from "../runtime/workspace-input-resources.ts";
import type { WorkspaceWorkCoordinator } from "../runtime/workspace-work-coordinator.ts";
import type { Session } from "../session/types.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "../skills/context.ts";
import type { CodingSkillsManager } from "../skills/manager.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import { type ActivitySummaryMode, activitySummaryModeForApi } from "../ui/activity-status.ts";
import type { InteractiveSessionOptions } from "../ui/run-interactive.ts";
import { createEffortCommand, interactiveStatusLineSnapshot } from "./auth-flows.ts";
import {
	openAttachmentInSystemViewer,
	openPathInSystemViewer,
	pathSafeIdentity,
	prepareAttachmentTransaction,
	promptInput,
	type RestoredChatMedia,
	restoredChatAttachments,
} from "./media-attachments.ts";
import { createSessionPresentation } from "./session-presentation.ts";
import { assertSkillReferencesAvailable } from "./trust-gating.ts";

export interface InteractiveSessionApplicationOptions {
	readonly models: MutableModels;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly runtime: {
		readonly homeDirectory: string;
		readonly platform: NodeJS.Platform;
		readonly environment: Readonly<Record<string, string | undefined>>;
		readonly clock: Clock;
		readonly idGenerator: IdGenerator;
		readonly scheduler?: Scheduler;
	};
}

export function createSessionMediaLibrary(
	session: Session,
	options: {
		readonly fileSystem: FileSystem;
		readonly runtime: Pick<InteractiveSessionApplicationOptions["runtime"], "homeDirectory" | "idGenerator">;
	},
): MediaLibrary {
	const mediaToken = pathSafeIdentity(options.runtime.idGenerator.generate("queue_item"));
	return new MediaLibrary({
		fileSystem: options.fileSystem,
		stagingDirectory: join(
			options.runtime.homeDirectory,
			".coda",
			"tmp",
			"media",
			pathSafeIdentity(session.descriptor.id),
			mediaToken,
		),
		mediaDirectory: session.descriptor.path
			? `${session.descriptor.path}.media`
			: join(
					options.runtime.homeDirectory,
					".coda",
					"tmp",
					"media",
					pathSafeIdentity(session.descriptor.id),
					"committed",
				),
		idGenerator: options.runtime.idGenerator,
	});
}

export function restoreSessionMedia(session: Session, fileSystem: FileSystem): Promise<RestoredChatMedia> {
	return restoredChatAttachments(
		session.mediaReferences,
		session.descriptor.path,
		fileSystem,
		new Set(session.recoverableFollowUps.map(({ item }) => item.id)),
	);
}

export function openInteractiveRuntime(input: {
	readonly coordinator: WorkspaceWorkCoordinator;
	readonly session: Session;
	readonly selection: SessionWorkSelection;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}): Promise<SessionWorkController> {
	return input.coordinator.open({
		session: input.session,
		selection: input.selection,
		...(input.mcpElicitation ? { mcpElicitation: input.mcpElicitation } : {}),
	});
}

export function bindInteractiveRunControl(input: {
	readonly work: SessionWorkController;
	readonly configuration?: RunControlConfiguration;
	readonly clock: Clock;
	readonly scheduler?: Scheduler;
}): AgentRunControlBinding | undefined {
	return input.configuration
		? bindAgentRunControl({
				work: input.work,
				configuration: input.configuration,
				clock: input.clock,
				scheduler: input.scheduler!,
			})
		: undefined;
}

type ModelCommand = NonNullable<InteractiveSessionOptions["modelCommand"]>;

type SessionMode =
	| { readonly type: "primary"; readonly providerId: string; readonly apiKey?: string }
	| { readonly type: "secondary" };

export interface CreateInteractiveSessionOptionsInput {
	readonly session: Session;
	readonly work: SessionWorkController;
	readonly mediaLibrary: MediaLibrary;
	readonly restoredMedia: RestoredChatMedia;
	readonly model: Model<Api>;
	readonly modelLabel: string;
	readonly reasoning: ThinkingLevel | "off";
	readonly activitySummaryMode: ActivitySummaryMode;
	readonly listModelEntries: () => Promise<readonly ModelCommandEntry[]>;
	readonly authCommand: NonNullable<InteractiveSessionOptions["authCommand"]>;
	readonly skillsCommand: NonNullable<InteractiveSessionOptions["skillsCommand"]>;
	readonly mcpCommand: NonNullable<InteractiveSessionOptions["mcpCommand"]>;
	readonly skillsManager: CodingSkillsManager;
	readonly skillsSnapshot: CodingSkillsSnapshot;
	readonly inputResources: WorkspaceInputResources;
	readonly options: InteractiveSessionApplicationOptions;
	readonly workspace: string;
	readonly mode: SessionMode;
	readonly onRetire: NonNullable<InteractiveSessionOptions["onRetire"]>;
}

export function assertModelSupportsImages(model: Model<Api>, imageCount: number): void {
	if (imageCount > 0 && !model.input.includes("image")) {
		throw new Error(`Model does not support image input: ${model.provider}/${model.id}`);
	}
}

export function createInteractiveSessionOptions(
	input: CreateInteractiveSessionOptionsInput,
): InteractiveSessionOptions {
	const prepareAttachments = createAttachmentPreparer(input);
	const mediaHandlers = createMediaHandlers(input);
	return {
		work: input.work,
		presentation: createSessionPresentation(input.session),
		inputSession: input.session,
		modelLabel: input.modelLabel,
		activitySummaryMode: input.activitySummaryMode,
		statusLine: () => interactiveStatusLineSnapshot(input.work, input.session),
		modelCommand: createModelCommand(input),
		effortCommand: createEffortCommand(input.session, input.work),
		authCommand: input.authCommand,
		skillsCommand: input.skillsCommand,
		mcpCommand: input.mcpCommand,
		reasoning: input.reasoning,
		restoredAttachments: input.restoredMedia.attachments,
		resolveExtensionReferences: createExtensionReferenceResolver(input.skillsManager),
		buildPrompt: createPromptBuilder(input),
		prepareAttachments,
		...mediaHandlers,
		toolResultImagesSupported: resolveModelRuntimeCapabilities(input.model, input.options.modelCapabilities)
			.toolResultImages,
		onRetire: input.onRetire,
	};
}

export function createAttachmentPreparer(
	input: Pick<CreateInteractiveSessionOptionsInput, "restoredMedia" | "mediaLibrary" | "session" | "inputResources">,
): NonNullable<InteractiveSessionOptions["prepareAttachments"]> {
	return (attachmentIds) =>
		prepareAttachmentTransaction(
			attachmentIds.filter((id) => !input.restoredMedia.contents.has(id)),
			input.mediaLibrary,
			input.session,
			input.inputResources,
		);
}

function createMediaHandlers(
	input: Pick<CreateInteractiveSessionOptionsInput, "restoredMedia" | "mediaLibrary" | "options" | "workspace">,
): Pick<InteractiveSessionOptions, "onDetach" | "onOpenAttachment"> {
	return {
		onDetach: (attachmentId) =>
			input.restoredMedia.contents.has(attachmentId) ? Promise.resolve() : input.mediaLibrary.detach(attachmentId),
		onOpenAttachment: (attachmentId) => {
			const restoredPath = input.restoredMedia.paths.get(attachmentId);
			return restoredPath
				? openPathInSystemViewer(restoredPath, input.options.processRunner, input.options.runtime, input.workspace)
				: openAttachmentInSystemViewer(
						input.mediaLibrary,
						attachmentId,
						input.options.processRunner,
						input.options.runtime,
						input.workspace,
					);
		},
	};
}

function createModelCommand(
	input: Pick<CreateInteractiveSessionOptionsInput, "work" | "session" | "listModelEntries" | "options" | "mode">,
): ModelCommand {
	return {
		currentKey: () => `${input.work.state().selection.model.provider}/${input.work.state().selection.model.id}`,
		list: input.listModelEntries,
		select: async (selected) => {
			const authSnapshot = await selectedModelAuth(input, selected.runtime, selected.providerId);
			if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
			const nextReasoning = effectiveReasoningEffort(selected.runtime, input.work.state().selection.reasoning);
			await input.session.record({
				type: "model_selected",
				model: { provider: selected.providerId, id: selected.id },
				reasoning: nextReasoning,
			});
			await input.work.select({
				model: selected.runtime,
				reasoning: nextReasoning,
				authSnapshot,
			});
			return {
				modelLabel: selected.key,
				reasoning: nextReasoning,
				activitySummaryMode: activitySummaryModeForApi(selected.runtime.api),
			};
		},
		authenticate: (providerId) => {
			throw new Error(`Provider requires authentication: ${providerId}; use /auth`);
		},
	};
}

function selectedModelAuth(
	input: Pick<CreateInteractiveSessionOptionsInput, "options" | "mode">,
	model: Model<Api>,
	providerId: string,
): Promise<AuthResult | undefined> {
	return input.mode.type === "primary"
		? input.options.models.getAuth(model, {
				apiKey: providerId === input.mode.providerId ? input.mode.apiKey : undefined,
				clock: input.options.runtime.clock,
			})
		: input.options.models.getAuth(model, { clock: input.options.runtime.clock });
}

function createExtensionReferenceResolver(
	skillsManager: CodingSkillsManager,
): NonNullable<InteractiveSessionOptions["resolveExtensionReferences"]> {
	return async (references) => {
		const snapshot = await skillsManager.refresh({ rescan: false });
		assertSkillReferencesAvailable(snapshot, references);
	};
}

function createPromptBuilder(
	input: Pick<
		CreateInteractiveSessionOptionsInput,
		"work" | "mediaLibrary" | "restoredMedia" | "skillsManager" | "skillsSnapshot"
	>,
): NonNullable<InteractiveSessionOptions["buildPrompt"]> {
	return async (text, attachmentIds, inputContext) => {
		const selectedModel = input.work.state().selection.model;
		assertModelSupportsImages(selectedModel, attachmentIds.length);
		const skillReferences = inputContext.references.filter(({ source }) => source === "skill");
		if (skillReferences.length === 0) {
			return promptInput(text, attachmentIds, input.mediaLibrary, input.restoredMedia.contents);
		}
		const snapshot = input.skillsManager.current ?? input.skillsSnapshot;
		assertSkillReferencesAvailable(snapshot, inputContext.references);
		const taskText = sharedSkillArguments(inputContext.composerText, skillReferences) ?? "";
		const preparedInput = await promptInput(
			taskText,
			attachmentIds,
			input.mediaLibrary,
			input.restoredMedia.contents,
		);
		const activations = await activateExplicitSkillReferences({
			snapshot,
			references: skillReferences,
			composerText: inputContext.composerText,
		});
		return prependSkillContext(
			preparedInput,
			renderExplicitSkillContext(activations),
			renderExplicitSkillReferences(activations),
		);
	};
}
