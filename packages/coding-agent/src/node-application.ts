import { randomInt, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import type { Clock, IdGenerator } from "@coda/agent";
import { type CredentialStore, createModels, InMemoryCredentialStore, type Models, type TimeRuntime } from "@coda/ai";
import { opencodeGoProvider } from "@coda/ai/providers/opencode-go";
import { createSystemScheduler, type Diagnostic, ProcessTerminal, type Scheduler, type Terminal } from "@coda/tui";
import {
	type ApplicationIO,
	type ApplicationOutput,
	type CodingAgentApplication,
	createCodingAgentApplication,
	type SettingsStore,
	type TerminalFactory,
} from "./application.ts";
import { KeychainCredentialStore } from "./credentials/keychain-store.ts";
import { MacOsKeychainClient } from "./credentials/macos-keychain-client.ts";
import type { FileSystem } from "./host/file-system.ts";
import { isFileSystemError } from "./host/file-system.ts";
import { createNodeFileSystem } from "./host/node-file-system.ts";
import { createNodeProcessRunner } from "./host/node-process-runner.ts";
import type { ProcessRunner } from "./host/process-runner.ts";
import { selectFromTerminal } from "./interactive/prompts.ts";
import { FileSessionManager } from "./session/file-session-manager.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import { SessionManagerRouter } from "./session/session-manager-router.ts";
import type { SessionManager } from "./session/types.ts";
import { FileSettingsStore } from "./settings/file-settings-store.ts";

class SystemIds implements IdGenerator {
	generate(kind: Parameters<IdGenerator["generate"]>[0]): string {
		return `${kind}:${randomUUID()}`;
	}
}

function systemTimeRuntime(clock: Clock, scheduler: Scheduler): TimeRuntime {
	return {
		clock,
		random: { next: () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000 },
		sleep: {
			wait: (delayMs, signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal?.aborted) {
						const error = new Error("Request aborted");
						error.name = "AbortError";
						reject(error);
						return;
					}
					const task = scheduler.schedule(Math.max(0, delayMs), () => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					});
					const onAbort = () => {
						task.cancel();
						const error = new Error("Request aborted");
						error.name = "AbortError";
						reject(error);
					};
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
		},
	};
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
	readonly credentialStore?: CredentialStore;
	readonly settings?: SettingsStore;
	readonly models?: Models;
	readonly terminalFactory?: TerminalFactory;
	readonly sessions?: SessionManager;
}

export function createNodeCodingAgentApplication(
	options: NodeCodingAgentApplicationOptions = {},
): CodingAgentApplication {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const io = options.io ?? processIo(stdin, stdout, stderr);
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	const homeDirectory = options.homeDirectory ?? homedir();
	const clock = options.clock ?? { now: () => Date.now() };
	const idGenerator = options.idGenerator ?? new SystemIds();
	const scheduler = options.scheduler ?? createSystemScheduler();
	const timeRuntime = systemTimeRuntime(clock, scheduler);
	const fileSystem = options.fileSystem ?? createNodeFileSystem();
	const processRunner = options.processRunner ?? createNodeProcessRunner({ platform });
	const credentials =
		options.credentialStore ??
		(platform === "darwin"
			? new KeychainCredentialStore(new MacOsKeychainClient(), ["opencode-go"])
			: new InMemoryCredentialStore());
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
	const diagnosticOutput = async (diagnostic: Diagnostic): Promise<void> => {
		await io.stderr.write(`coda: [${diagnostic.code}] ${diagnostic.message}\n`);
	};
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
						[
							{ id: "cancel", label: "Cancel resume" },
							{
								id: "skip",
								label: "Skip this invocation",
								description:
									"Resume with an explicit error result; request a new invocation later to re-execute.",
							},
						],
					);
					return selection === "skip" ? "skip" : "cancel";
				},
			}),
		);

	return createCodingAgentApplication({
		models,
		settings,
		fileSystem,
		processRunner,
		io,
		terminalFactory,
		sessions,
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
		},
	});
}
