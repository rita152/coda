import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	Agent,
	type AgentInput,
	type AgentTool,
	type Clock,
	type IdGenerator,
	type Immutable,
	type RunBudget,
} from "@coda/agent";
import type {
	Api,
	AssistantMessage,
	AuthPrompt,
	AuthResult,
	ImageContent,
	Model,
	Models,
	MutableModels,
	ThinkingLevel,
} from "@coda/ai";
import { createMcpHost, type McpConnector, type McpElicitationResult, type McpToolSnapshot } from "@coda/mcp";
import { compileSandboxPolicy, type PermissionProfile } from "@coda/sandbox";
import { DEFAULT_SKILL_LIMITS, validateAgentSkill } from "@coda/skills";
import {
	createTerminalImageSurface,
	type DiagnosticSink,
	type Keybinding,
	type Scheduler,
	sanitizeTerminalText,
	type Terminal,
	type TerminalColorScheme,
} from "@coda/tui";
import { createCoreCommandRegistry } from "./commands/core-commands.ts";
import type { ModelCommandEntry } from "./commands/model-flow.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import { ContextWindowController } from "./context-window/context-window.ts";
import { createExecutableIdentityResolver } from "./host/executable-identity.ts";
import { type FileSystem, isFileSystemError } from "./host/file-system.ts";
import type { ProcessRunner } from "./host/process-runner.ts";
import { activitySummaryModeForApi } from "./interactive/activity-status.ts";
import { InteractiveApprovalHandler } from "./interactive/approval.ts";
import type { ChatAttachment } from "./interactive/chat-component.ts";
import { FullScreenOutputGate } from "./interactive/full-screen-output.ts";
import type { AttachmentTransaction } from "./interactive/input-controller.ts";
import type { ComposerExtensionReference } from "./interactive/input-types.ts";
import { InteractiveMcpElicitationHandler } from "./interactive/mcp-elicitation.ts";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./interactive/process-lifecycle.ts";
import {
	confirmFromTerminal,
	type PromptRuntime,
	promptTextFromTerminal,
	selectFromTerminal,
} from "./interactive/prompts.ts";
import { type InteractiveSessionOptions, runInteractive } from "./interactive/run-interactive.ts";
import { sessionCostSnapshot } from "./interactive/session-status.ts";
import type { SessionStatusLineSnapshot } from "./interactive/status-line.ts";
import { cleanupSessionMedia } from "./maintenance/session-media.ts";
import { cleanupTemporaryLogs } from "./maintenance/temporary-logs.ts";
import {
	inspectMcpConfiguration,
	type McpServerConfiguration,
	type WorkspaceMcpConfigurationSnapshot,
	type WorkspaceMcpTrustRecord,
} from "./mcp/config.ts";
import { CodingMcpRegistry } from "./mcp/registry.ts";
import { createMcpAgentTools, type McpAgentElicitation } from "./mcp/tools.ts";
import { type MediaAsset, MediaLibrary } from "./media/media-library.ts";
import { type ModelCapabilityResolver, resolveModelRuntimeCapabilities } from "./model-capabilities.ts";
import {
	approvalDecisionAuditEvent,
	type PermissionAuditSink,
	permissionConfigurationAuditEvent,
} from "./permissions/audit.ts";
import {
	createAuditedModelProcessRunner,
	createModelProcessRunner,
	type ModelProcessRunner,
} from "./permissions/model-process-runner.ts";
import {
	type ApprovalPolicy,
	type CommandRule,
	createPermissionEngine,
	type NetworkRule,
	type PermissionApprovalHandler,
	type PermissionEngine,
} from "./permissions/permission-engine.ts";
import { RejectingApprovalHandler } from "./permissions/rejecting-approval.ts";
import { createInMemoryPermissionRuleStore, type PermissionRuleStore } from "./permissions/rule-store.ts";
import { resolveDefaultDeniedReadRoots } from "./permissions/sensitive-read-roots.ts";
import { loadProjectInstructions } from "./project/project-context.ts";
import { assertModelContextFits } from "./prompt/context-budget.ts";
import { buildSystemPrompt } from "./prompt/prompt-builder.ts";
import { ProviderManager } from "./providers/provider-manager.ts";
import type { CustomProviderConfig } from "./providers/types.ts";
import { availableReasoningEfforts, effectiveReasoningEffort, REASONING_EFFORTS } from "./reasoning-effort.ts";
import { createCodingAgentRetry } from "./retry.ts";
import { catalogModelFromRuntime } from "./runtime/model-catalog.ts";
import { RunPermissionRouter } from "./runtime/run-permission-router.ts";
import { RunRuntimeSlot } from "./runtime/run-runtime-slot.ts";
import { DraftSession } from "./session/draft-session.ts";
import { sessionMediaExtension } from "./session/media-codec.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import type {
	Session,
	SessionId,
	SessionManager,
	SessionMediaReference,
	SessionMediaRegistration,
} from "./session/types.ts";
import { promptSkillCatalog } from "./skills/catalog.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "./skills/context.ts";
import { CodingSkillsManager, SkillCommandRegistryBinding, skillIdFromCommandId } from "./skills/manager.ts";
import { collectSkillRoots } from "./skills/roots.ts";
import { RunSkillsCoordinator } from "./skills/run-coordinator.ts";
import { createSkillTool } from "./skills/tool.ts";
import type { CodingSkillsSnapshot } from "./skills/types.ts";
import type { SkillWatcher, SkillWatcherFactory } from "./skills/watcher.ts";
import { createCodingTools } from "./tools/index.ts";
import { createWorkspace } from "./workspace.ts";

export interface ApplicationInput {
	readonly isTTY: boolean;
	readAll(): Promise<string>;
}

export interface ApplicationOutput {
	readonly isTTY: boolean;
	write(chunk: string): void | Promise<void>;
}

export interface ApplicationIO {
	readonly stdin: ApplicationInput;
	readonly stdout: ApplicationOutput;
	readonly stderr: ApplicationOutput;
}

export interface ModelSelection {
	readonly provider: string;
	readonly id: string;
}

interface PreparedRunRuntime {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot: AuthResult | undefined;
	readonly permission: PermissionEngine;
	readonly skills: CodingSkillsSnapshot;
	readonly mcp: McpToolSnapshot;
	readonly tools: readonly AgentTool[];
}

const DEFAULT_CODING_AGENT_RUN_BUDGET: RunBudget = Object.freeze({
	limits: Object.freeze({
		maxTurns: 64,
		maxToolInvocations: 256,
		maxElapsedMs: 60 * 60 * 1_000,
		maxConsecutiveEquivalentToolBatches: 4,
	}),
});

function isRecoverableContextOverflow(message: Immutable<AssistantMessage>): boolean {
	if (message.content.length > 0) return false;
	if (
		(message.diagnostics ?? []).some((diagnostic) => {
			const code = diagnostic.error?.code;
			return (
				typeof code === "string" &&
				["context_overflow", "context_length_exceeded", "context_window_exceeded"].includes(code.toLowerCase())
			);
		})
	) {
		return true;
	}
	const error = message.errorMessage?.toLowerCase() ?? "";
	return (
		(error.includes("context length") || error.includes("context window")) &&
		(error.includes("exceed") || error.includes("too long") || error.includes("maximum"))
	);
}

export interface UserSettings {
	readonly defaultModel?: ModelSelection;
	readonly defaultReasoning?: ThinkingLevel | "off";
	readonly customProviders?: readonly CustomProviderConfig[];
	readonly shellEnvironmentAllowlist?: readonly string[];
	readonly projectTrust?: readonly ProjectTrustRecord[];
	readonly mcpServers?: readonly McpServerConfiguration[];
	readonly workspaceMcpTrust?: readonly WorkspaceMcpTrustRecord[];
	readonly ui?: {
		readonly motion?: "full" | "reduced";
		readonly colorScheme?: TerminalColorScheme;
	};
	readonly permissions?: {
		readonly profile?: PermissionProfile;
		readonly approvalPolicy?: ApprovalPolicy;
	};
}

export interface ProjectTrustRecord {
	readonly workspace: string;
	readonly path: string;
	readonly sha256: string;
}

export interface SettingsStore {
	load(): Promise<UserSettings>;
	save(settings: UserSettings): Promise<void>;
}

export interface ApplicationRuntime {
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: Scheduler;
	readonly interactiveLifecycle?: InteractiveProcessLifecycle;
}

export interface TerminalStartupOptions {
	readonly noColor: boolean;
	readonly colorScheme: TerminalColorScheme;
}

export interface TerminalFactory {
	create(options: TerminalStartupOptions): Terminal;
}

export interface CodingAgentApplicationOptions {
	readonly models: MutableModels;
	readonly providerManager?: ProviderManager;
	readonly commandRegistry?: CommandRegistry;
	readonly settings: SettingsStore;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly io: ApplicationIO;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly runtime: ApplicationRuntime;
	readonly terminalFactory?: TerminalFactory;
	readonly keybindings?: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly sessions?: SessionManager;
	readonly approval?: PermissionApprovalHandler;
	readonly permissionRules?: PermissionRuleStore;
	readonly modelProcessRunner?: ModelProcessRunner;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly mcpConnector?: McpConnector;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}

export interface CodingAgentApplication {
	run(args: readonly string[]): Promise<number>;
}

interface ParsedArguments {
	readonly action: "cleanup" | "help" | "run" | "sessions" | "skills-validate" | "version";
	readonly mode: "interactive" | "print";
	readonly output: "json" | "text";
	readonly permissionProfile?: PermissionProfile;
	readonly approvalPolicy?: ApprovalPolicy;
	readonly additionalWritableRoots: readonly string[];
	readonly dangerouslyBypassApprovalsAndSandbox: boolean;
	readonly reasoning?: ThinkingLevel | "off";
	readonly apiKey?: string;
	readonly workspace?: string;
	readonly trustProject: boolean;
	readonly trustProjectMcp: boolean;
	readonly persistSession: boolean;
	readonly noSession: boolean;
	readonly noColor: boolean;
	readonly colorScheme?: TerminalColorScheme;
	readonly noAnimations: boolean;
	readonly includeMediaData: boolean;
	readonly resumeId?: string;
	readonly forceUnlock: boolean;
	readonly model?: ModelSelection;
	readonly prompt: string;
	readonly imagePaths: readonly string[];
	readonly skillsPath?: string;
}

function parseModel(value: string): ModelSelection {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`Model must use provider/model syntax; received "${value}"`);
	}
	return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

