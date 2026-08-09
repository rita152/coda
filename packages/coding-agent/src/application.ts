import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { Agent, type AgentInput, type Clock, type IdGenerator, type Immutable } from "@coda/agent";
import type { Api, AssistantMessage, AuthPrompt, ImageContent, Model, Models, ThinkingLevel } from "@coda/ai";
import {
	createTerminalImageSurface,
	type DiagnosticSink,
	type Keybinding,
	type Scheduler,
	type Terminal,
} from "@coda/tui";
import { type FileSystem, isFileSystemError } from "./host/file-system.ts";
import type { ProcessRunner } from "./host/process-runner.ts";
import { InteractiveApprovalHandler } from "./interactive/approval.ts";
import type { ChatAttachment } from "./interactive/chat-component.ts";
import { FullScreenOutputGate } from "./interactive/full-screen-output.ts";
import type { AttachmentTransaction } from "./interactive/input-controller.ts";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./interactive/process-lifecycle.ts";
import {
	confirmFromTerminal,
	type PromptRuntime,
	promptTextFromTerminal,
	selectFromTerminal,
} from "./interactive/prompts.ts";
import { runInteractive } from "./interactive/run-interactive.ts";
import { cleanupSessionMedia } from "./maintenance/session-media.ts";
import { cleanupTemporaryLogs } from "./maintenance/temporary-logs.ts";
import { type MediaAsset, MediaLibrary } from "./media/media-library.ts";
import { type ModelCapabilityResolver, resolveModelRuntimeCapabilities } from "./model-capabilities.ts";
import { type ApprovalHandler, createWorkspacePolicy } from "./policy.ts";
import { loadProjectInstructions } from "./project/project-context.ts";
import { assertContextFits, assertModelContextFits } from "./prompt/context-budget.ts";
import { buildSystemPrompt } from "./prompt/prompt-builder.ts";
import { createCodingAgentRetry } from "./retry.ts";
import { sessionMediaExtension } from "./session/media-codec.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import type { Session, SessionManager, SessionMediaReference, SessionMediaRegistration } from "./session/types.ts";
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

export interface UserSettings {
	readonly defaultModel?: ModelSelection;
	readonly defaultReasoning?: ThinkingLevel | "off";
	readonly shellEnvironmentAllowlist?: readonly string[];
	readonly projectTrust?: readonly ProjectTrustRecord[];
	readonly ui?: { readonly motion: "full" | "reduced" };
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
}

export interface TerminalFactory {
	create(options: TerminalStartupOptions): Terminal;
}

export interface CodingAgentApplicationOptions {
	readonly models: Models;
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
	readonly approval?: ApprovalHandler;
	readonly modelCapabilities?: ModelCapabilityResolver;
}

export interface CodingAgentApplication {
	run(args: readonly string[]): Promise<number>;
}

