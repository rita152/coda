import { randomInt, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import { type CredentialStore, createModels, createSystemTimeRuntime, type MutableModels } from "@coda/ai";
import { opencodeGoProvider } from "@coda/ai/providers/opencode-go";
import { createSdkMcpConnector, type McpConnector } from "@coda/mcp";
import { createSystemScheduler, ProcessTerminal, type Scheduler, type Terminal } from "@coda/tui";
import { FileSettingsStore } from "./app/file-settings-store.ts";
import {
	type ApplicationIO,
	type ApplicationOutput,
	type CodingAgentApplication,
	createCodingAgentApplication,
	type SettingsStore,
	type TerminalFactory,
} from "./application.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import { createNodeCredentialStore } from "./credentials/node-credential-store.ts";
import type { FileSystem } from "./host/file-system.ts";
import { isFileSystemError } from "./host/file-system.ts";
import { createNodeFileSystem } from "./host/node-file-system.ts";
import { createNodeProcessRunner } from "./host/node-process-runner.ts";
import { createNodeProcessSessionRunner } from "./host/node-process-session-runner.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { ProviderManager } from "./models/provider-manager.ts";
import { createFileWorkspacePersistence } from "./runtime/file-workspace-persistence.ts";
import { FileSessionManager } from "./session/file-session-manager.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import { SessionManagerRouter } from "./session/session-manager-router.ts";
import { interruptedToolRecoveryChoices } from "./session/session-recovery.ts";
import type { SessionManager } from "./session/types.ts";
import { createNodeSkillWatcherFactory, type SkillWatcherFactory } from "./skills/watcher.ts";
import { createInterruptedToolRecoveryCatalog } from "./tools/recovery-catalog.ts";
import { FullScreenOutputGate } from "./ui/full-screen-output.ts";
import type { InteractiveProcessLifecycle, InteractiveTerminationSignal } from "./ui/process-lifecycle.ts";
import { selectFromTerminal } from "./ui/prompts.ts";

class SystemIds implements IdGenerator {
	generate(kind: Parameters<IdGenerator["generate"]>[0]): string {
		return `${kind}:${randomUUID()}`;
	}
}

function streamOutput(stream: NodeJS.WritableStream & { readonly isTTY?: boolean }): ApplicationOutput {
	return {
		isTTY: stream.isTTY === true,
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				stream.write(chunk, (error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			}),
	};
}

function processIo(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): ApplicationIO {
	let consumed = false;
	return {
		stdin: {
			isTTY: stdin.isTTY === true,
			readAll: async () => {
				if (consumed) throw new Error("stdin has already been consumed");
				consumed = true;
				stdin.setEncoding("utf8");
				let value = "";
				for await (const chunk of stdin) value += chunk;
				return value;
			},
		},
		stdout: streamOutput(stdout),
		stderr: streamOutput(stderr),
	};
}

function nodeInteractiveLifecycle(platform: NodeJS.Platform): InteractiveProcessLifecycle {
	return {
		subscribe: (handlers) => {
			const terminate = (signal: InteractiveTerminationSignal) => () => handlers.terminate(signal);
			const onSigterm = terminate("SIGTERM");
			const onSighup = terminate("SIGHUP");
			const onSigtstp = () => handlers.suspend();
			const onUncaughtException = (error: Error) => handlers.fatal(error);
			const onUnhandledRejection = (reason: unknown) => handlers.fatal(reason);
			process.on("SIGTERM", onSigterm);
			process.on("uncaughtException", onUncaughtException);
			process.on("unhandledRejection", onUnhandledRejection);
			if (platform !== "win32") {
				process.on("SIGHUP", onSighup);
				process.on("SIGTSTP", onSigtstp);
			}
			return () => {
				process.off("SIGTERM", onSigterm);
				process.off("uncaughtException", onUncaughtException);
				process.off("unhandledRejection", onUnhandledRejection);
				if (platform !== "win32") {
					process.off("SIGHUP", onSighup);
					process.off("SIGTSTP", onSigtstp);
				}
			};
		},
		suspend: async () => {
			if (platform === "win32") throw new Error("Process suspension is unsupported on Windows");
			await new Promise<void>((resolve, reject) => {
				const onContinue = () => resolve();
				process.once("SIGCONT", onContinue);
				try {
					process.kill(process.pid, "SIGSTOP");
				} catch (error) {
					process.off("SIGCONT", onContinue);
					reject(error);
				}
			});
		},
	};
}

export function terminalEnvironmentForStartup(
	environment: Readonly<Record<string, string | undefined>>,
	noColor: boolean,
): Readonly<Record<string, string | undefined>> {
	return noColor ? Object.freeze({ ...environment, NO_COLOR: environment.NO_COLOR ?? "1" }) : environment;
}

export interface NodeCodingAgentApplicationOptions {
	readonly stdin?: NodeJS.ReadStream;
	readonly stdout?: NodeJS.WriteStream;
	readonly stderr?: NodeJS.WriteStream;
	readonly io?: ApplicationIO;
	readonly cwd?: string;
	readonly homeDirectory?: string;
	readonly platform?: NodeJS.Platform;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly clock?: Clock;
	readonly idGenerator?: IdGenerator;
	readonly scheduler?: Scheduler;
	readonly fileSystem?: FileSystem;
	readonly processRunner?: ProcessRunner;
	readonly processSessionRunner?: ProcessSessionRunner;
	readonly credentialStore?: CredentialStore;
	readonly settings?: SettingsStore;
	readonly models?: MutableModels;
	readonly commandRegistry?: CommandRegistry;
	readonly terminalFactory?: TerminalFactory;
	readonly sessions?: SessionManager;
	readonly interactiveLifecycle?: InteractiveProcessLifecycle;
	readonly fetch?: typeof globalThis.fetch;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly mcpConnector?: McpConnector;
}

export function createNodeCodingAgentApplication(
	options: NodeCodingAgentApplicationOptions = {},
): CodingAgentApplication {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const rawIo = options.io ?? processIo(stdin, stdout, stderr);
	const fullScreenOutput = new FullScreenOutputGate(rawIo);
	const io = fullScreenOutput.io;
	const diagnosticOutput = fullScreenOutput.diagnostics;
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	const homeDirectory = options.homeDirectory ?? homedir();
	const clock = options.clock ?? { now: () => Date.now() };
	const idGenerator = options.idGenerator ?? new SystemIds();
	const scheduler = options.scheduler ?? createSystemScheduler();
	const interactiveLifecycle = options.interactiveLifecycle ?? nodeInteractiveLifecycle(platform);
	const timeRuntime = createSystemTimeRuntime({
		clock,
		scheduler,
		random: { next: () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000 },
	});
	const fileSystem = options.fileSystem ?? createNodeFileSystem();
	const processRunner = options.processRunner ?? createNodeProcessRunner({ platform });
	const processSessionRunner = options.processSessionRunner ?? createNodeProcessSessionRunner({ platform });
	const credentials =
		options.credentialStore ??
		createNodeCredentialStore({
			platform,
			environment,
			providerIds: ["opencode-go"],
			onSecretServiceUnavailable: () =>
				diagnosticOutput({
					code: "credentials.secret-service-unavailable",
					message:
						"Linux Secret Service is unavailable; Provider Credentials are not persistent and will be kept only for this Coda process.",
					details: { backend: "secret-service", persistence: "process-local" },
				}),
		});
	const models =
		options.models ??
		(() => {
			const registry = createModels({
				runtime: timeRuntime,
				credentials,
				authContext: {
					env: async (name) => environment[name],
					fileExists: async (path) => {
						try {
							await fileSystem.stat(path);
							return true;
						} catch (error) {
							if (isFileSystemError(error, "ENOENT")) return false;
							throw error;
						}
					},
				},
			});
			registry.setProvider(opencodeGoProvider());
			return registry;
		})();
	const settings = options.settings ?? new FileSettingsStore({ fileSystem, homeDirectory, idGenerator });
	const providerManager = new ProviderManager({
		models,
		fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
	});
	let activeTerminal: Terminal | undefined;
	const terminalFactory: TerminalFactory = {
		create: (startup) => {
			const terminalEnvironment = terminalEnvironmentForStartup(environment, startup.noColor);
			activeTerminal =
				options.terminalFactory?.create(startup) ??
				new ProcessTerminal({
					input: stdin,
					output: stdout,
					environment: terminalEnvironment,
					scheduler,
					diagnostics: diagnosticOutput,
					synchronizedOutput: true,
					colorScheme: startup.colorScheme,
				});
			return activeTerminal;
		},
	};
	const sessions =
		options.sessions ??
		new SessionManagerRouter(
			new InMemorySessionManager({ clock, idGenerator }),
			new FileSessionManager({
				fileSystem,
				homeDirectory,
				clock,
				idGenerator,
				owner: {
					token: idGenerator.generate("queue_item"),
					pid: process.pid,
					processStartedAt: clock.now() - process.uptime() * 1_000,
					hostname: hostname(),
				},
				processInspector: {
					status: async ({ pid }) => {
						try {
							process.kill(pid, 0);
							return "alive";
						} catch (error) {
							const code =
								error instanceof Error && "code" in error
									? (error as Error & { code?: string }).code
									: undefined;
							if (code === "ESRCH") return "dead";
							return "unknown";
						}
					},
				},
				diagnostics: diagnosticOutput,
				recoveryTools: ({ workspace: sessionWorkspace }) =>
					createInterruptedToolRecoveryCatalog({
						workspacePath: sessionWorkspace.path,
						fileSystem,
						processRunner,
						homeDirectory,
						environment,
					}),
				interruptedToolRecovery: async ({ invocation, runId, startedAt }) => {
					if (!activeTerminal) {
						throw new Error("Interrupted Tool recovery requires an active interactive Terminal");
					}
					const selection = await selectFromTerminal(
						{
							terminal: activeTerminal,
							clock,
							scheduler,
							keybindings: [],
							diagnostics: diagnosticOutput,
							fullScreenOutput,
							lifecycle: interactiveLifecycle,
						},
						[
							"Interrupted Tool Invocation detected.",
							`Tool: ${invocation.toolName}`,
							`Arguments: ${JSON.stringify(invocation.arguments).slice(0, 2_000)}`,
							`Run: ${runId ?? "unknown"}`,
							`Started: ${new Date(startedAt).toISOString()}`,
							`Replay safety: ${invocation.replaySafety ?? "unknown"}`,
							"Its external side effects are unknown. Coda will never replay it automatically.",
						].join("\n"),
						interruptedToolRecoveryChoices(invocation.replaySafety),
					);
					if (selection === "skip" || selection === "re-execute") return selection;
					return "cancel";
				},
			}),
		);

	return createCodingAgentApplication({
		models,
		providerManager,
		commandRegistry: options.commandRegistry,
		skillWatcher: options.skillWatcher ?? createNodeSkillWatcherFactory(),
		mcpConnector:
			options.mcpConnector ??
			createSdkMcpConnector({
				fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
				onError: (serverId, error) => {
					void diagnosticOutput({
						code: "mcp.protocol-error",
						message: error.message,
						details: { serverId },
					});
				},
			}),
		settings,
		fileSystem,
		processRunner,
		processSessionRunner,
		io,
		fullScreenOutput,
		terminalFactory,
		sessions,
		workspacePersistence: ({ workspaceId }) =>
			createFileWorkspacePersistence(fileSystem, join(homeDirectory, ".coda", "workspaces", workspaceId)),
		keybindings: [],
		diagnostics: diagnosticOutput,
		runtime: {
			cwd: options.cwd ?? process.cwd(),
			homeDirectory,
			platform,
			environment,
			clock,
			idGenerator,
			scheduler,
			interactiveLifecycle,
		},
	});
}