async function parseArguments(args: readonly string[], io: ApplicationIO): Promise<ParsedArguments> {
	let action: ParsedArguments["action"] = "run";
	let explicitMode: ParsedArguments["mode"] | undefined;
	let output: ParsedArguments["output"] = "text";
	let permissionProfile: PermissionProfile | undefined;
	let approvalPolicy: ApprovalPolicy | undefined;
	let dangerouslyBypassApprovalsAndSandbox = false;
	let reasoning: ThinkingLevel | "off" | undefined;
	let apiKey: string | undefined;
	let workspace: string | undefined;
	let trustProject = false;
	let trustProjectMcp = false;
	let persistSession = false;
	let noSession = false;
	let noColor = false;
	let colorScheme: TerminalColorScheme | undefined;
	let noAnimations = false;
	let includeMediaData = false;
	let resumeId: string | undefined;
	let forceUnlock = false;
	let model: ModelSelection | undefined;
	const promptParts: string[] = [];
	const imagePaths: string[] = [];
	const additionalWritableRoots: string[] = [];
	let skillsPath: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (index === 0 && (argument === "cleanup" || argument === "sessions")) {
			action = argument;
			continue;
		}
		if (index === 0 && argument === "skills") {
			if (args[index + 1] !== "validate") throw new Error("skills requires: validate <path>");
			action = "skills-validate";
			index++;
			continue;
		}
		if (argument === "--print" || argument === "-p" || argument === "--no-tui") {
			if (explicitMode === "interactive") throw new Error("--print and --interactive cannot be combined");
			explicitMode = "print";
			continue;
		}
		if (argument === "--interactive" || argument === "-i") {
			if (explicitMode === "print") throw new Error("--print and --interactive cannot be combined");
			explicitMode = "interactive";
			continue;
		}
		if (argument === "--json") {
			output = "json";
			continue;
		}
		if (argument === "--no-color") {
			noColor = true;
			continue;
		}
		if (argument === "--color-scheme") {
			const value = args[++index];
			if (value !== "auto" && value !== "light" && value !== "dark") {
				throw new Error("--color-scheme requires auto, light, or dark");
			}
			colorScheme = value;
			continue;
		}
		if (argument === "--no-animations") {
			noAnimations = true;
			continue;
		}
		if (argument === "--include-media-data") {
			includeMediaData = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			action = "help";
			continue;
		}
		if (argument === "--version" || argument === "-v") {
			action = "version";
			continue;
		}
		if (argument === "--sandbox") {
			const value = args[++index];
			if (value === "read-only") permissionProfile = "read-only";
			else if (value === "workspace-write") permissionProfile = "workspace";
			else if (value === "danger-full-access") permissionProfile = "full-access";
			else throw new Error("--sandbox requires read-only, workspace-write, or danger-full-access");
			continue;
		}
		if (argument === "--ask-for-approval") {
			const value = args[++index];
			if (value === "untrusted") approvalPolicy = "unless-trusted";
			else if (value === "on-request") approvalPolicy = "on-request";
			else if (value === "never") approvalPolicy = "never";
			else if (value === "granular") {
				approvalPolicy = {
					mode: "granular",
					sandboxApproval: true,
					rules: true,
					skillApproval: true,
					requestPermissions: true,
					mcpElicitations: true,
				};
			} else throw new Error("--ask-for-approval requires untrusted, on-request, granular, or never");
			continue;
		}
		if (argument === "--add-dir") {
			const value = args[++index];
			if (!value) throw new Error("--add-dir requires a path");
			additionalWritableRoots.push(value);
			continue;
		}
		if (argument === "--dangerously-bypass-approvals-and-sandbox") {
			dangerouslyBypassApprovalsAndSandbox = true;
			continue;
		}
		if (argument === "--reasoning") {
			const value = args[++index];
			if (!value || !REASONING_EFFORTS.includes(value as ThinkingLevel | "off")) {
				throw new Error("--reasoning requires off, minimal, low, medium, high, xhigh, or max");
			}
			reasoning = value as ThinkingLevel | "off";
			continue;
		}
		if (argument === "--api-key") {
			const value = args[++index];
			if (!value) throw new Error("--api-key requires a non-empty value");
			apiKey = value;
			continue;
		}
		if (argument === "--workspace") {
			const value = args[++index];
			if (!value) throw new Error("--workspace requires a path");
			workspace = value;
			continue;
		}
		if (argument === "--trust-project") {
			trustProject = true;
			continue;
		}
		if (argument === "--trust-project-mcp") {
			trustProjectMcp = true;
			continue;
		}
		if (argument === "--session") {
			if (noSession) throw new Error("--session and --no-session cannot be combined");
			persistSession = true;
			continue;
		}
		if (argument === "--no-session") {
			if (persistSession || resumeId) throw new Error("--no-session cannot be combined with --session or --resume");
			noSession = true;
			continue;
		}
		if (argument === "--resume") {
			const value = args[++index];
			if (!value) throw new Error("--resume requires a Session identity");
			if (noSession) throw new Error("--resume cannot be combined with --no-session");
			resumeId = value;
			persistSession = true;
			continue;
		}
		if (argument === "--force-unlock") {
			forceUnlock = true;
			continue;
		}
		if (argument === "--model") {
			const value = args[++index];
			if (!value) throw new Error("--model requires provider/model");
			model = parseModel(value);
			continue;
		}
		if (argument === "--image") {
			const value = args[++index];
			if (!value) throw new Error("--image requires a path");
			imagePaths.push(value);
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (action === "skills-validate") {
			if (skillsPath !== undefined) throw new Error("skills validate accepts exactly one path");
			skillsPath = argument;
			continue;
		}
		promptParts.push(argument);
	}

	if (output === "json" && explicitMode === "interactive") throw new Error("--json cannot be used with --interactive");
	if (includeMediaData && output !== "json") throw new Error("--include-media-data requires --json");
	const mode = explicitMode ?? (output === "json" || !io.stdin.isTTY || !io.stdout.isTTY ? "print" : "interactive");
	let prompt = promptParts.join(" ").trim();
	if (action !== "run" && (prompt.length > 0 || imagePaths.length > 0)) {
		throw new Error(`${action} does not accept a prompt or image`);
	}
	if (action === "skills-validate" && !skillsPath) throw new Error("skills validate requires a path");
	if (action === "run" && prompt.length === 0 && !io.stdin.isTTY) prompt = (await io.stdin.readAll()).trim();
	return {
		action,
		mode,
		output,
		permissionProfile: dangerouslyBypassApprovalsAndSandbox ? "full-access" : permissionProfile,
		approvalPolicy: dangerouslyBypassApprovalsAndSandbox ? "never" : approvalPolicy,
		additionalWritableRoots: Object.freeze([...additionalWritableRoots]),
		dangerouslyBypassApprovalsAndSandbox,
		reasoning,
		apiKey,
		workspace,
		trustProject,
		trustProjectMcp,
		persistSession,
		noSession,
		noColor,
		colorScheme,
		noAnimations,
		includeMediaData,
		resumeId,
		forceUnlock,
		model,
		prompt,
		imagePaths: Object.freeze([...imagePaths]),
		...(skillsPath ? { skillsPath } : {}),
	};
}

function findModel(models: Models, selection: ModelSelection): Model<Api> {
	const model = models.getModel(selection.provider, selection.id);
	if (!model) throw new Error(`Model not found: ${selection.provider}/${selection.id}`);
	return model;
}

function finalText(message: Immutable<AssistantMessage>): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

const HELP = `Usage: coda [options] [prompt]

Modes:
  -p, --print                    Run once and print the final answer
  -i, --interactive              Start the interactive terminal UI
      --no-tui                   Alias for --print
      --no-color                 Disable color in this Coda invocation
      --color-scheme <scheme>    Terminal appearance: auto, light, or dark
      --no-animations            Disable periodic TUI motion
      --json                     Emit stable JSONL Agent events
      --include-media-data      Include base64 in JSON media descriptors

Model:
      --model <provider/model>   Select an exact Model
      --reasoning <level>        off|minimal|low|medium|high|xhigh|max
      --api-key <key>            Use a request-scoped API key
      --image <path>             Attach an image (repeatable)

Permissions:
      --workspace <path>         Select the Workspace root
      --sandbox <mode>           read-only|workspace-write|danger-full-access
      --ask-for-approval <mode>  untrusted|on-request|granular|never
      --add-dir <path>           Add an explicit writable root (repeatable)
      --dangerously-bypass-approvals-and-sandbox
                                 Disable approval prompts and the outer Sandbox
      --trust-project            Trust the current root AGENTS.md hash
      --trust-project-mcp        Trust the exact current Workspace MCP configuration

Session:
      --session                  Persist this Session (print mode is memory-only by default)
      --no-session               Disable default interactive persistence
      --resume <id>              Resume a linear Session
      --force-unlock             Archive a definitely dead lock in print mode

Commands:
  sessions                       List Sessions for the selected Workspace
  cleanup                        Remove expired, unreferenced temporary logs
  skills validate <path>         Strictly validate one Agent Skill without starting a Session

Other:
  -h, --help                     Show this help
  -v, --version                  Show the Coda version
`;

function createEffortCommand(
	session: Session,
	runRuntime: RunRuntimeSlot<PreparedRunRuntime>,
): NonNullable<InteractiveSessionOptions["effortCommand"]> {
	return {
		snapshot: () => ({
			current: runRuntime.selected.reasoning,
			available: availableReasoningEfforts(runRuntime.selected.model),
		}),
		select: async (effort) => {
			const selected = runRuntime.selected;
			const reasoning = effectiveReasoningEffort(selected.model, effort);
			if (reasoning !== effort) {
				throw new Error(
					`Reasoning effort ${effort} is not supported by ${selected.model.provider}/${selected.model.id}`,
				);
			}
			await session.record({
				type: "model_selected",
				model: { provider: selected.model.provider, id: selected.model.id },
				reasoning,
			});
			runRuntime.select({ ...selected, reasoning });
			return reasoning;
		},
	};
}

function promptRuntime(options: CodingAgentApplicationOptions, terminal: Terminal): PromptRuntime {
	if (!options.runtime.scheduler) {
		throw new Error("Interactive mode requires injected Terminal and Scheduler capabilities");
	}
	return {
		terminal,
		clock: options.runtime.clock,
		scheduler: options.runtime.scheduler,
		keybindings: options.keybindings ?? [],
		diagnostics: options.diagnostics,
		fullScreenOutput: options.fullScreenOutput,
		lifecycle: options.runtime.interactiveLifecycle,
	};
}

async function answerAuthPrompt(runtime: PromptRuntime, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const selected = await selectFromTerminal(runtime, prompt.message, prompt.options);
		if (selected === undefined) throw new Error("Authentication was cancelled");
		return selected;
	}
	const value = await promptTextFromTerminal(runtime, {
		message: prompt.message,
		placeholder: prompt.placeholder,
		secret: prompt.type === "secret",
	});
	if (value === undefined) throw new Error("Authentication was cancelled");
	return value;
}

async function authenticateInteractively(
	options: CodingAgentApplicationOptions,
	providerId: string,
	runtime: PromptRuntime,
): Promise<void> {
	await options.models.login(providerId, "api_key", {
		prompt: (prompt) => answerAuthPrompt(runtime, prompt),
		notify: (event) => {
			const message =
				event.type === "auth_url"
					? `Authenticate at ${event.url}`
					: event.type === "device_code"
						? `Authenticate at ${event.verificationUri} with code ${event.userCode}`
						: event.message;
			void options.io.stderr.write(`coda: ${message}\n`);
		},
	});
}

