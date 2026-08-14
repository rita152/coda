import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentInput, Clock, IdGenerator, Immutable, RunBudget } from "@coda/agent";
import type {
	Api,
	AssistantMessage,
	AuthPrompt,
	ImageContent,
	Model,
	Models,
	MutableModels,
	ThinkingLevel,
} from "@coda/ai";
import { createMcpHost, type McpConnector, type McpElicitationResult, type McpToolSnapshot } from "@coda/mcp";
import type { CodingSkillsSnapshot, McpAgentElicitation } from "@coda/runtime";
import { type CodingAgentRuntime, CodingMcpRegistry, type ModelSelection, openCodingAgentRuntime } from "@coda/runtime";
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
import {
	CodingCompletionController,
	type CompletionWorkspaceEvidenceProvider,
	createGitWorkspaceEvidenceProvider,
} from "./completion/index.ts";
import { type JsonEventStreamMode, JsonEventWriter } from "./event-output/json-event-writer.ts";
import type { ApplicationIO } from "./host/application-io.ts";
import { type FileSystem, isFileSystemError } from "./host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { activitySummaryModeForApi } from "./interactive/activity-status.ts";
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
	type WorkspaceMcpConfigurationSnapshot,
	type WorkspaceMcpTrustRecord,
} from "./mcp/config.ts";
import { type MediaAsset, MediaLibrary } from "./media/media-library.ts";
import { type ModelCapabilityResolver, resolveModelRuntimeCapabilities } from "./model-capabilities.ts";
import { ProcessSessionManager } from "./process/process-session-manager.ts";
import { loadProjectInstructions } from "./project/project-context.ts";
import { ProviderManager } from "./providers/provider-manager.ts";
import { availableReasoningEfforts, effectiveReasoningEffort, REASONING_EFFORTS } from "./reasoning-effort.ts";
import { type AgentRunControlBinding, bindAgentRunControl, type RunControlConfiguration } from "./run-control/index.ts";
import { withRunControlEvidence } from "./run-evidence/run-evidence.ts";
import { collectWorkspaceDiff } from "./run-evidence/workspace-diff.ts";
import { catalogModelFromRuntime } from "./runtime/model-catalog.ts";
import { createWorkspaceRuntimeServices } from "./runtime/workspace-runtime-services.ts";
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
import type { SettingsStore } from "./settings/types.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "./skills/context.ts";
import { CodingSkillsManager, SkillCommandRegistryBinding, skillIdFromCommandId } from "./skills/manager.ts";
import { collectSkillRoots } from "./skills/roots.ts";
import type { SkillWatcher, SkillWatcherFactory } from "./skills/watcher.ts";
import { createWorkspace } from "./workspace.ts";

export type { ModelSelection } from "@coda/runtime";
export type { ApplicationInput, ApplicationIO, ApplicationOutput } from "./host/application-io.ts";
export type { ProjectTrustRecord, SettingsStore, UserSettings } from "./settings/types.ts";

const DEFAULT_CODING_AGENT_RUN_BUDGET: RunBudget = Object.freeze({
	limits: Object.freeze({
		maxTurns: 64,
		maxToolInvocations: 256,
		maxElapsedMs: 60 * 60 * 1_000,
		maxConsecutiveEquivalentToolBatches: 4,
	}),
});

const unavailableProcessSessionRunner: ProcessSessionRunner = Object.freeze({
	start: async () => {
		throw new Error("Process sessions require a configured ProcessSessionRunner");
	},
});

function codingAgentRunBudget(maxTurns: number | undefined, disabled: boolean): RunBudget | undefined {
	if (disabled) return undefined;
	if (maxTurns === undefined) return DEFAULT_CODING_AGENT_RUN_BUDGET;
	return Object.freeze({
		limits: Object.freeze({ ...DEFAULT_CODING_AGENT_RUN_BUDGET.limits, maxTurns }),
	});
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
	readonly processSessionRunner?: ProcessSessionRunner;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly mcpConnector?: McpConnector;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	/** Private deterministic seam for completion-gate integration tests. */
	readonly completionWorkspaceEvidence?: CompletionWorkspaceEvidenceProvider;
}