interface ParsedArguments {
	readonly action: "cleanup" | "help" | "run" | "sessions" | "version";
	readonly mode: "interactive" | "print";
	readonly output: "json" | "text";
	readonly allowWorkspaceWrite: boolean;
	readonly allowBash: boolean;
	readonly reasoning?: ThinkingLevel | "off";
	readonly apiKey?: string;
	readonly workspace?: string;
	readonly trustProject: boolean;
	readonly persistSession: boolean;
	readonly noSession: boolean;
	readonly noColor: boolean;
	readonly noAnimations: boolean;
	readonly includeMediaData: boolean;
	readonly resumeId?: string;
	readonly forceUnlock: boolean;
	readonly model?: ModelSelection;
	readonly prompt: string;
	readonly imagePaths: readonly string[];
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
	let allowWorkspaceWrite = false;
	let allowBash = false;
	let reasoning: ThinkingLevel | "off" | undefined;
	let apiKey: string | undefined;
	let workspace: string | undefined;
	let trustProject = false;
	let persistSession = false;
	let noSession = false;
	let noColor = false;
	let noAnimations = false;
	let includeMediaData = false;
	let resumeId: string | undefined;
	let forceUnlock = false;
	let model: ModelSelection | undefined;
	const promptParts: string[] = [];
	const imagePaths: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (index === 0 && (argument === "cleanup" || argument === "sessions")) {
			action = argument;
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
		if (argument === "--allow-workspace-write") {
			allowWorkspaceWrite = true;
			continue;
		}
		if (argument === "--allow-bash") {
			allowBash = true;
			continue;
		}
		if (argument === "--reasoning") {
			const value = args[++index];
			if (!value || !THINKING_LEVELS.includes(value as ThinkingLevel | "off")) {
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
		promptParts.push(argument);
	}

	if (output === "json" && explicitMode === "interactive") throw new Error("--json cannot be used with --interactive");
	if (includeMediaData && output !== "json") throw new Error("--include-media-data requires --json");
	const mode = explicitMode ?? (output === "json" || !io.stdin.isTTY || !io.stdout.isTTY ? "print" : "interactive");
	let prompt = promptParts.join(" ").trim();
	if (action !== "run" && (prompt.length > 0 || imagePaths.length > 0)) {
		throw new Error(`${action} does not accept a prompt or image`);
	}
	if (action === "run" && prompt.length === 0 && !io.stdin.isTTY) prompt = (await io.stdin.readAll()).trim();
	return {
		action,
		mode,
		output,
		allowWorkspaceWrite,
		allowBash,
		reasoning,
		apiKey,
		workspace,
		trustProject,
		persistSession,
		noSession,
		noColor,
		noAnimations,
		includeMediaData,
		resumeId,
		forceUnlock,
		model,
		prompt,
		imagePaths: Object.freeze([...imagePaths]),
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

const THINKING_LEVELS: readonly (ThinkingLevel | "off")[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const HELP = `Usage: coda [options] [prompt]

Modes:
  -p, --print                    Run once and print the final answer
  -i, --interactive              Start the interactive terminal UI
      --no-tui                   Alias for --print
      --no-color                 Disable color in this Coda invocation
      --no-animations            Disable periodic TUI motion
      --json                     Emit stable JSONL Agent events
      --include-media-data      Include base64 in JSON media descriptors

Model:
      --model <provider/model>   Select an exact Model
      --reasoning <level>        off|minimal|low|medium|high|xhigh|max
      --api-key <key>            Use a request-scoped API key
      --image <path>             Attach an image (repeatable)

Workspace policy:
      --workspace <path>         Select the Workspace root
      --allow-workspace-write    Permit edit/write in print mode
      --allow-bash               Permit bash in print mode
      --trust-project            Trust the current root AGENTS.md hash

Session:
      --session                  Persist this Session (print mode is memory-only by default)
      --no-session               Disable default interactive persistence
      --resume <id>              Resume a linear Session
      --force-unlock             Archive a definitely dead lock in print mode

Commands:
  sessions                       List Sessions for the selected Workspace
  cleanup                        Remove expired, unreferenced temporary logs

Other:
  -h, --help                     Show this help
  -v, --version                  Show the Coda version
`;

function effectiveReasoning(model: Model<Api>, requested: ThinkingLevel | "off"): ThinkingLevel | "off" {
	if (!model.reasoning) return "off";
	const supported = THINKING_LEVELS.filter((level) => {
		const mapping = model.thinkingLevelMap?.[level];
		if (mapping === null) return false;
		return level !== "xhigh" && level !== "max" ? true : mapping !== undefined;
	});
	if (supported.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	return (
		supported.find((candidate) => THINKING_LEVELS.indexOf(candidate) > requestedIndex) ??
		[...supported].reverse().find((candidate) => THINKING_LEVELS.indexOf(candidate) < requestedIndex) ??
		"off"
	);
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
				const terminal =
					parsed.mode === "interactive"
						? options.terminalFactory?.create({
								noColor: parsed.noColor || options.runtime.environment.NO_COLOR !== undefined,
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
					const reasoning = effectiveReasoning(
						model,
						parsed.reasoning ?? session.restored.reasoning ?? settings.defaultReasoning ?? "medium",
					);
					const projectInstructions = await loadProjectInstructions(workspace, options.fileSystem);
					const trustedProject = projectInstructions
						? [
								...(settings.projectTrust ?? []),
								...(session.restored.projectTrust ? [session.restored.projectTrust] : []),
							].some(
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
					const tools = createCodingTools({
						workspace,
						fileSystem: options.fileSystem,
						processRunner: options.processRunner,
						runtime: options.runtime,
						settings,
					});
					const freezePrompt = () =>
						buildSystemPrompt({
							workspace: workspace.root,
							platform: options.runtime.platform,
							timestamp: options.runtime.clock.now(),
							tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
							capabilities: {
								interactionMode: parsed.mode,
								workspaceWrite: parsed.mode === "interactive" || parsed.allowWorkspaceWrite,
								bash: parsed.allowBash,
							},
							projectInstructions,
						});
					let promptSnapshot = freezePrompt();
					assertContextFits(
						model,
						promptSnapshot.text,
						initialInput,
						tools,
						session.seed.messages.map(({ message }) => message),
					);
					await session.record({
						type: "model_selected",
						model: { provider: model.provider, id: model.id },
						reasoning,
					});
					const interactiveApproval =
						parsed.mode === "interactive" && !options.approval ? new InteractiveApprovalHandler() : undefined;
					const policy = createWorkspacePolicy(workspace, {
						mode: parsed.mode,
						allowWorkspaceWrite: parsed.allowWorkspaceWrite,
						allowBash: parsed.allowBash,
						approval: options.approval ?? interactiveApproval,
					});
					const agent = new Agent({
						clock: options.runtime.clock,
						idGenerator: options.runtime.idGenerator,
						tools,
						policyGate: policy,
						retry: options.runtime.scheduler ? createCodingAgentRetry(options.runtime.scheduler) : undefined,
						stream: ({ context, signal }) => {
							const contextBudget = assertModelContextFits(model, context);
							return options.models.streamSimple(model, context, {
								signal,
								apiKey: parsed.apiKey,
								reasoning: reasoning === "off" ? undefined : reasoning,
								maxTokens: contextBudget.reservedOutputTokens,
							});
						},
						beforeRun: ({ inputMessage }) => {
							promptSnapshot = freezePrompt();
							assertContextFits(
								model,
								promptSnapshot.text,
								inputMessage.message.content,
								tools,
								agent.state.messages.map(({ message }) => message),
							);
							void session.record({
								type: "prepare_run",
								promptVersion: promptSnapshot.version,
								promptSha256: promptSnapshot.sha256,
							});
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
						if (event.type === "tool_execution_rejected" && policy.consumeAbort(event.invocation.id)) {
							agent.abort();
						}
					});
					if (parsed.mode === "interactive") {
						const imageSurface = createTerminalImageSurface({
							terminal: interactiveRuntime!.terminal,
							environment: options.runtime.environment,
							allocateId: terminalImageIdAllocator(options.runtime.idGenerator),
						});
						const exitCode = await runInteractive({
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
							modelLabel: `${model.provider}/${model.id}`,
							workspaceLabel: basename(workspace.root) || workspace.root,
							reasoning,
							motion: parsed.noAnimations ? "reduced" : (settings.ui?.motion ?? "full"),
							lifecycle: options.runtime.interactiveLifecycle,
							allocateId: () => options.runtime.idGenerator.generate("queue_item"),
							processRunner: options.processRunner,
							platform: options.runtime.platform,
							environment: options.runtime.environment,
							workspace: workspace.root,
							onWarning: (message) => options.io.stderr.write(`coda: ${message}\n`),
							toolResultImagesSupported: resolveModelRuntimeCapabilities(model, options.modelCapabilities)
								.toolResultImages,
							initialPrompt: hasAgentInput(initialInput) ? initialInput : undefined,
							initialAttachmentIds,
							initialAttachments,
							restoredAttachments: restoredMedia.attachments,
							buildPrompt: async (text, attachmentIds) => {
								if (attachmentIds.length > 0 && !model.input.includes("image")) {
									throw new Error(`Model does not support image input: ${model.provider}/${model.id}`);
								}
								return promptInput(text, attachmentIds, mediaLibrary, restoredMedia.contents);
							},
							prepareAttachments,
							onAttach: async (path) => {
								const attachment = await mediaLibrary.ingestPath(path);
								return chatAttachment(mediaLibrary, attachment.id);
							},
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
					return 0;
				} finally {
					await mediaLibrary.dispose();
					await session.close();
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