async function selectModelInteractively(
	options: CodingAgentApplicationOptions,
	runtime: PromptRuntime,
): Promise<ModelSelection> {
	let available = await options.models.getAvailable();
	if (available.length === 0) {
		const loginProviders = options.models
			.getProviders()
			.filter((provider) => provider.auth.apiKey?.login)
			.sort((left, right) => left.id.localeCompare(right.id));
		if (loginProviders.length === 0) throw new Error("No authenticated Models are available");
		const providerId =
			loginProviders.length === 1
				? loginProviders[0]!.id
				: await selectFromTerminal(
						runtime,
						"Select a Provider to authenticate",
						loginProviders.map((provider) => ({
							id: provider.id,
							label: provider.name,
							description: provider.id,
						})),
					);
		if (!providerId) throw new Error("Provider selection was cancelled");
		await authenticateInteractively(options, providerId, runtime);
		available = await options.models.getAvailable();
	}
	if (available.length === 0) throw new Error("No authenticated Models are available");
	const sorted = [...available].sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
	);
	const selected = await selectFromTerminal(
		runtime,
		"Select a Model",
		sorted.map((model) => ({
			id: `${model.provider}\0${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: `${model.name} • ${model.api}${model.reasoning ? " • reasoning" : ""}`,
		})),
	);
	if (!selected) throw new Error("Model selection was cancelled");
	const separator = selected.indexOf("\0");
	return { provider: selected.slice(0, separator), id: selected.slice(separator + 1) };
}

function defaultApprovalPolicy(profile: PermissionProfile): ApprovalPolicy {
	return profile === "full-access" ? "never" : "on-request";
}

async function canonicalDirectory(path: string, base: string, fileSystem: FileSystem): Promise<string> {
	const candidate = isAbsolute(path) ? path : resolve(base, path);
	const canonical = await fileSystem.realpath(candidate);
	const status = await fileSystem.stat(canonical);
	if (status.kind !== "directory") throw new Error(`Permission root is not a directory: ${path}`);
	return canonical;
}

function approvalPolicyLabel(policy: ApprovalPolicy): string {
	return typeof policy === "object" ? "granular" : policy;
}

function permissionProfileLabel(profile: PermissionProfile): string {
	return profile === "read-only" ? "Read Only" : profile === "workspace" ? "Workspace" : "Full Access";
}

function promptReadAccess(profile: ReturnType<typeof compileSandboxPolicy>): {
	readonly mode: "root-scoped" | "full-disk";
	readonly roots: readonly string[];
	readonly protectedRootCount: number;
} {
	return Object.freeze({
		mode: profile.readAccess,
		roots: Object.freeze([...new Set([...profile.readableRoots, ...profile.approvedReadRoots])]),
		protectedRootCount: profile.deniedReadRoots.length,
	});
}

function interactiveStatusLineSnapshot(
	runtime: PreparedRunRuntime,
	agent: Agent,
	session: Session,
	contextWindow: ContextWindowController,
	systemPrompt: string,
): SessionStatusLineSnapshot {
	const context = contextWindow.usage(
		{
			systemPrompt,
			tools: runtime.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		},
		agent.state.messages,
	);
	const cost = sessionCostSnapshot(
		agent.state.messages,
		contextWindow.compactionCost,
		session.discardedModelCost,
		runtime.model.cost !== undefined,
	);
	return {
		modelSupportsReasoning: runtime.model.reasoning,
		context: {
			usedTokens: context.usedTokens,
			windowTokens: runtime.model.contextWindow,
			estimated: context.estimated || latestUsageComesFromAnotherModel(agent, runtime.model),
		},
		...(cost ? { cost } : {}),
	};
}

function latestUsageComesFromAnotherModel(agent: Agent, model: Model<Api>): boolean {
	for (let index = agent.state.messages.length - 1; index >= 0; index--) {
		const message = agent.state.messages[index]?.message;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usageTokens =
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (usageTokens === 0) continue;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
}

function approvalRequiredEvent(request: Parameters<PermissionApprovalHandler["decide"]>[0]): unknown {
	return {
		schemaVersion: 3,
		type: "approval_required",
		request: {
			...request,
			runId: String(request.runId),
			turnId: String(request.turnId),
			invocationId: String(request.invocationId),
		},
	};
}

function emptyMcpToolSnapshot(): McpToolSnapshot {
	return Object.freeze({
		revision: 0,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		callTool: async () => {
			throw new Error("No MCP Tools are available");
		},
	});
}

function workspaceMcpReviewText(snapshot: WorkspaceMcpConfigurationSnapshot): string {
	const serverPreview = snapshot.servers.slice(0, 50).map((server) => {
		const target =
			server.transport.kind === "stdio"
				? `${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
				: server.transport.url;
		return `- ${server.id} (${server.transport.kind}): ${target}`;
	});
	return sanitizeTerminalText(
		[
			"Trust this Workspace MCP configuration?",
			`Path: ${snapshot.path}`,
			`SHA-256: ${snapshot.sha256}`,
			`Servers: ${snapshot.serverCount}`,
			"The exact file hash is stored separately from AGENTS.md and Skills trust; any change requires review again.",
			"Trusting a stdio Server allows Coda to launch its configured executable. Tool calls still require Permission decisions.",
			"HTTP credentials are resolved outside this file and are never shown here.",
			"",
			...serverPreview,
			...(snapshot.servers.length > serverPreview.length ? ["… (Server preview truncated)"] : []),
		].join("\n"),
	);
}

async function validateSkillPath(
	path: string,
	options: Pick<CodingAgentApplicationOptions, "fileSystem" | "io" | "runtime">,
	output: "json" | "text",
): Promise<number> {
	const requested = isAbsolute(path) ? path : resolve(options.runtime.cwd, path);
	const canonical = await options.fileSystem.realpath(requested);
	const status = await options.fileSystem.stat(canonical);
	const skillFile = status.kind === "directory" ? join(canonical, "SKILL.md") : canonical;
	if (status.kind !== "directory" && status.kind !== "file") {
		throw new Error(`Skill validation path is not a regular file or directory: ${path}`);
	}
	if (status.kind === "file" && basename(skillFile) !== "SKILL.md") {
		throw new Error("Skill validation file must be named exactly SKILL.md");
	}
	const skillStatus = await options.fileSystem.stat(skillFile);
	if (skillStatus.kind !== "file") throw new Error(`Skill manifest is not a regular file: ${skillFile}`);
	if (skillStatus.size > DEFAULT_SKILL_LIMITS.maxSkillFileBytes) {
		throw new Error(`SKILL.md exceeds the ${DEFAULT_SKILL_LIMITS.maxSkillFileBytes}-byte limit`);
	}
	const bytes = await options.fileSystem.readFile(skillFile);
	if (bytes.byteLength > DEFAULT_SKILL_LIMITS.maxSkillFileBytes) {
		throw new Error(`SKILL.md exceeds the ${DEFAULT_SKILL_LIMITS.maxSkillFileBytes}-byte limit`);
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("SKILL.md is not valid UTF-8");
	}
	const result = validateAgentSkill({
		text,
		directoryName: basename(dirname(skillFile)),
		path: skillFile,
	});
	const validationLine = (value: string) => sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
	if (output === "json") {
		await options.io.stdout.write(
			`${JSON.stringify({ schemaVersion: 1, type: "skill_validation", path: skillFile, valid: result.valid, diagnostics: result.diagnostics })}\n`,
		);
	} else {
		await options.io.stdout.write(
			`${result.valid ? "Valid Agent Skill" : "Invalid Agent Skill"}: ${validationLine(skillFile)}\n`,
		);
		for (const diagnostic of result.diagnostics) {
			await options.io.stdout.write(
				`${validationLine(`[${diagnostic.severity}] ${diagnostic.code}${diagnostic.field ? ` (${diagnostic.field})` : ""}: ${diagnostic.message}`)}\n`,
			);
		}
	}
	return result.valid ? 0 : 1;
}

function assertSkillReferencesAvailable(
	snapshot: CodingSkillsSnapshot,
	references: readonly ComposerExtensionReference[],
): void {
	for (const reference of references) {
		if (reference.source !== "skill") {
			throw new Error(`Extension reference loading is unavailable for source: ${reference.source}`);
		}
		const id = skillIdFromCommandId(reference.commandId);
		const resolved = id ? snapshot.byId.get(id) : undefined;
		if (!resolved) {
			throw new Error(`Selected Skill is no longer available: ${reference.name}`);
		}
	}
}

export function createCodingAgentApplication(providedOptions: CodingAgentApplicationOptions): CodingAgentApplication {
	const fullScreenOutput = providedOptions.fullScreenOutput ?? new FullScreenOutputGate(providedOptions.io);
	const options: CodingAgentApplicationOptions = {
		...providedOptions,
		io: fullScreenOutput.io,
		fullScreenOutput,
		diagnostics: providedOptions.diagnostics ?? fullScreenOutput.diagnostics,
	};
	const sessions =
		options.sessions ??
		new InMemorySessionManager({ clock: options.runtime.clock, idGenerator: options.runtime.idGenerator });
	const providerManager =
		providedOptions.providerManager ??
		new ProviderManager({ models: providedOptions.models, fetch: unavailableProviderDiscoveryFetch });
	let providersRestored = false;
	return {
		run: async (args) => {
			try {
				const parsed = await parseArguments(args, options.io);
				if (parsed.action === "help") {
					await options.io.stdout.write(HELP);
					return 0;
				}
				if (parsed.action === "version") {
					await options.io.stdout.write("0.1.0\n");
					return 0;
				}
				if (parsed.action === "skills-validate") {
					return validateSkillPath(parsed.skillsPath!, options, parsed.output);
				}
				const maintenanceDiagnostics: DiagnosticSink =
					options.diagnostics ??
					((diagnostic) => options.io.stderr.write(`coda: [${diagnostic.code}] ${diagnostic.message}\n`));
				const cleanup = async () => {
					const [logs, media] = await Promise.all([
						cleanupTemporaryLogs({
							fileSystem: options.fileSystem,
							homeDirectory: options.runtime.homeDirectory,
							now: options.runtime.clock.now(),
							diagnostics: maintenanceDiagnostics,
						}),
						cleanupSessionMedia({
							fileSystem: options.fileSystem,
							homeDirectory: options.runtime.homeDirectory,
							now: options.runtime.clock.now(),
							diagnostics: maintenanceDiagnostics,
						}),
					]);
					return {
						removed: [...logs.removed, ...media.removed],
						retainedBytes: logs.retainedBytes + media.retainedBytes,
					};
				};
				if (parsed.action === "cleanup") {
					const result = await cleanup();
					if (parsed.output === "json") {
						await options.io.stdout.write(
							`${JSON.stringify({ schemaVersion: 1, type: "cleanup", removed: result.removed.length, retainedBytes: result.retainedBytes })}\n`,
						);
					} else {
						await options.io.stdout.write(
							`Removed ${result.removed.length} unreferenced artifact${result.removed.length === 1 ? "" : "s"}; ${result.retainedBytes} bytes retained.\n`,
						);
					}
					return 0;
				}
				void cleanup().catch(async (error: unknown) => {
					await maintenanceDiagnostics({
						code: "temporary-log.cleanup-failed",
						message: error instanceof Error ? error.message : String(error),
					});
				});
				if (parsed.action === "sessions") {
					const workspace = await createWorkspace(parsed.workspace ?? options.runtime.cwd, options.fileSystem);
					const workspaceId = createHash("sha256").update(workspace.root).digest("hex").slice(0, 32);
					const descriptors = await sessions.list({ id: workspaceId, path: workspace.root });
					if (parsed.output === "json") {
						for (const descriptor of descriptors) {
							await options.io.stdout.write(
								`${JSON.stringify({ schemaVersion: 1, type: "session", ...descriptor })}\n`,
							);
						}
					} else if (descriptors.length === 0) {
						await options.io.stdout.write("(no Sessions)\n");
					} else {
						for (const descriptor of descriptors) {
							await options.io.stdout.write(
								`${descriptor.id}\t${new Date(descriptor.createdAt).toISOString()}\t${descriptor.workspace.path}\n`,
							);
						}
					}
					return 0;
				}
				if (parsed.mode === "print" && parsed.prompt.length === 0 && parsed.imagePaths.length === 0) {
					throw new Error("Print mode requires a prompt or image");
				}
				let settings = await options.settings.load();
				if (!providersRestored) {
					providerManager.restore(settings.customProviders ?? []);
					providersRestored = true;
				}
				const terminal =
					parsed.mode === "interactive"
						? options.terminalFactory?.create({
								noColor: parsed.noColor || options.runtime.environment.NO_COLOR !== undefined,
								colorScheme: parsed.colorScheme ?? settings.ui?.colorScheme ?? "auto",
							})
						: undefined;
				if (parsed.mode === "interactive" && !terminal) {
					throw new Error("Interactive mode requires an injected Terminal factory");
				}
				const interactiveRuntime = terminal ? promptRuntime(options, terminal) : undefined;
				const workspace = await createWorkspace(parsed.workspace ?? options.runtime.cwd, options.fileSystem);
				const workspaceId = createHash("sha256").update(workspace.root).digest("hex").slice(0, 32);
				const session = await sessions.open({
					workspace: { id: workspaceId, path: workspace.root },
					mode: parsed.mode,
					resumeId: parsed.resumeId,
					forceUnlock: parsed.forceUnlock,
					persistent: parsed.persistSession || (parsed.mode === "interactive" && !parsed.noSession),
				});
				const mediaToken = pathSafeIdentity(options.runtime.idGenerator.generate("queue_item"));
				const mediaLibrary = new MediaLibrary({
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
				let skillWatcher: SkillWatcher | undefined;
				let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
				let mcpRegistry: CodingMcpRegistry | undefined;
				try {
					let selection = parsed.model ?? session.restored.model ?? settings.defaultModel;
					if (!selection) {
						if (!interactiveRuntime) {
							throw new Error("Print mode requires an explicit, restored, or configured Model");
						}
						selection = await selectModelInteractively(options, interactiveRuntime);
						settings = { ...settings, defaultModel: selection };
						await options.settings.save(settings);
					}
					const model = findModel(options.models, selection);
					const reasoning = effectiveReasoningEffort(
						model,
						parsed.reasoning ?? session.restored.reasoning ?? settings.defaultReasoning ?? "medium",
					);
					const projectInstructions = await loadProjectInstructions(workspace, options.fileSystem);
					const trustedProject = projectInstructions
						? (settings.projectTrust ?? []).some(
								(entry) =>
									entry.workspace === workspace.root &&
									entry.path === projectInstructions.path &&
									entry.sha256 === projectInstructions.sha256,
							)
						: false;
					if (projectInstructions && !trustedProject) {
						const trustedInteractively =
							!parsed.trustProject && interactiveRuntime
								? await confirmFromTerminal(
										interactiveRuntime,
										[
											"Trust this project instruction file?",
											`Path: ${projectInstructions.path}`,
											`SHA-256: ${projectInstructions.sha256}`,
											"The exact hash will be bound to this Workspace; any change requires approval again.",
											"",
											"Content preview:",
											projectInstructions.content.slice(0, 2_000),
											...(projectInstructions.content.length > 2_000
												? ["… (preview truncated; review the file at the path above)"]
												: []),
										].join("\n"),
									)
								: false;
						if (!parsed.trustProject && !trustedInteractively) {
							throw new Error(
								`AGENTS.md is untrusted or changed (${projectInstructions.sha256}); pass --trust-project after review`,
							);
						}
						const retained = (settings.projectTrust ?? []).filter((entry) => entry.workspace !== workspace.root);
						settings = {
							...settings,
							projectTrust: [
								...retained,
								{
									workspace: workspace.root,
									path: projectInstructions.path,
									sha256: projectInstructions.sha256,
								},
							].sort((left, right) => left.workspace.localeCompare(right.workspace)),
						};
						await options.settings.save(settings);
						await session.record({
							type: "project_trust_changed",
							trust: {
								workspace: workspace.root,
								path: projectInstructions.path,
								sha256: projectInstructions.sha256,
							},
						});
					}
					const skillRoots = await collectSkillRoots({
						workspace: workspace.root,
						homeDirectory: options.runtime.homeDirectory,
					});
					const skillsManager = new CodingSkillsManager({
						fileSystem: options.fileSystem,
						roots: skillRoots,
					});
					const skillsSnapshot = await skillsManager.refresh();
					let mcpConfiguration = await inspectMcpConfiguration({
						workspace: workspace.root,
						fileSystem: options.fileSystem,
						userServers: settings.mcpServers ?? [],
						workspaceTrust: settings.workspaceMcpTrust ?? [],
						environment: options.runtime.environment,
					});
					if (mcpConfiguration.workspace?.trust === "untrusted") {
						const trustedInteractively =
							!parsed.trustProjectMcp && interactiveRuntime
								? await confirmFromTerminal(
										interactiveRuntime,
										workspaceMcpReviewText(mcpConfiguration.workspace),
									)
								: false;
						if (parsed.trustProjectMcp || trustedInteractively) {
							const trust: WorkspaceMcpTrustRecord = {
								workspace: workspace.root,
								path: mcpConfiguration.workspace.path,
								sha256: mcpConfiguration.workspace.sha256,
							};
							settings = {
								...settings,
								workspaceMcpTrust: [
									...(settings.workspaceMcpTrust ?? []).filter((entry) => entry.workspace !== workspace.root),
									trust,
								].sort((left, right) => left.workspace.localeCompare(right.workspace)),
							};
							await options.settings.save(settings);
							await session.record({ type: "mcp_trust_changed", trust });
							mcpConfiguration = await inspectMcpConfiguration({
								workspace: workspace.root,
								fileSystem: options.fileSystem,
								userServers: settings.mcpServers ?? [],
								workspaceTrust: settings.workspaceMcpTrust ?? [],
								environment: options.runtime.environment,
							});
						} else if (!interactiveRuntime) {
							await options.io.stderr.write(
								`coda: Workspace MCP configuration ${mcpConfiguration.workspace.sha256} is untrusted; its Servers were omitted\n`,
							);
						}
					}
					if (mcpConfiguration.definitions.length > 0 && !options.mcpConnector) {
						throw new Error("MCP Servers are configured but no MCP connector is available");
					}
					if (options.mcpConnector) {
						mcpRegistry = new CodingMcpRegistry({
							host: createMcpHost({ connector: options.mcpConnector }),
							...(options.runtime.scheduler ? { scheduler: options.runtime.scheduler } : {}),
						});
						const mcpSnapshot = await mcpRegistry.reload(mcpConfiguration.definitions);
						for (const server of mcpSnapshot.servers) {
							if (server.status === "degraded") {
								await options.io.stderr.write(
									`coda: MCP Server ${server.id} is unavailable: ${server.error ?? "unknown error"}\n`,
								);
							}
						}
					}
					const commandRegistry = options.commandRegistry ?? createCoreCommandRegistry();
					skillRegistryBinding = new SkillCommandRegistryBinding(commandRegistry);
					skillRegistryBinding.sync(skillsSnapshot);
					if (interactiveRuntime && options.skillWatcher) {
						skillWatcher = options.skillWatcher.watch(
							skillRoots.map(({ path }) => path),
							() => skillsManager.markDirty(),
							(error) => {
								void maintenanceDiagnostics({ code: "skills.watcher-failed", message: error.message });
							},
						);
					}
					const refreshSkills = async (): Promise<CodingSkillsSnapshot> => {
						const snapshot = await skillsManager.refresh();
						skillRegistryBinding!.sync(snapshot);
						return snapshot;
					};
					const skillsCommand = {
						snapshot: refreshSkills,
						refresh: refreshSkills,
					};
					const mcpCommandSnapshot = () => ({
						host:
							mcpRegistry?.snapshot() ?? Object.freeze({ revision: 0, servers: [], tools: [], diagnostics: [] }),
						...(mcpConfiguration.workspace ? { workspace: mcpConfiguration.workspace } : {}),
					});
					const reloadMcp = async () => {
						const latestSettings = await options.settings.load();
						settings = {
							...settings,
							mcpServers: latestSettings.mcpServers,
							workspaceMcpTrust: latestSettings.workspaceMcpTrust,
						};
						mcpConfiguration = await inspectMcpConfiguration({
							workspace: workspace.root,
							fileSystem: options.fileSystem,
							userServers: settings.mcpServers ?? [],
							workspaceTrust: settings.workspaceMcpTrust ?? [],
							environment: options.runtime.environment,
						});
						if (!mcpRegistry) {
							if (mcpConfiguration.definitions.length > 0) {
								throw new Error("MCP Servers are configured but no MCP connector is available");
							}
							return mcpCommandSnapshot();
						}
						await mcpRegistry.reload(mcpConfiguration.definitions);
						return mcpCommandSnapshot();
					};
					const mcpCommand = {
						snapshot: mcpCommandSnapshot,
						reload: reloadMcp,
						reconnect: async (serverId: string) => {
							if (!mcpRegistry) throw new Error("MCP is unavailable");
							await mcpRegistry.reconnect(serverId);
							return mcpCommandSnapshot();
						},
					};
					let auth = await options.models.getAuth(model, {
						apiKey: parsed.apiKey,
						clock: options.runtime.clock,
					});
					if (!auth && interactiveRuntime && !parsed.apiKey) {
						await authenticateInteractively(options, model.provider, interactiveRuntime);
						auth = await options.models.getAuth(model, { clock: options.runtime.clock });
					}
					if (!auth) throw new Error(`Model is not authenticated: ${model.provider}/${model.id}`);
					if (parsed.imagePaths.length > 0 && !model.input.includes("image")) {
						throw new Error(`Model does not support image input: ${model.provider}/${model.id}`);
					}
					const initialAttachmentIds: string[] = [];
					for (const path of parsed.imagePaths) {
						initialAttachmentIds.push((await mediaLibrary.ingestPath(path)).id);
					}
					const initialInput = await promptInput(parsed.prompt, initialAttachmentIds, mediaLibrary);
					const additionalWritableRoots = await Promise.all(
						parsed.additionalWritableRoots.map((path) =>
							canonicalDirectory(path, workspace.root, options.fileSystem),
						),
					);
					const temporaryDirectory = await canonicalDirectory(
						options.runtime.environment.TMPDIR ?? "/tmp",
						workspace.root,
						options.fileSystem,
					);
					const deniedReadRoots = await resolveDefaultDeniedReadRoots(
						options.runtime.homeDirectory,
						workspace,
						options.runtime.environment,
					);
					const selectedProfile =
						parsed.permissionProfile ??
						session.restored.permissionProfile ??
						settings.permissions?.profile ??
						(projectInstructions ? "workspace" : "read-only");
					const selectedApprovalPolicy =
						parsed.approvalPolicy ??
						settings.permissions?.approvalPolicy ??
						defaultApprovalPolicy(selectedProfile);
					const compiledProfile = compileSandboxPolicy({
						profile: selectedProfile,
						workspaceRoots: [workspace.root],
						temporaryDirectory,
						additionalWritableRoots,
						deniedReadRoots,
					});
					const configuredShell = options.runtime.environment.SHELL;
					const shellExecutable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
					const interactiveApproval =
						parsed.mode === "interactive" && !options.approval ? new InteractiveApprovalHandler() : undefined;
					const interactiveMcpElicitation =
						parsed.mode === "interactive" && !options.mcpElicitation
							? new InteractiveMcpElicitationHandler()
							: undefined;
					const primaryMcpElicitation =
						options.mcpElicitation ?? interactiveMcpElicitation?.forSession(session.descriptor.id);
					const rejectingApproval =
						parsed.mode === "print" && !options.approval
							? new RejectingApprovalHandler(async (request) => {
									if (parsed.output === "json") {
										await options.io.stdout.write(`${JSON.stringify(approvalRequiredEvent(request))}\n`);
									} else {
										const target = request.command ?? request.canonicalPath ?? request.host ?? request.kind;
										await options.io.stderr.write(`coda: approval required for ${request.kind}: ${target}\n`);
									}
								})
							: undefined;
					const ruleStore = options.permissionRules ?? createInMemoryPermissionRuleStore();
					const [commandPolicy, networkRules] = await Promise.all([
						ruleStore.loadCommandPolicy(),
						ruleStore.loadNetworkRules(),
					]);
					const audit: PermissionAuditSink = (event) =>
						session.record({ type: "permission_audit_recorded", event });
					const approvalHandler =
						options.approval ?? interactiveApproval?.forSession(session.descriptor.id) ?? rejectingApproval!;
					const auditedApproval: PermissionApprovalHandler = {
						decide: async (request) => {
							try {
								const decision = await approvalHandler.decide(request);
								await audit(approvalDecisionAuditEvent(request, decision));
								return decision;
							} catch (error) {
								await audit(
									approvalDecisionAuditEvent(request, {
										type: "reviewer-failed",
										message: error instanceof Error ? error.message : String(error),
									}),
								);
								throw error;
							}
						},
					};
					const persistRule = async (
						kind: "command" | "network",
						rule: CommandRule | NetworkRule,
						persist: () => Promise<void>,
					): Promise<void> => {
						try {
							await persist();
						} catch (error) {
							await audit({
								type: "rule_persistence",
								kind,
								rule,
								outcome: "failed",
								error: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}
						await audit({ type: "rule_persistence", kind, rule, outcome: "persisted" });
					};
					let runRuntimeForApproval: RunRuntimeSlot<PreparedRunRuntime> | undefined;
					const createPolicy = (
						profile: ReturnType<typeof compileSandboxPolicy>,
						approvalPolicy: ApprovalPolicy,
					): PermissionEngine =>
						createPermissionEngine({
							cwd: workspace.root,
							shellExecutable,
							workspace,
							profile,
							approvalPolicy,
							approval: auditedApproval,
							genericApprovalForTool: (request) => {
								if (parsed.dangerouslyBypassApprovalsAndSandbox) return undefined;
								if (request.toolName === "skill" && typeof request.arguments.skill === "string") {
									const id = skillIdFromCommandId(request.arguments.skill);
									const resolved = id ? runRuntimeForApproval?.active?.value.skills.byId.get(id) : undefined;
									return {
										kind: "skill",
										reason: resolved
											? `Activate Skill ${resolved.candidate.metadata.name} (${resolved.candidate.id}, revision ${resolved.candidate.revision})`
											: `Activate unavailable Skill ${request.arguments.skill}`,
									};
								}
								const mcpTool = runRuntimeForApproval?.active?.value.mcp.tools.find(
									(tool) => tool.name === request.toolName,
								);
								return mcpTool
									? {
											kind: "mcp",
											reason: `Call MCP Tool ${mcpTool.serverId}/${mcpTool.remoteName}`,
										}
									: undefined;
							},
							resolveExecutable: createExecutableIdentityResolver({
								fileSystem: options.fileSystem,
								path: options.runtime.environment.PATH,
								pathExtensions: options.runtime.environment.PATHEXT,
								platform: options.runtime.platform,
							}),
							onSessionApprovalUsed: audit,
							onReadAccessDecision: audit,
							commandRules: commandPolicy.rules,
							hostExecutables: commandPolicy.hostExecutables,
							networkRules,
							persistCommandRule: (rule) =>
								persistRule("command", rule, () => ruleStore.appendCommandRule(rule)),
							persistNetworkRule: (rule) =>
								persistRule("network", rule, () => ruleStore.appendNetworkRule(rule)),
							onWarning: async (message) => {
								await audit({ type: "warning", message });
								await options.io.stderr.write(`coda: ${message}\n`);
							},
						});
					const initialPermission = createPolicy(compiledProfile, selectedApprovalPolicy);
					const initialMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
					const runRuntime = new RunRuntimeSlot<PreparedRunRuntime>({
						model,
						reasoning,
						authSnapshot: auth,
						permission: initialPermission,
						skills: skillsSnapshot,
						mcp: initialMcp,
						tools: Object.freeze([]),
					});
					runRuntimeForApproval = runRuntime;
					const policy = new RunPermissionRouter(runRuntime, ({ permission }) => permission);
					await audit(permissionConfigurationAuditEvent("startup", compiledProfile, selectedApprovalPolicy));
					if (!session.restored.permissionProfile || parsed.permissionProfile) {
						await session.record({ type: "permission_selected", profile: selectedProfile });
					}
					const modelProcessRunner = createAuditedModelProcessRunner(
						options.modelProcessRunner ?? createModelProcessRunner(),
						audit,
					);
					const baseTools = createCodingTools({
						workspace,
						fileSystem: options.fileSystem,
						processRunner: modelProcessRunner,
						permissions: policy,
						shellExecutable,
						runtime: options.runtime,
						settings,
						sessionHistory: session.history,
						onAudit: audit,
					});
					const toolsForRun = (snapshot: CodingSkillsSnapshot, mcp: McpToolSnapshot): readonly AgentTool[] => {
						const skillTool = createSkillTool(snapshot);
						const mcpTools = createMcpAgentTools({
							snapshot: mcp,
							elicit: async (request) => {
								if (!primaryMcpElicitation) return { action: "decline" };
								if (parsed.dangerouslyBypassApprovalsAndSandbox) return primaryMcpElicitation(request);
								const decision = await policy.requestGenericApproval({
									kind: "mcp",
									runId: request.execution.runId,
									turnId: request.execution.turnId,
									invocationId: request.execution.invocationId,
									toolName: request.tool.name,
									reason: `Allow ${request.server.server?.name ?? request.server.id} to request ${request.request.mode} Elicitation for ${request.tool.remoteName}`,
								});
								return decision.decision === "allow" ? primaryMcpElicitation(request) : { action: "decline" };
							},
						});
						return Object.freeze([...baseTools, ...(skillTool ? [skillTool] : []), ...mcpTools]);
					};
					runRuntime.select({
						...runRuntime.selected,
						tools: toolsForRun(skillsSnapshot, initialMcp),
					});
					const runSkills = new RunSkillsCoordinator();
					const freezePrompt = (runtime: PreparedRunRuntime) =>
						buildSystemPrompt({
							workspace: workspace.root,
							platform: options.runtime.platform,
							timestamp: options.runtime.clock.now(),
							tools: runtime.tools.map((tool) => ({ name: tool.name, description: tool.description })),
							capabilities: {
								interactionMode: parsed.mode,
								permissionProfile: runtime.permission.configuration().profile.profile,
								approvalPolicy: approvalPolicyLabel(runtime.permission.configuration().approvalPolicy),
								readAccess: promptReadAccess(runtime.permission.configuration().profile),
							},
							projectInstructions,
							skills: promptSkillCatalog(runtime.skills, runtime.model.contextWindow),
						});
					let promptSnapshot = freezePrompt(runRuntime.selected);
					let activeRuntimeId: number | undefined;
					const contextWindow = new ContextWindowController({
						models: options.models,
						clock: options.runtime.clock,
						idGenerator: options.runtime.idGenerator,
						runtime: () => {
							const runtime = runRuntime.active?.value ?? runRuntime.selected;
							return { model: runtime.model, authSnapshot: runtime.authSnapshot };
						},
						commit: (checkpoint) => session.record({ type: "context_compacted", checkpoint }),
						checkpoint: session.compactionCheckpoint,
					});
					await session.record({
						type: "model_selected",
						model: { provider: model.provider, id: model.id },
						reasoning,
					});
					const agent = new Agent({
						clock: options.runtime.clock,
						idGenerator: options.runtime.idGenerator,
						runBudget: DEFAULT_CODING_AGENT_RUN_BUDGET,
						tools: () => {
							const runtime = runRuntime.active?.value;
							if (!runtime) throw new Error("Tools were requested outside an active Run runtime");
							return runtime.tools;
						},
						policyGate: policy,
						retry: options.runtime.scheduler ? createCodingAgentRetry(options.runtime.scheduler) : undefined,
						recoverFailedAttempt: async ({ message }) => {
							if (!isRecoverableContextOverflow(message.message)) return { retry: false };
							if (!contextWindow.canCompact(agent.state.messages)) return { retry: false };
							await contextWindow.compact({
								messages: agent.state.messages,
								reason: "overflow",
							});
							return { retry: true, reason: "context overflow compacted" };
						},
						stream: async ({ context, signal }) => {
							const runtime = runRuntime.active?.value;
							if (!runtime) throw new Error("A Model stream was requested outside an active Run runtime");
							if (!runtime.authSnapshot) {
								throw new Error(`Model is not authenticated: ${runtime.model.provider}/${runtime.model.id}`);
							}
							const preparedContext = await contextWindow.prepare(context, agent.state.messages, signal);
							const contextBudget = assertModelContextFits(runtime.model, preparedContext);
							return options.models.streamSimple(runtime.model, preparedContext, {
								signal,
								authSnapshot: runtime.authSnapshot,
								reasoning: runtime.reasoning === "off" ? undefined : runtime.reasoning,
								maxTokens: contextBudget.reservedOutputTokens,
							});
						},
						beforeRun: async ({ inputMessage }) => {
							const nextSkills =
								runSkills.consume(inputMessage.message.content) ?? (await skillsManager.refresh());
							if (mcpRegistry) await mcpRegistry.refresh();
							const nextMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
							skillRegistryBinding!.sync(nextSkills);
							runRuntime.select({
								...runRuntime.selected,
								skills: nextSkills,
								mcp: nextMcp,
								tools: toolsForRun(nextSkills, nextMcp),
							});
							const runtime = runRuntime.begin();
							activeRuntimeId = runtime.id;
							try {
								promptSnapshot = freezePrompt(runtime.value);
								await session.record({
									type: "prepare_run",
									promptVersion: promptSnapshot.version,
									promptSha256: promptSnapshot.sha256,
								});
							} catch (error) {
								runRuntime.end(runtime.id);
								activeRuntimeId = undefined;
								throw error;
							}
						},
						systemPrompt: () => promptSnapshot.text,
						seed: session.seed,
						autoDrainFollowUps: parsed.mode !== "interactive",
					});
					session.attach(agent);
					const initialAttachments = await Promise.all(
						initialAttachmentIds.map((attachmentId) => chatAttachment(mediaLibrary, attachmentId)),
					);
					const restoredMedia = await restoredChatAttachments(
						session.mediaReferences,
						session.descriptor.path,
						options.fileSystem,
						new Set(session.recoverableFollowUps.map(({ item }) => item.id)),
					);
					const prepareAttachments = (attachmentIds: readonly string[]) =>
						prepareAttachmentTransaction(
							attachmentIds.filter((id) => !restoredMedia.contents.has(id)),
							mediaLibrary,
							session,
						);
					const initialMessageCount = agent.state.messages.length;
					agent.onEvent((event) => {
						if (
							(event.type === "tool_execution_rejected" || event.type === "tool_execution_end") &&
							policy.consumeAbort(event.invocation.id)
						) {
							agent.abort();
						}
						if (event.type === "run_end") {
							void contextWindow.flushManual(agent.state.messages).catch(() => undefined);
							if (activeRuntimeId !== undefined) {
								runRuntime.end(activeRuntimeId);
								activeRuntimeId = undefined;
							}
						}
					});
					if (parsed.mode === "interactive") {
						const persistCustomProviders = async (): Promise<void> => {
							settings = { ...settings, customProviders: providerManager.configurations };
							await options.settings.save(settings);
						};
						const sessionRunRuntimes = new Map<
							string,
							{ readonly runtime: RunRuntimeSlot<PreparedRunRuntime>; readonly apiKey: string | undefined }
						>([[session.descriptor.id, { runtime: runRuntime, apiKey: parsed.apiKey }]]);
						const refreshProviderAuth = async (providerId: string): Promise<void> => {
							for (const { runtime, apiKey } of sessionRunRuntimes.values()) {
								if (runtime.selected.model.provider !== providerId) continue;
								const selected = runtime.selected;
								const model = options.models.getModel(providerId, selected.model.id) ?? selected.model;
								const authSnapshot = await options.models.getAuth(model, {
									apiKey,
									clock: options.runtime.clock,
								});
								runtime.select({
									...selected,
									model,
									reasoning: effectiveReasoningEffort(model, selected.reasoning),
									authSnapshot,
								});
							}
						};
						const imageSurface = createTerminalImageSurface({
							terminal: interactiveRuntime!.terminal,
							environment: options.runtime.environment,
							allocateId: terminalImageIdAllocator(options.runtime.idGenerator),
						});
						const listModelEntries = async (): Promise<readonly ModelCommandEntry[]> => {
							const configuredProviders = new Set(
								(
									await Promise.all(
										options.models.getProviders().map(async (provider) => {
											try {
												return (await options.models.checkAuth(provider.id)) ? provider.id : undefined;
											} catch {
												return undefined;
											}
										}),
									)
								).filter((providerId): providerId is string => providerId !== undefined),
							);
							return options.models.getModels().map(
								(modelEntry): ModelCommandEntry => ({
									catalog:
										providerManager.catalogModel(modelEntry.provider, modelEntry.id) ??
										catalogModelFromRuntime(modelEntry),
									auth: configuredProviders.has(modelEntry.provider)
										? "configured"
										: "authentication_required",
								}),
							);
						};
						const authCommand = {
							providers: () => providerManager.authenticationEntries(),
							updateApiKey: async (providerId: string, apiKey: string) => {
								await providerManager.updateApiKey(providerId, apiKey);
								await persistCustomProviders();
								await refreshProviderAuth(providerId);
							},
							logout: async (providerId: string) => {
								await providerManager.logout(providerId);
								await refreshProviderAuth(providerId);
							},
							addCustomProvider: async (input: Parameters<ProviderManager["addCustomProvider"]>[0]) => {
								await providerManager.addCustomProvider(input);
								await persistCustomProviders();
							},
						};
						const secondaryResources = new Map<
							string,
							{ readonly session: Session; readonly mediaLibrary: MediaLibrary }
						>();
						const createSecondarySessionOptions = async (
							targetSession: Session,
							fresh: boolean,
						): Promise<InteractiveSessionOptions> => {
							const targetMcpElicitation =
								options.mcpElicitation ?? interactiveMcpElicitation?.forSession(targetSession.descriptor.id);
							const targetMediaToken = pathSafeIdentity(options.runtime.idGenerator.generate("queue_item"));
							const targetMediaLibrary = new MediaLibrary({
								fileSystem: options.fileSystem,
								stagingDirectory: join(
									options.runtime.homeDirectory,
									".coda",
									"tmp",
									"media",
									pathSafeIdentity(targetSession.descriptor.id),
									targetMediaToken,
								),
								mediaDirectory: targetSession.descriptor.path
									? `${targetSession.descriptor.path}.media`
									: join(
											options.runtime.homeDirectory,
											".coda",
											"tmp",
											"media",
											pathSafeIdentity(targetSession.descriptor.id),
											"committed",
										),
								idGenerator: options.runtime.idGenerator,
							});
							try {
								const targetSelection = targetSession.restored.model ?? settings.defaultModel;
								if (!targetSelection) throw new Error("A new Session requires a configured default Model");
								const targetModel = findModel(options.models, targetSelection);
								const targetReasoning = effectiveReasoningEffort(
									targetModel,
									targetSession.restored.reasoning ?? settings.defaultReasoning ?? "medium",
								);
								const targetAuth = await options.models.getAuth(targetModel, { clock: options.runtime.clock });
								const targetProfile = compileSandboxPolicy({
									profile: fresh ? "read-only" : (targetSession.restored.permissionProfile ?? "read-only"),
									workspaceRoots: [workspace.root],
									temporaryDirectory,
									additionalWritableRoots,
									deniedReadRoots,
								});
								const targetApprovalPolicy = defaultApprovalPolicy(targetProfile.profile);
								const targetAudit: PermissionAuditSink = (event) =>
									targetSession.record({ type: "permission_audit_recorded", event });
								const targetAuditedApproval: PermissionApprovalHandler = {
									decide: async (request) => {
										try {
											const targetApprovalHandler =
												options.approval ??
												interactiveApproval?.forSession(targetSession.descriptor.id) ??
												approvalHandler;
											const decision = await targetApprovalHandler.decide(request);
											await targetAudit(approvalDecisionAuditEvent(request, decision));
											return decision;
										} catch (error) {
											await targetAudit(
												approvalDecisionAuditEvent(request, {
													type: "reviewer-failed",
													message: error instanceof Error ? error.message : String(error),
												}),
											);
											throw error;
										}
									},
								};
								const targetPersistRule = async (
									kind: "command" | "network",
									rule: CommandRule | NetworkRule,
									persist: () => Promise<void>,
								): Promise<void> => {
									try {
										await persist();
									} catch (error) {
										await targetAudit({
											type: "rule_persistence",
											kind,
											rule,
											outcome: "failed",
											error: error instanceof Error ? error.message : String(error),
										});
										throw error;
									}
									await targetAudit({ type: "rule_persistence", kind, rule, outcome: "persisted" });
								};
								let targetRunRuntimeForApproval: RunRuntimeSlot<PreparedRunRuntime> | undefined;
								const targetCreatePolicy = (
									profile: ReturnType<typeof compileSandboxPolicy>,
									approvalPolicy: ApprovalPolicy,
								): PermissionEngine =>
									createPermissionEngine({
										cwd: workspace.root,
										shellExecutable,
										workspace,
										profile,
										approvalPolicy,
										approval: targetAuditedApproval,
										genericApprovalForTool: (request) => {
											if (parsed.dangerouslyBypassApprovalsAndSandbox) return undefined;
											if (request.toolName === "skill" && typeof request.arguments.skill === "string") {
												const id = skillIdFromCommandId(request.arguments.skill);
												const resolved = id
													? targetRunRuntimeForApproval?.active?.value.skills.byId.get(id)
													: undefined;
												return {
													kind: "skill",
													reason: resolved
														? `Activate Skill ${resolved.candidate.metadata.name} (${resolved.candidate.id}, revision ${resolved.candidate.revision})`
														: `Activate unavailable Skill ${request.arguments.skill}`,
												};
											}
											const mcpTool = targetRunRuntimeForApproval?.active?.value.mcp.tools.find(
												(tool) => tool.name === request.toolName,
											);
											return mcpTool
												? {
														kind: "mcp",
														reason: `Call MCP Tool ${mcpTool.serverId}/${mcpTool.remoteName}`,
													}
												: undefined;
										},
										resolveExecutable: createExecutableIdentityResolver({
											fileSystem: options.fileSystem,
											path: options.runtime.environment.PATH,
											pathExtensions: options.runtime.environment.PATHEXT,
											platform: options.runtime.platform,
										}),
										onSessionApprovalUsed: targetAudit,
										onReadAccessDecision: targetAudit,
										commandRules: commandPolicy.rules,
										hostExecutables: commandPolicy.hostExecutables,
										networkRules,
										persistCommandRule: (rule) =>
											targetPersistRule("command", rule, () => ruleStore.appendCommandRule(rule)),
										persistNetworkRule: (rule) =>
											targetPersistRule("network", rule, () => ruleStore.appendNetworkRule(rule)),
										onWarning: async (message) => {
											await targetAudit({ type: "warning", message });
											await options.io.stderr.write(`coda: ${message}\n`);
										},
									});
								const targetPermission = targetCreatePolicy(targetProfile, targetApprovalPolicy);
								const targetInitialMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
								const targetRunRuntime = new RunRuntimeSlot<PreparedRunRuntime>({
									model: targetModel,
									reasoning: targetReasoning,
									authSnapshot: targetAuth,
									permission: targetPermission,
									skills: skillsManager.current ?? skillsSnapshot,
									mcp: targetInitialMcp,
									tools: Object.freeze([]),
								});
								targetRunRuntimeForApproval = targetRunRuntime;
								sessionRunRuntimes.set(targetSession.descriptor.id, {
									runtime: targetRunRuntime,
									apiKey: undefined,
								});
								const targetPolicy = new RunPermissionRouter(targetRunRuntime, ({ permission }) => permission);
								const startupPermissionAudit = permissionConfigurationAuditEvent(
									"startup",
									targetProfile,
									targetApprovalPolicy,
								);
								if (fresh && targetSession instanceof DraftSession) {
									targetSession.stageInitialChanges([
										{ type: "permission_audit_recorded", event: startupPermissionAudit },
										{ type: "permission_selected", profile: targetProfile.profile },
									]);
								} else {
									await targetAudit(startupPermissionAudit);
									if (!targetSession.restored.permissionProfile) {
										await targetSession.record({
											type: "permission_selected",
											profile: targetProfile.profile,
										});
									}
								}
								const targetBaseTools = createCodingTools({
									workspace,
									fileSystem: options.fileSystem,
									processRunner: modelProcessRunner,
									permissions: targetPolicy,
									shellExecutable,
									runtime: options.runtime,
									settings,
									sessionHistory: targetSession.history,
									onAudit: targetAudit,
								});
								const targetToolsForRun = (
									snapshot: CodingSkillsSnapshot,
									mcp: McpToolSnapshot,
								): readonly AgentTool[] => {
									const skillTool = createSkillTool(snapshot);
									const mcpTools = createMcpAgentTools({
										snapshot: mcp,
										elicit: async (request) => {
											if (!targetMcpElicitation) return { action: "decline" };
											if (parsed.dangerouslyBypassApprovalsAndSandbox) {
												return targetMcpElicitation(request);
											}
											const decision = await targetPolicy.requestGenericApproval({
												kind: "mcp",
												runId: request.execution.runId,
												turnId: request.execution.turnId,
												invocationId: request.execution.invocationId,
												toolName: request.tool.name,
												reason: `Allow ${request.server.server?.name ?? request.server.id} to request ${request.request.mode} Elicitation for ${request.tool.remoteName}`,
											});
											return decision.decision === "allow"
												? targetMcpElicitation(request)
												: { action: "decline" };
										},
									});
									return Object.freeze([...targetBaseTools, ...(skillTool ? [skillTool] : []), ...mcpTools]);
								};
								targetRunRuntime.select({
									...targetRunRuntime.selected,
									tools: targetToolsForRun(targetRunRuntime.selected.skills, targetInitialMcp),
								});
								const targetRunSkills = new RunSkillsCoordinator();
								const targetFreezePrompt = (runtime: PreparedRunRuntime) =>
									buildSystemPrompt({
										workspace: workspace.root,
										platform: options.runtime.platform,
										timestamp: options.runtime.clock.now(),
										tools: runtime.tools.map((tool) => ({ name: tool.name, description: tool.description })),
										capabilities: {
											interactionMode: "interactive",
											permissionProfile: runtime.permission.configuration().profile.profile,
											approvalPolicy: approvalPolicyLabel(runtime.permission.configuration().approvalPolicy),
											readAccess: promptReadAccess(runtime.permission.configuration().profile),
										},
										projectInstructions,
										skills: promptSkillCatalog(runtime.skills, runtime.model.contextWindow),
									});
								let targetPromptSnapshot = targetFreezePrompt(targetRunRuntime.selected);
								let targetActiveRuntimeId: number | undefined;
								const targetContextWindow = new ContextWindowController({
									models: options.models,
									clock: options.runtime.clock,
									idGenerator: options.runtime.idGenerator,
									runtime: () => {
										const runtime = targetRunRuntime.active?.value ?? targetRunRuntime.selected;
										return { model: runtime.model, authSnapshot: runtime.authSnapshot };
									},
									commit: (checkpoint) => targetSession.record({ type: "context_compacted", checkpoint }),
									checkpoint: targetSession.compactionCheckpoint,
								});
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
								const targetAgent = new Agent({
									clock: options.runtime.clock,
									idGenerator: options.runtime.idGenerator,
									runBudget: DEFAULT_CODING_AGENT_RUN_BUDGET,
									tools: () => {
										const runtime = targetRunRuntime.active?.value;
										if (!runtime) throw new Error("Tools were requested outside an active Run runtime");
										return runtime.tools;
									},
									policyGate: targetPolicy,
									retry: options.runtime.scheduler
										? createCodingAgentRetry(options.runtime.scheduler)
										: undefined,
									recoverFailedAttempt: async ({ message }) => {
										if (!isRecoverableContextOverflow(message.message)) return { retry: false };
										if (!targetContextWindow.canCompact(targetAgent.state.messages)) return { retry: false };
										await targetContextWindow.compact({
											messages: targetAgent.state.messages,
											reason: "overflow",
										});
										return { retry: true, reason: "context overflow compacted" };
									},
									stream: async ({ context, signal }) => {
										const runtime = targetRunRuntime.active?.value;
										if (!runtime)
											throw new Error("A Model stream was requested outside an active Run runtime");
										if (!runtime.authSnapshot) {
											throw new Error(
												`Model is not authenticated: ${runtime.model.provider}/${runtime.model.id}`,
											);
										}
										const preparedContext = await targetContextWindow.prepare(
											context,
											targetAgent.state.messages,
											signal,
										);
										const contextBudget = assertModelContextFits(runtime.model, preparedContext);
										return options.models.streamSimple(runtime.model, preparedContext, {
											signal,
											authSnapshot: runtime.authSnapshot,
											reasoning: runtime.reasoning === "off" ? undefined : runtime.reasoning,
											maxTokens: contextBudget.reservedOutputTokens,
										});
									},
									beforeRun: async ({ inputMessage }) => {
										const nextSkills =
											targetRunSkills.consume(inputMessage.message.content) ??
											(await skillsManager.refresh());
										if (mcpRegistry) await mcpRegistry.refresh();
										const nextMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
										skillRegistryBinding!.sync(nextSkills);
										targetRunRuntime.select({
											...targetRunRuntime.selected,
											skills: nextSkills,
											mcp: nextMcp,
											tools: targetToolsForRun(nextSkills, nextMcp),
										});
										const runtime = targetRunRuntime.begin();
										targetActiveRuntimeId = runtime.id;
										try {
											targetPromptSnapshot = targetFreezePrompt(runtime.value);
											await targetSession.record({
												type: "prepare_run",
												promptVersion: targetPromptSnapshot.version,
												promptSha256: targetPromptSnapshot.sha256,
											});
										} catch (error) {
											targetRunRuntime.end(runtime.id);
											targetActiveRuntimeId = undefined;
											throw error;
										}
									},
									systemPrompt: () => targetPromptSnapshot.text,
									seed: targetSession.seed,
									autoDrainFollowUps: false,
								});
								targetSession.attach(targetAgent);
								const targetRestoredMedia = await restoredChatAttachments(
									targetSession.mediaReferences,
									targetSession.descriptor.path,
									options.fileSystem,
									new Set(targetSession.recoverableFollowUps.map(({ item }) => item.id)),
								);
								const targetPrepareAttachments = (attachmentIds: readonly string[]) =>
									prepareAttachmentTransaction(
										attachmentIds.filter((id) => !targetRestoredMedia.contents.has(id)),
										targetMediaLibrary,
										targetSession,
									);
								targetAgent.onEvent((event) => {
									if (
										(event.type === "tool_execution_rejected" || event.type === "tool_execution_end") &&
										targetPolicy.consumeAbort(event.invocation.id)
									) {
										targetAgent.abort();
									}
									if (event.type === "run_end") {
										void targetContextWindow.flushManual(targetAgent.state.messages).catch(() => undefined);
										if (targetActiveRuntimeId !== undefined) {
											targetRunRuntime.end(targetActiveRuntimeId);
											targetActiveRuntimeId = undefined;
										}
									}
								});
								secondaryResources.set(targetSession.descriptor.id, {
									session: targetSession,
									mediaLibrary: targetMediaLibrary,
								});
								return {
									agent: targetAgent,
									session: targetSession,
									approvalFor: (invocationId) => targetPolicy.approvalFor(invocationId),
									modelLabel: `${targetModel.provider}/${targetModel.id}`,
									activitySummaryMode: activitySummaryModeForApi(targetModel.api),
									permissionProfile: targetProfile.profile,
									permissionLabel: `${permissionProfileLabel(targetProfile.profile)} / ${approvalPolicyLabel(targetApprovalPolicy)}`,
									statusLine: () =>
										interactiveStatusLineSnapshot(
											targetRunRuntime.active?.value ?? targetRunRuntime.selected,
											targetAgent,
											targetSession,
											targetContextWindow,
											targetPromptSnapshot.text,
										),
									onPermissionProfileChange: async (profile) => {
										const nextProfile = compileSandboxPolicy({
											profile,
											workspaceRoots: [workspace.root],
											temporaryDirectory,
											additionalWritableRoots,
											deniedReadRoots,
										});
										const nextApprovalPolicy = defaultApprovalPolicy(profile);
										const nextPermission = targetCreatePolicy(nextProfile, nextApprovalPolicy);
										await targetAudit(
											permissionConfigurationAuditEvent(
												"permissions-command",
												nextProfile,
												nextApprovalPolicy,
											),
										);
										await targetSession.record({ type: "permission_selected", profile });
										targetRunRuntime.select({ ...targetRunRuntime.selected, permission: nextPermission });
										return `${permissionProfileLabel(profile)} / ${approvalPolicyLabel(nextApprovalPolicy)}`;
									},
									modelCommand: {
										currentKey: () =>
											`${targetRunRuntime.selected.model.provider}/${targetRunRuntime.selected.model.id}`,
										list: listModelEntries,
										select: async (selected) => {
											const authSnapshot = await options.models.getAuth(selected.runtime, {
												clock: options.runtime.clock,
											});
											if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
											const nextReasoning = effectiveReasoningEffort(
												selected.runtime,
												targetRunRuntime.selected.reasoning,
											);
											await targetSession.record({
												type: "model_selected",
												model: { provider: selected.providerId, id: selected.id },
												reasoning: nextReasoning,
											});
											targetRunRuntime.select({
												...targetRunRuntime.selected,
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
									},
									effortCommand: createEffortCommand(targetSession, targetRunRuntime),
									authCommand,
									skillsCommand,
									mcpCommand,
									compactCommand: {
										run: async (focus) => {
											await targetContextWindow.requestManual(targetAgent.state.messages, {
												focus,
												defer: targetAgent.state.status === "running",
											});
											return "Context compacted";
										},
									},
									reasoning: targetReasoning,
									restoredAttachments: targetRestoredMedia.attachments,
									resolveExtensionReferences: async (references) => {
										const snapshot = await skillsManager.refresh();
										assertSkillReferencesAvailable(snapshot, references);
									},
									buildPrompt: async (text, attachmentIds, inputContext) => {
										const selectedModel = targetRunRuntime.selected.model;
										if (attachmentIds.length > 0 && !selectedModel.input.includes("image")) {
											throw new Error(
												`Model does not support image input: ${selectedModel.provider}/${selectedModel.id}`,
											);
										}
										const skillReferences = inputContext.references.filter(
											({ source }) => source === "skill",
										);
										if (skillReferences.length === 0) {
											return promptInput(
												text,
												attachmentIds,
												targetMediaLibrary,
												targetRestoredMedia.contents,
											);
										}
										const snapshot =
											inputContext.kind === "steering"
												? (targetRunRuntime.active?.value.skills ?? targetRunRuntime.selected.skills)
												: (skillsManager.current ?? targetRunRuntime.selected.skills);
										assertSkillReferencesAvailable(snapshot, inputContext.references);
										const taskText = sharedSkillArguments(inputContext.composerText, skillReferences) ?? "";
										const input = await promptInput(
											taskText,
											attachmentIds,
											targetMediaLibrary,
											targetRestoredMedia.contents,
										);
										const activations = await activateExplicitSkillReferences({
											snapshot,
											references: skillReferences,
											composerText: inputContext.composerText,
										});
										const snapshotBinding =
											inputContext.kind === "steering" ? undefined : targetRunSkills.createBinding();
										const prepared = prependSkillContext(
											input,
											renderExplicitSkillContext(activations, snapshotBinding),
											renderExplicitSkillReferences(activations),
										);
										if (snapshotBinding) targetRunSkills.prepare(prepared, snapshot, snapshotBinding);
										return prepared;
									},
									prepareAttachments: targetPrepareAttachments,
									onDetach: (attachmentId) =>
										targetRestoredMedia.contents.has(attachmentId)
											? Promise.resolve()
											: targetMediaLibrary.detach(attachmentId),
									onOpenAttachment: (attachmentId) => {
										const restoredPath = targetRestoredMedia.paths.get(attachmentId);
										return restoredPath
											? openPathInSystemViewer(
													restoredPath,
													options.processRunner,
													options.runtime,
													workspace.root,
												)
											: openAttachmentInSystemViewer(
													targetMediaLibrary,
													attachmentId,
													options.processRunner,
													options.runtime,
													workspace.root,
												);
									},
									toolResultImagesSupported: resolveModelRuntimeCapabilities(
										targetModel,
										options.modelCapabilities,
									).toolResultImages,
								};
							} catch (error) {
								sessionRunRuntimes.delete(targetSession.descriptor.id);
								await targetMediaLibrary.dispose().catch(() => undefined);
								await targetSession.close().catch(() => undefined);
								throw error;
							}
						};
						let exitCode: number;
						try {
							exitCode = await runInteractive({
								agent,
								session,
								terminal: interactiveRuntime!.terminal,
								clock: options.runtime.clock,
								scheduler: interactiveRuntime!.scheduler,
								imageSurface,
								keybindings: options.keybindings ?? [],
								diagnostics: options.diagnostics,
								fullScreenOutput: options.fullScreenOutput,
								approval: interactiveApproval,
								mcpElicitation: interactiveMcpElicitation,
								approvalFor: (invocationId) => policy.approvalFor(invocationId),
								modelLabel: `${model.provider}/${model.id}`,
								activitySummaryMode: activitySummaryModeForApi(model.api),
								permissionProfile: policy.configuration().profile.profile,
								permissionLabel: `${permissionProfileLabel(policy.configuration().profile.profile)} / ${approvalPolicyLabel(policy.configuration().approvalPolicy)}`,
								statusLine: () =>
									interactiveStatusLineSnapshot(
										runRuntime.active?.value ?? runRuntime.selected,
										agent,
										session,
										contextWindow,
										promptSnapshot.text,
									),
								onPermissionProfileChange: async (profile) => {
									const nextProfile = compileSandboxPolicy({
										profile,
										workspaceRoots: [workspace.root],
										temporaryDirectory,
										additionalWritableRoots,
										deniedReadRoots,
									});
									const nextApprovalPolicy = defaultApprovalPolicy(profile);
									const nextPermission = createPolicy(nextProfile, nextApprovalPolicy);
									await audit(
										permissionConfigurationAuditEvent("permissions-command", nextProfile, nextApprovalPolicy),
									);
									await session.record({ type: "permission_selected", profile });
									runRuntime.select({ ...runRuntime.selected, permission: nextPermission });
									return `${permissionProfileLabel(profile)} / ${approvalPolicyLabel(nextApprovalPolicy)}`;
								},
								modelCommand: {
									currentKey: () => `${runRuntime.selected.model.provider}/${runRuntime.selected.model.id}`,
									list: listModelEntries,
									select: async (selected) => {
										const authSnapshot = await options.models.getAuth(selected.runtime, {
											apiKey: selected.providerId === model.provider ? parsed.apiKey : undefined,
											clock: options.runtime.clock,
										});
										if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
										const nextReasoning = effectiveReasoningEffort(
											selected.runtime,
											runRuntime.selected.reasoning,
										);
										await session.record({
											type: "model_selected",
											model: { provider: selected.providerId, id: selected.id },
											reasoning: nextReasoning,
										});
										runRuntime.select({
											...runRuntime.selected,
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
								},
								effortCommand: createEffortCommand(session, runRuntime),
								authCommand,
								skillsCommand,
								mcpCommand,
								compactCommand: {
									run: async (focus) => {
										await contextWindow.requestManual(agent.state.messages, {
											focus,
											defer: agent.state.status === "running",
										});
										return "Context compacted";
									},
								},
								reasoning,
								motion: parsed.noAnimations ? "reduced" : (settings.ui?.motion ?? "full"),
								commandRegistry,
								sessionCommand: {
									list: async () =>
										(await sessions.list({ id: workspaceId, path: workspace.root })).map((descriptor) => ({
											id: descriptor.id,
											label: descriptor.id,
											description: new Date(descriptor.createdAt).toISOString(),
										})),
									open: async (sessionId) => {
										const targetSession = await sessions.open({
											workspace: { id: workspaceId, path: workspace.root },
											mode: "interactive",
											resumeId: sessionId,
											persistent: session.descriptor.persistent,
										});
										return createSecondarySessionOptions(targetSession, false);
									},
									create: async () => {
										const draftId = `session-${pathSafeIdentity(
											options.runtime.idGenerator.generate("queue_item"),
										)}` as SessionId;
										const targetSession = new DraftSession({
											descriptor: {
												id: draftId,
												workspace: { id: workspaceId, path: workspace.root },
												createdAt: options.runtime.clock.now(),
												persistent: session.descriptor.persistent,
											},
											materialize: () =>
												sessions.open({
													workspace: { id: workspaceId, path: workspace.root },
													mode: "interactive",
													persistent: session.descriptor.persistent,
													createId: draftId,
												}),
										});
										return createSecondarySessionOptions(targetSession, true);
									},
								},
								lifecycle: options.runtime.interactiveLifecycle,
								allocateId: () => options.runtime.idGenerator.generate("queue_item"),
								processRunner: options.processRunner,
								platform: options.runtime.platform,
								environment: options.runtime.environment,
								workspace: workspace.root,
								homePath: options.runtime.homeDirectory,
								onWarning: (message) => options.io.stderr.write(`coda: ${message}\n`),
								toolResultImagesSupported: resolveModelRuntimeCapabilities(model, options.modelCapabilities)
									.toolResultImages,
								initialPrompt: hasAgentInput(initialInput) ? initialInput : undefined,
								initialAttachmentIds,
								initialAttachments,
								restoredAttachments: restoredMedia.attachments,
								resolveExtensionReferences: async (references) => {
									const snapshot = await skillsManager.refresh();
									assertSkillReferencesAvailable(snapshot, references);
								},
								buildPrompt: async (text, attachmentIds, inputContext) => {
									const selectedModel = runRuntime.selected.model;
									if (attachmentIds.length > 0 && !selectedModel.input.includes("image")) {
										throw new Error(
											`Model does not support image input: ${selectedModel.provider}/${selectedModel.id}`,
										);
									}
									const skillReferences = inputContext.references.filter(({ source }) => source === "skill");
									if (skillReferences.length === 0) {
										return promptInput(text, attachmentIds, mediaLibrary, restoredMedia.contents);
									}
									const snapshot =
										inputContext.kind === "steering"
											? (runRuntime.active?.value.skills ?? runRuntime.selected.skills)
											: (skillsManager.current ?? runRuntime.selected.skills);
									assertSkillReferencesAvailable(snapshot, inputContext.references);
									const taskText = sharedSkillArguments(inputContext.composerText, skillReferences) ?? "";
									const input = await promptInput(
										taskText,
										attachmentIds,
										mediaLibrary,
										restoredMedia.contents,
									);
									const activations = await activateExplicitSkillReferences({
										snapshot,
										references: skillReferences,
										composerText: inputContext.composerText,
									});
									const snapshotBinding =
										inputContext.kind === "steering" ? undefined : runSkills.createBinding();
									const prepared = prependSkillContext(
										input,
										renderExplicitSkillContext(activations, snapshotBinding),
										renderExplicitSkillReferences(activations),
									);
									if (snapshotBinding) runSkills.prepare(prepared, snapshot, snapshotBinding);
									return prepared;
								},
								prepareAttachments,
								onDetach: (attachmentId) =>
									restoredMedia.contents.has(attachmentId)
										? Promise.resolve()
										: mediaLibrary.detach(attachmentId),
								onOpenAttachment: (attachmentId) => {
									const restoredPath = restoredMedia.paths.get(attachmentId);
									return restoredPath
										? openPathInSystemViewer(
												restoredPath,
												options.processRunner,
												options.runtime,
												workspace.root,
											)
										: openAttachmentInSystemViewer(
												mediaLibrary,
												attachmentId,
												options.processRunner,
												options.runtime,
												workspace.root,
											);
								},
							});
						} finally {
							await Promise.all(
								[...secondaryResources.values()].map(async (resource) => {
									const failures: unknown[] = [];
									try {
										await resource.mediaLibrary.dispose();
									} catch (error) {
										failures.push(error);
									}
									try {
										await resource.session.close();
									} catch (error) {
										failures.push(error);
									}
									if (failures.length === 1) throw failures[0];
									if (failures.length > 1) {
										throw new AggregateError(failures, "Could not close an interactive Session runtime");
									}
								}),
							);
						}
						const interactiveMessages = agent.state.messages.slice(initialMessageCount);
						const finalAssistant = [...interactiveMessages]
							.reverse()
							.find(
								({ message }) => message.role === "assistant" && finalText(message).trim().length > 0,
							)?.message;
						if (finalAssistant?.role === "assistant") {
							await options.io.stdout.write(`${finalText(finalAssistant)}\n`);
						}
						if (session.descriptor.persistent) {
							await options.io.stdout.write(
								`Session ${session.descriptor.id} • resume with: coda --resume ${session.descriptor.id}\n`,
							);
						}
						if (agent.state.lastRun && agent.state.lastRun.outcome !== "success") {
							await options.io.stderr.write(
								`coda: ${agent.state.lastRun.failure?.message ?? `Run ended with outcome ${agent.state.lastRun.outcome}`}\n`,
							);
						}
						return exitCode;
					}
					if (parsed.output === "json") {
						agent.onEvent((event) => {
							const envelope =
								event.type === "run_start"
									? {
											schemaVersion: 2,
											...event,
											model: { provider: model.provider, id: model.id },
											reasoning,
											prompt: { version: promptSnapshot.version, sha256: promptSnapshot.sha256 },
											permissions: {
												profile: policy.configuration().profile.profile,
												approvalPolicy: approvalPolicyLabel(policy.configuration().approvalPolicy),
											},
										}
									: { schemaVersion: 2, ...event };
							return options.io.stdout.write(
								`${JSON.stringify(projectJsonMedia(envelope, mediaLibrary, parsed.includeMediaData))}\n`,
							);
						});
					}
					const initialMedia = await prepareAttachments(initialAttachmentIds);
					let initialMediaCommitted = false;
					const detachInitialMediaCommit = agent.onEvent(async (event) => {
						if (event.type !== "run_start" || event.source !== "prompt" || initialMediaCommitted) return;
						await initialMedia.commit();
						initialMediaCommitted = true;
					});
					let result: Awaited<ReturnType<Agent["prompt"]>>;
					try {
						result = await agent.prompt(initialInput);
					} finally {
						detachInitialMediaCommit();
						if (!initialMediaCommitted) await initialMedia.rollback();
					}
					if (result.outcome !== "success" || !result.finalMessageId) {
						const detail = result.failure?.message ?? `Run ended with outcome ${result.outcome}`;
						await options.io.stderr.write(`coda: ${detail}\n`);
						return 1;
					}
					const committed = agent.state.messages.find(({ id }) => id === result.finalMessageId)?.message;
					if (!committed || committed.role !== "assistant") throw new Error("Final Assistant Message is missing");
					if (parsed.output === "text") await options.io.stdout.write(`${finalText(committed)}\n`);
					if (rejectingApproval && rejectingApproval.requests.length > 0) return 1;
					return 0;
				} finally {
					skillWatcher?.dispose();
					skillRegistryBinding?.dispose();
					try {
						await mcpRegistry?.close();
					} finally {
						try {
							await mediaLibrary.dispose();
						} finally {
							await session.close();
						}
					}
				}
			} catch (error) {
				if (error instanceof InteractiveTerminationError) return error.exitCode;
				const message = error instanceof Error ? error.message : String(error);
				await options.io.stderr.write(`coda: ${message}\n`);
				return 1;
			}
		},
	};
}

const unavailableProviderDiscoveryFetch: typeof globalThis.fetch = async () => {
	throw new Error("Custom Provider discovery requires an injected fetch adapter");
};

async function promptInput(
	text: string,
	attachmentIds: readonly string[],
	mediaLibrary: MediaLibrary,
	restoredContents: ReadonlyMap<string, ImageContent> = new Map(),
): Promise<AgentInput> {
	if (attachmentIds.length === 0) return text;
	const content: Exclude<AgentInput, string> = [];
	if (text.length > 0) content.push(Object.freeze({ type: "text", text }));
	for (const attachmentId of attachmentIds) {
		content.push(restoredContents.get(attachmentId) ?? (await mediaLibrary.modelContent(attachmentId)));
	}
	return content;
}

async function chatAttachment(mediaLibrary: MediaLibrary, attachmentId: string): Promise<ChatAttachment> {
	const asset = mediaLibrary.resolve(attachmentId);
	return Object.freeze({
		id: attachmentId,
		filename: asset.filename,
		mimeType: asset.mimeType,
		width: asset.width,
		height: asset.height,
		bytes: asset.bytes,
		preview: Object.freeze({
			png: await mediaLibrary.previewPng(attachmentId),
			generation: asset.digest,
			width: asset.preview.width,
			height: asset.preview.height,
		}),
	});
}

function sessionMediaRegistration(asset: MediaAsset): SessionMediaRegistration {
	return {
		reference: {
			type: "media",
			digest: asset.digest,
			filename: asset.filename,
			mimeType: asset.mimeType,
			width: asset.width,
			height: asset.height,
			bytes: asset.bytes,
			rendition: {
				digest: asset.modelDigest,
				mimeType: asset.model.mimeType,
				width: asset.model.width,
				height: asset.model.height,
				bytes: asset.model.bytes,
			},
		},
		modelPath: asset.model.path,
	};
}

async function prepareAttachmentTransaction(
	attachmentIds: readonly string[],
	mediaLibrary: MediaLibrary,
	session: Session,
): Promise<AttachmentTransaction> {
	if (attachmentIds.length === 0) {
		return {
			commit: async () => undefined,
			rollback: async () => undefined,
		};
	}
	try {
		if (session.descriptor.persistent) {
			session.registerMedia(attachmentIds.map((id) => sessionMediaRegistration(mediaLibrary.resolve(id))));
		}
	} catch (error) {
		for (const attachmentId of attachmentIds) await mediaLibrary.detach(attachmentId);
		throw error;
	}
	let settled = false;
	return {
		commit: async () => {
			if (settled) return;
			settled = true;
			try {
				await mediaLibrary.commit(attachmentIds);
			} finally {
				for (const attachmentId of attachmentIds) await mediaLibrary.detach(attachmentId);
			}
		},
		rollback: async () => {
			if (settled) return;
			settled = true;
			for (const attachmentId of attachmentIds) await mediaLibrary.detach(attachmentId);
		},
	};
}

interface RestoredChatMedia {
	readonly attachments: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly contents: ReadonlyMap<string, ImageContent>;
	readonly paths: ReadonlyMap<string, string>;
}

async function restoredChatAttachments(
	references: ReadonlyMap<string, readonly SessionMediaReference[]>,
	sessionPath: string | undefined,
	fileSystem: FileSystem,
	editableOwners: ReadonlySet<string>,
): Promise<RestoredChatMedia> {
	const result = new Map<string, readonly ChatAttachment[]>();
	const contents = new Map<string, ImageContent>();
	const paths = new Map<string, string>();
	for (const [messageId, messageReferences] of references) {
		const attachments: ChatAttachment[] = [];
		for (const [index, reference] of messageReferences.entries()) {
			let preview: ChatAttachment["preview"];
			if (sessionPath) {
				const previewPath = join(`${sessionPath}.media`, `${reference.digest}.preview.png`);
				try {
					preview = {
						png: await fileSystem.readFile(previewPath),
						generation: reference.digest,
						width: reference.width,
						height: reference.height,
					};
				} catch (error) {
					if (!isFileSystemError(error, "ENOENT")) throw error;
				}
			}
			const id = `restored:${messageId}:${index}:${reference.digest}`;
			if (sessionPath && editableOwners.has(messageId)) {
				const modelPath = sessionModelPath(sessionPath, reference);
				const modelBytes = await fileSystem.readFile(modelPath);
				contents.set(id, {
					type: "image",
					data: Buffer.from(modelBytes).toString("base64"),
					mimeType: reference.rendition.mimeType,
				});
				paths.set(id, modelPath);
			}
			attachments.push({
				id,
				filename: reference.filename,
				mimeType: reference.mimeType,
				width: reference.width,
				height: reference.height,
				bytes: reference.bytes,
				preview,
			});
		}
		result.set(messageId, attachments);
	}
	return { attachments: result, contents, paths };
}

function sessionModelPath(sessionPath: string, reference: SessionMediaReference): string {
	const extension = sessionMediaExtension(reference.rendition.mimeType);
	return join(`${sessionPath}.media`, `${reference.digest}.model.${extension}`);
}

async function openAttachmentInSystemViewer(
	mediaLibrary: MediaLibrary,
	attachmentId: string,
	processRunner: ProcessRunner,
	runtime: ApplicationRuntime,
	cwd: string,
): Promise<void> {
	const path = mediaLibrary.resolve(attachmentId).original.path;
	return openPathInSystemViewer(path, processRunner, runtime, cwd);
}

async function openPathInSystemViewer(
	path: string,
	processRunner: ProcessRunner,
	runtime: ApplicationRuntime,
	cwd: string,
): Promise<void> {
	const command =
		runtime.platform === "darwin"
			? { executable: "/usr/bin/open", args: [path] }
			: runtime.platform === "linux"
				? { executable: "/usr/bin/xdg-open", args: [path] }
				: undefined;
	if (!command) throw new Error(`System image viewer is unsupported on ${runtime.platform}`);
	const environment = Object.fromEntries(
		Object.entries(runtime.environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const result = await processRunner.run({
		...command,
		cwd,
		environment,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
		maxOutputBytes: 64 * 1024,
		maxOutputLines: 100,
		overflowPath: join(runtime.homeDirectory, ".coda", "tmp", `media-open-${pathSafeIdentity(path)}.log`),
	});
	if (result.exitCode !== 0 || result.signal || result.timedOut) {
		throw new Error(result.stderr.trim() || "System image viewer could not be opened");
	}
}

function projectJsonMedia(value: unknown, mediaLibrary: MediaLibrary, includeData: boolean): unknown {
	if (Array.isArray(value)) return value.map((entry) => projectJsonMedia(entry, mediaLibrary, includeData));
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
		const bytes = Buffer.from(record.data, "base64");
		const modelDigest = createHash("sha256").update(bytes).digest("hex");
		const asset = mediaLibrary.describeImageContent({
			type: "image",
			data: record.data,
			mimeType: record.mimeType,
		});
		const fallbackExtension = record.mimeType === "image/jpeg" ? "jpg" : "png";
		return {
			type: "media",
			digest: asset?.digest ?? modelDigest,
			filename: asset?.filename ?? `image-${modelDigest.slice(0, 12)}.${fallbackExtension}`,
			mimeType: asset?.mimeType ?? record.mimeType,
			bytes: asset?.bytes ?? bytes.byteLength,
			...(asset ? { width: asset.width, height: asset.height } : {}),
			rendition: {
				digest: asset?.modelDigest ?? modelDigest,
				mimeType: record.mimeType,
				bytes: bytes.byteLength,
				...(asset ? { width: asset.model.width, height: asset.model.height } : {}),
			},
			...(includeData ? { data: record.data } : {}),
		};
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, entry]) => [key, projectJsonMedia(entry, mediaLibrary, includeData)]),
	);
}

function hasAgentInput(input: AgentInput): boolean {
	return typeof input === "string" ? input.trim().length > 0 : input.length > 0;
}

function pathSafeIdentity(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
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