export interface CodingAgentApplication {
	run(args: readonly string[]): Promise<number>;
}

interface ParsedArguments {
	readonly action: "cleanup" | "help" | "run" | "sessions" | "skills-validate" | "version";
	readonly mode: "interactive" | "print";
	readonly output: "json" | "text";
	readonly jsonEventStream: JsonEventStreamMode;
	readonly reasoning?: ThinkingLevel | "off";
	readonly maxOutputTokens?: number;
	readonly maxTurns?: number;
	readonly disableRunBudget: boolean;
	readonly runControlWorkMs?: number;
	readonly runControlGraceMs?: number;
	readonly runControlStationaryTurns?: number;
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
	let jsonEventStream: JsonEventStreamMode = "raw";
	let jsonEventStreamExplicit = false;
	let reasoning: ThinkingLevel | "off" | undefined;
	let maxOutputTokens: number | undefined;
	let maxTurns: number | undefined;
	let disableRunBudget = false;
	let runControlWorkMs: number | undefined;
	let runControlGraceMs: number | undefined;
	let runControlStationaryTurns: number | undefined;
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
		if (argument === "--json-mode") {
			const value = args[++index];
			if (value !== "raw" && value !== "semantic") {
				throw new Error("--json-mode requires raw or semantic");
			}
			jsonEventStream = value;
			jsonEventStreamExplicit = true;
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
		if (argument === "--reasoning") {
			const value = args[++index];
			if (!value || !REASONING_EFFORTS.includes(value as ThinkingLevel | "off")) {
				throw new Error("--reasoning requires off, minimal, low, medium, high, xhigh, or max");
			}
			reasoning = value as ThinkingLevel | "off";
			continue;
		}
		if (argument === "--max-output-tokens") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--max-output-tokens requires a positive integer");
			}
			maxOutputTokens = value;
			continue;
		}
		if (argument === "--max-turns") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--max-turns requires a positive integer");
			}
			maxTurns = value;
			continue;
		}
		if (argument === "--no-run-budget") {
			disableRunBudget = true;
			continue;
		}
		if (argument === "--run-control-work-ms") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-work-ms requires a positive integer");
			}
			runControlWorkMs = value;
			continue;
		}
		if (argument === "--run-control-grace-ms") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-grace-ms requires a positive integer");
			}
			runControlGraceMs = value;
			continue;
		}
		if (argument === "--run-control-stationary-turns") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-stationary-turns requires a positive integer");
			}
			runControlStationaryTurns = value;
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
	if (jsonEventStreamExplicit && output !== "json") throw new Error("--json-mode requires --json");
	if (includeMediaData && output !== "json") throw new Error("--include-media-data requires --json");
	if (disableRunBudget && maxTurns !== undefined) {
		throw new Error("--no-run-budget and --max-turns cannot be combined");
	}
	if ((runControlWorkMs === undefined) !== (runControlGraceMs === undefined)) {
		throw new Error("--run-control-work-ms and --run-control-grace-ms must be configured together");
	}
	if (runControlStationaryTurns !== undefined && runControlWorkMs === undefined) {
		throw new Error("--run-control-stationary-turns requires RunControl work and grace deadlines");
	}
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
		jsonEventStream,
		reasoning,
		maxOutputTokens,
		maxTurns,
		disableRunBudget,
		runControlWorkMs,
		runControlGraceMs,
		runControlStationaryTurns,
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
      --json-mode <mode>         raw|semantic (default: raw)
      --include-media-data       Include base64 in JSON media descriptors

Model:
      --model <provider/model>   Select an exact Model
      --reasoning <level>        off|minimal|low|medium|high|xhigh|max
      --max-output-tokens <n>    Reserve at most n output tokens (default: 16384)
      --max-turns <n>            Limit one Run to n model Turns (default: 64)
	  --no-run-budget            Disable economic RunBudget limits for this invocation
      --run-control-work-ms <n>  Request finalization after this work duration
      --run-control-grace-ms <n> Abort after this additional finalization grace
      --run-control-stationary-turns <n>
                                 Request finalization after n no-progress Turns
      --api-key <key>            Use a request-scoped API key
      --image <path>             Attach an image (repeatable)

Workspace:
      --workspace <path>         Select the Workspace root
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

function runControlConfiguration(parsed: ParsedArguments): RunControlConfiguration | undefined {
	if (parsed.runControlWorkMs === undefined || parsed.runControlGraceMs === undefined) return undefined;
	return Object.freeze({
		workDurationMs: parsed.runControlWorkMs,
		graceDurationMs: parsed.runControlGraceMs,
		...(parsed.runControlStationaryTurns !== undefined
			? { maxStationaryTurns: parsed.runControlStationaryTurns }
			: {}),
	});
}

function createEffortCommand(
	session: Session,
	runtime: CodingAgentRuntime,
): NonNullable<InteractiveSessionOptions["effortCommand"]> {
	return {
		snapshot: () => ({
			current: runtime.snapshot().desired.reasoning,
			available: availableReasoningEfforts(runtime.snapshot().desired.model),
		}),
		select: async (effort) => {
			const selected = runtime.snapshot().desired;
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
			runtime.selectReasoning(reasoning);
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

function interactiveStatusLineSnapshot(runtime: CodingAgentRuntime, session: Session): SessionStatusLineSnapshot {
	const snapshot = runtime.snapshot();
	const selected = snapshot.activeRun?.prepared ?? snapshot.desired;
	const context = runtime.contextUsage();
	const cost = sessionCostSnapshot(
		snapshot.agent.messages,
		runtime.compactionCost,
		session.discardedModelCost,
		selected.model.cost !== undefined,
	);
	return {
		modelSupportsReasoning: selected.model.reasoning,
		context: {
			usedTokens: context.usedTokens,
			windowTokens: context.windowTokens,
			estimated: context.estimated || latestUsageComesFromAnotherModel(snapshot.agent.messages, selected.model),
		},
		...(cost ? { cost } : {}),
	};
}

function latestUsageComesFromAnotherModel(
	messages: import("@coda/agent").AgentState["messages"],
	model: Model<Api>,
): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]?.message;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usageTokens =
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (usageTokens === 0) continue;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
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
			"Trusting a stdio Server allows Coda to launch its configured executable and call its Tools.",
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
				const configuredRunControl = runControlConfiguration(parsed);
				if (configuredRunControl && !options.runtime.scheduler) {
					throw new Error("Configured RunControl requires an injected Scheduler");
				}
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
				const pendingWorkspaceDiffs = new Map<string, Set<Promise<void>>>();
				const beginWorkspaceDiffSupplement = (targetSession: Session, runId: string): Promise<void> => {
					const operation = (async () => {
						const diff = await collectWorkspaceDiff({
							processRunner: options.processRunner,
							workspace: workspace.root,
							environment: options.runtime.environment,
						});
						targetSession.supplementRunEvidence(runId, diff);
					})();
					const key = targetSession.descriptor.id;
					const pending = pendingWorkspaceDiffs.get(key) ?? new Set<Promise<void>>();
					pending.add(operation);
					pendingWorkspaceDiffs.set(key, pending);
					const remove = () => {
						pending.delete(operation);
						if (pending.size === 0) pendingWorkspaceDiffs.delete(key);
					};
					void operation.then(remove, remove);
					return operation;
				};
				const drainWorkspaceDiffSupplements = async (targetSession: Session): Promise<void> => {
					for (;;) {
						const pending = [...(pendingWorkspaceDiffs.get(targetSession.descriptor.id) ?? [])];
						if (pending.length === 0) return;
						await Promise.allSettled(pending);
					}
				};
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
				const jsonEventWriter =
					parsed.output === "json"
						? new JsonEventWriter({
								mode: parsed.jsonEventStream,
								output: options.io.stdout,
								project: (value) => projectJsonMedia(value, mediaLibrary, parsed.includeMediaData),
							})
						: undefined;
				let skillWatcher: SkillWatcher | undefined;
				let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
				let mcpRegistry: CodingMcpRegistry | undefined;
				let processSessionManager: ProcessSessionManager | undefined;
				let runControlBinding: AgentRunControlBinding | undefined;
				let runtimeToClose: CodingAgentRuntime | undefined;
				const closeRuntimeResources = async (): Promise<void> => {
					const failures: unknown[] = [];
					try {
						await drainWorkspaceDiffSupplements(session);
					} catch (error) {
						failures.push(error);
					}
					try {
						if (runtimeToClose) await runtimeToClose.close();
						else await session.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await drainWorkspaceDiffSupplements(session);
					} catch (error) {
						failures.push(error);
					}
					try {
						await processSessionManager?.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await mcpRegistry?.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await mediaLibrary.dispose();
					} catch (error) {
						failures.push(error);
					}
					if (failures.length === 1) throw failures[0];
					if (failures.length > 1) throw new AggregateError(failures, "Could not close the Agent runtime");
				};
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
											"The exact hash will be bound to this Workspace; any change requires review again.",
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
					const configuredShell = options.runtime.environment.SHELL;
					const shellExecutable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
					const interactiveMcpElicitation =
						parsed.mode === "interactive" && !options.mcpElicitation
							? new InteractiveMcpElicitationHandler()
							: undefined;
					const primaryMcpElicitation =
						options.mcpElicitation ?? interactiveMcpElicitation?.forSession(session.descriptor.id);
					const initialMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
					const activeProcessSessionManager = new ProcessSessionManager({
						fileSystem: options.fileSystem,
						homeDirectory: options.runtime.homeDirectory,
						runner: options.processSessionRunner ?? unavailableProcessSessionRunner,
						idGenerator: options.runtime.idGenerator,
					});
					processSessionManager = activeProcessSessionManager;
					await session.record({
						type: "model_selected",
						model: { provider: model.provider, id: model.id },
						reasoning,
					});
					const agentRuntime = await openCodingAgentRuntime({
						...createWorkspaceRuntimeServices({
							session,
							workspace,
							fileSystem: options.fileSystem,
							processRunner: options.processRunner,
							processSessionManager: activeProcessSessionManager,
							shellExecutable,
							applicationRuntime: options.runtime,
							skillsManager,
							initialSkills: skillsSnapshot,
							skillRegistryBinding: skillRegistryBinding!,
							mcpRegistry,
							initialMcp,
						}),
						selection: { model, reasoning, authSnapshot: auth },
						models: options.models,
						clock: options.runtime.clock,
						idGenerator: options.runtime.idGenerator,
						runBudget: codingAgentRunBudget(parsed.maxTurns, parsed.disableRunBudget),
						autoDrainFollowUps: parsed.mode !== "interactive",
						interactionMode: parsed.mode,
						maxOutputTokens: parsed.maxOutputTokens,
						workspaceRoot: workspace.root,
						platform: options.runtime.platform,
						projectInstructions,
						mcpElicitation: primaryMcpElicitation,
						...(options.runtime.scheduler ? { scheduler: options.runtime.scheduler } : {}),
					});
					runtimeToClose = agentRuntime;
					runControlBinding = configuredRunControl
						? bindAgentRunControl({
								runtime: agentRuntime,
								configuration: configuredRunControl,
								clock: options.runtime.clock,
								scheduler: options.runtime.scheduler!,
							})
						: undefined;
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
					const initialMessageCount = agentRuntime.snapshot().agent.messages.length;
					agentRuntime.subscribe(async (event) => {
						if (event.type === "run_end") {
							const supplement = beginWorkspaceDiffSupplement(session, event.runId);
							if (parsed.mode === "interactive" && !agentRuntime.snapshot().closed) {
								void supplement.catch(() => undefined);
							} else {
								await supplement;
							}
						}
					});
					const completionController =
						parsed.mode === "print"
							? new CodingCompletionController({
									workspaceEvidence:
										options.completionWorkspaceEvidence ??
										createGitWorkspaceEvidenceProvider({
											processRunner: options.processRunner,
											fileSystem: options.fileSystem,
											workspace: workspace.root,
											environment: options.runtime.environment,
											now: () => options.runtime.clock.now(),
										}),
									steer: (message) => {
										agentRuntime.steer(message);
									},
								})
							: undefined;
					if (completionController) {
						agentRuntime.subscribe((event) => completionController.accept(event));
					}
					if (parsed.mode === "interactive") {
						const persistCustomProviders = async (): Promise<void> => {
							settings = { ...settings, customProviders: providerManager.configurations };
							await options.settings.save(settings);
						};
						const sessionRunRuntimes = new Map<
							string,
							{ readonly runtime: CodingAgentRuntime; readonly apiKey: string | undefined }
						>([[session.descriptor.id, { runtime: agentRuntime, apiKey: parsed.apiKey }]]);
						const refreshProviderAuth = async (providerId: string): Promise<void> => {
							for (const { runtime, apiKey } of sessionRunRuntimes.values()) {
								const selected = runtime.snapshot().desired;
								if (selected.model.provider !== providerId) continue;
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
							{
								readonly session: Session;
								readonly runtime: CodingAgentRuntime;
								readonly mediaLibrary: MediaLibrary;
								readonly runControl?: AgentRunControlBinding;
							}
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
							let targetRuntimeToClose: CodingAgentRuntime | undefined;
							let targetRunControlToDispose: AgentRunControlBinding | undefined;
							try {
								const targetSelection = targetSession.restored.model ?? settings.defaultModel;
								if (!targetSelection) throw new Error("A new Session requires a configured default Model");
								const targetModel = findModel(options.models, targetSelection);
								const targetReasoning = effectiveReasoningEffort(
									targetModel,
									targetSession.restored.reasoning ?? settings.defaultReasoning ?? "medium",
								);
								const targetAuth = await options.models.getAuth(targetModel, { clock: options.runtime.clock });
								const targetInitialMcp = mcpRegistry?.freezeTools() ?? emptyMcpToolSnapshot();
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
								const targetRuntime = await openCodingAgentRuntime({
									...createWorkspaceRuntimeServices({
										session: targetSession,
										workspace,
										fileSystem: options.fileSystem,
										processRunner: options.processRunner,
										processSessionManager: activeProcessSessionManager,
										shellExecutable,
										applicationRuntime: options.runtime,
										skillsManager,
										initialSkills: skillsManager.current ?? skillsSnapshot,
										skillRegistryBinding: skillRegistryBinding!,
										mcpRegistry,
										initialMcp: targetInitialMcp,
									}),
									selection: {
										model: targetModel,
										reasoning: targetReasoning,
										authSnapshot: targetAuth,
									},
									models: options.models,
									clock: options.runtime.clock,
									idGenerator: options.runtime.idGenerator,
									runBudget: codingAgentRunBudget(parsed.maxTurns, parsed.disableRunBudget),
									autoDrainFollowUps: false,
									interactionMode: "interactive",
									maxOutputTokens: parsed.maxOutputTokens,
									workspaceRoot: workspace.root,
									platform: options.runtime.platform,
									projectInstructions,
									mcpElicitation: targetMcpElicitation,
									...(options.runtime.scheduler ? { scheduler: options.runtime.scheduler } : {}),
								});
								targetRuntimeToClose = targetRuntime;
								sessionRunRuntimes.set(targetSession.descriptor.id, {
									runtime: targetRuntime,
									apiKey: undefined,
								});
								const targetRunControl = configuredRunControl
									? bindAgentRunControl({
											runtime: targetRuntime,
											configuration: configuredRunControl,
											clock: options.runtime.clock,
											scheduler: options.runtime.scheduler!,
										})
									: undefined;
								targetRunControlToDispose = targetRunControl;
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
								targetRuntime.subscribe(async (event) => {
									if (event.type === "run_end") {
										const supplement = beginWorkspaceDiffSupplement(targetSession, event.runId);
										if (targetRuntime.snapshot().closed) await supplement;
										else void supplement.catch(() => undefined);
									}
								});
								secondaryResources.set(targetSession.descriptor.id, {
									session: targetSession,
									runtime: targetRuntime,
									mediaLibrary: targetMediaLibrary,
									...(targetRunControl ? { runControl: targetRunControl } : {}),
								});
								return {
									runtime: targetRuntime,
									session: targetSession,
									modelLabel: `${targetModel.provider}/${targetModel.id}`,
									activitySummaryMode: activitySummaryModeForApi(targetModel.api),
									statusLine: () => interactiveStatusLineSnapshot(targetRuntime, targetSession),
									modelCommand: {
										currentKey: () =>
											`${targetRuntime.snapshot().desired.model.provider}/${targetRuntime.snapshot().desired.model.id}`,
										list: listModelEntries,
										select: async (selected) => {
											const authSnapshot = await options.models.getAuth(selected.runtime, {
												clock: options.runtime.clock,
											});
											if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
											const nextReasoning = effectiveReasoningEffort(
												selected.runtime,
												targetRuntime.snapshot().desired.reasoning,
											);
											await targetSession.record({
												type: "model_selected",
												model: { provider: selected.providerId, id: selected.id },
												reasoning: nextReasoning,
											});
											targetRuntime.select({
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
									effortCommand: createEffortCommand(targetSession, targetRuntime),
									authCommand,
									skillsCommand,
									mcpCommand,
									compactCommand: {
										run: async (focus) => {
											await targetRuntime.requestCompaction(focus);
											return "Context compacted";
										},
									},
									contextOverflowRecovery: {
										takeUnrecoverable: () => targetRuntime.takeUnrecoverableOverflow(),
									},
									reasoning: targetReasoning,
									restoredAttachments: targetRestoredMedia.attachments,
									resolveExtensionReferences: async (references) => {
										const snapshot = await skillsManager.refresh();
										assertSkillReferencesAvailable(snapshot, references);
									},
									buildPrompt: async (text, attachmentIds, inputContext) => {
										const selectedModel = targetRuntime.snapshot().desired.model;
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
												? (targetRuntime.snapshot().activeRun?.prepared.skills ??
													skillsManager.current ??
													skillsSnapshot)
												: (skillsManager.current ??
													targetRuntime.snapshot().activeRun?.prepared.skills ??
													skillsSnapshot);
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
											inputContext.kind === "steering"
												? undefined
												: targetRuntime.createSkillSnapshotBinding();
										const prepared = prependSkillContext(
											input,
											renderExplicitSkillContext(activations, snapshotBinding),
											renderExplicitSkillReferences(activations),
										);
										if (snapshotBinding)
											targetRuntime.prepareSkillSnapshot(prepared, snapshot, snapshotBinding);
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
									onRetire: () => activeProcessSessionManager.retireSession(targetSession.descriptor.id),
								};
							} catch (error) {
								sessionRunRuntimes.delete(targetSession.descriptor.id);
								targetRunControlToDispose?.dispose();
								if (targetRuntimeToClose) await targetRuntimeToClose.close().catch(() => undefined);
								else await targetSession.close().catch(() => undefined);
								await targetMediaLibrary.dispose().catch(() => undefined);
								throw error;
							}
						};
						let exitCode: number;
						let overflowReplacement: InteractiveSessionOptions | undefined;
						try {
							exitCode = await runInteractive({
								runtime: agentRuntime,
								session,
								terminal: interactiveRuntime!.terminal,
								clock: options.runtime.clock,
								scheduler: interactiveRuntime!.scheduler,
								imageSurface,
								keybindings: options.keybindings ?? [],
								diagnostics: options.diagnostics,
								fullScreenOutput: options.fullScreenOutput,
								mcpElicitation: interactiveMcpElicitation,
								modelLabel: `${model.provider}/${model.id}`,
								activitySummaryMode: activitySummaryModeForApi(model.api),
								statusLine: () => interactiveStatusLineSnapshot(agentRuntime, session),
								modelCommand: {
									currentKey: () =>
										`${agentRuntime.snapshot().desired.model.provider}/${agentRuntime.snapshot().desired.model.id}`,
									list: listModelEntries,
									select: async (selected) => {
										const authSnapshot = await options.models.getAuth(selected.runtime, {
											apiKey: selected.providerId === model.provider ? parsed.apiKey : undefined,
											clock: options.runtime.clock,
										});
										if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
										const nextReasoning = effectiveReasoningEffort(
											selected.runtime,
											agentRuntime.snapshot().desired.reasoning,
										);
										await session.record({
											type: "model_selected",
											model: { provider: selected.providerId, id: selected.id },
											reasoning: nextReasoning,
										});
										agentRuntime.select({
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
								effortCommand: createEffortCommand(session, agentRuntime),
								authCommand,
								skillsCommand,
								mcpCommand,
								compactCommand: {
									run: async (focus) => {
										await agentRuntime.requestCompaction(focus);
										return "Context compacted";
									},
								},
								contextOverflowRecovery: { takeUnrecoverable: () => agentRuntime.takeUnrecoverableOverflow() },
								onRetire: () => activeProcessSessionManager.retireSession(session.descriptor.id),
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
								onContextOverflowReplacement: (replacement) => {
									overflowReplacement = replacement;
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
									const selectedModel = agentRuntime.snapshot().desired.model;
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
											? (agentRuntime.snapshot().activeRun?.prepared.skills ??
												skillsManager.current ??
												skillsSnapshot)
											: (skillsManager.current ??
												agentRuntime.snapshot().activeRun?.prepared.skills ??
												skillsSnapshot);
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
										inputContext.kind === "steering" ? undefined : agentRuntime.createSkillSnapshotBinding();
									const prepared = prependSkillContext(
										input,
										renderExplicitSkillContext(activations, snapshotBinding),
										renderExplicitSkillReferences(activations),
									);
									if (snapshotBinding) agentRuntime.prepareSkillSnapshot(prepared, snapshot, snapshotBinding);
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
									resource.runControl?.dispose();
									try {
										await drainWorkspaceDiffSupplements(resource.session);
									} catch (error) {
										failures.push(error);
									}
									try {
										await resource.runtime.close();
									} catch (error) {
										failures.push(error);
									}
									try {
										await drainWorkspaceDiffSupplements(resource.session);
									} catch (error) {
										failures.push(error);
									}
									try {
										await resource.mediaLibrary.dispose();
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
						const finalRuntime = overflowReplacement?.runtime ?? agentRuntime;
						const finalAgent = finalRuntime.snapshot().agent;
						const finalSession = overflowReplacement?.session ?? session;
						const interactiveMessages = finalAgent.messages.slice(overflowReplacement ? 0 : initialMessageCount);
						const finalAssistant = [...interactiveMessages]
							.reverse()
							.find(
								({ message }) => message.role === "assistant" && finalText(message).trim().length > 0,
							)?.message;
						if (finalAssistant?.role === "assistant") {
							await options.io.stdout.write(`${finalText(finalAssistant)}\n`);
						}
						if (finalSession.descriptor.persistent && finalSession.descriptor.path) {
							await options.io.stdout.write(
								`Session ${finalSession.descriptor.id} • resume with: coda --resume ${finalSession.descriptor.id}\n`,
							);
						}
						if (finalAgent.lastRun && finalAgent.lastRun.outcome !== "success") {
							await options.io.stderr.write(
								`coda: ${finalAgent.lastRun.failure?.message ?? `Run ended with outcome ${finalAgent.lastRun.outcome}`}\n`,
							);
						}
						return exitCode;
					}
					if (jsonEventWriter) {
						agentRuntime.subscribe(async (event) => {
							const runControl =
								event.type === "run_start" || event.type === "run_end"
									? runControlBinding?.reportForRun(String(event.runId))
									: undefined;
							await jsonEventWriter.writeAgentEvent(
								event,
								event.type === "run_start"
									? (() => {
											const prepared = agentRuntime.snapshot().activeRun?.prepared;
											if (!prepared) throw new Error(`Prepared Run ${event.runId} is unavailable`);
											return {
												model: { provider: prepared.model.provider, id: prepared.model.id },
												reasoning: prepared.reasoning,
												prompt: { version: prepared.prompt.version, sha256: prepared.prompt.sha256 },
											};
										})()
									: undefined,
								runControlBinding ? { schemaVersion: 3, ...(runControl ? { runControl } : {}) } : undefined,
							);
							if (event.type === "run_end") {
								const evidence = session.runEvidence.at(-1);
								if (!evidence || evidence.runId !== event.runId) {
									throw new Error(`Run evidence was unavailable after completed Run ${event.runId}`);
								}
								const outputEvidence = runControl ? withRunControlEvidence(evidence, runControl) : evidence;
								await jsonEventWriter.writeRecord(outputEvidence);
								const disposition = completionController?.get(event.runId);
								if (!disposition) {
									throw new Error(`Completion disposition was unavailable after completed Run ${event.runId}`);
								}
								await jsonEventWriter.writeRecord(disposition);
							}
						});
					}
					const initialMedia = await prepareAttachments(initialAttachmentIds);
					let initialMediaCommitted = false;
					const detachInitialMediaCommit = agentRuntime.subscribe(async (event) => {
						if (event.type !== "run_start" || event.source !== "prompt" || initialMediaCommitted) return;
						await initialMedia.commit();
						initialMediaCommitted = true;
					});
					let result: Awaited<ReturnType<CodingAgentRuntime["prompt"]>>;
					try {
						result = await agentRuntime.prompt(initialInput);
					} finally {
						detachInitialMediaCommit();
						if (!initialMediaCommitted) await initialMedia.rollback();
					}
					if (result.outcome !== "success" || !result.finalMessageId) {
						const detail = result.failure?.message ?? `Run ended with outcome ${result.outcome}`;
						await options.io.stderr.write(`coda: ${detail}\n`);
						return 1;
					}
					const committed = agentRuntime
						.snapshot()
						.agent.messages.find(({ id }) => id === result.finalMessageId)?.message;
					if (!committed || committed.role !== "assistant") throw new Error("Final Assistant Message is missing");
					if (parsed.output === "text") await options.io.stdout.write(`${finalText(committed)}\n`);
					const disposition = completionController?.get(result.runId);
					if (!disposition)
						throw new Error(`Completion disposition was unavailable after completed Run ${result.runId}`);
					if (disposition.disposition !== "verified") {
						if (parsed.output === "text") {
							await options.io.stderr.write(
								`coda: completion ${disposition.disposition} (${disposition.reasons.join(", ")})\n`,
							);
						}
						return 1;
					}
					return 0;
				} finally {
					runControlBinding?.dispose();
					skillWatcher?.dispose();
					skillRegistryBinding?.dispose();
					await closeRuntimeResources();
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
