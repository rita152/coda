import { isAbsolute, join } from "node:path";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Workspace } from "../workspace.ts";

const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
	},
	{ additionalProperties: false },
);

const AUTOMATIC_ENVIRONMENT = new Set(["HOME", "LANG", "LANGUAGE", "PATH", "SHELL", "TMPDIR", "USER"]);

function shellEnvironment(
	runtime: ApplicationRuntime,
	allowlist: readonly string[],
): { environment: Record<string, string>; stripped: readonly string[] } {
	const allowed = new Set([...AUTOMATIC_ENVIRONMENT, ...allowlist]);
	for (const name of Object.keys(runtime.environment)) {
		if (/^LC_[A-Z0-9_]+$/.test(name)) allowed.add(name);
	}
	const environment: Record<string, string> = {};
	const stripped: string[] = [];
	for (const [name, value] of Object.entries(runtime.environment)) {
		if (value === undefined) continue;
		if (allowed.has(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) environment[name] = value;
		else stripped.push(name);
	}
	environment.HOME ??= runtime.homeDirectory;
	return { environment, stripped: stripped.sort() };
}

function visibleOutput(stdout: string, stderr: string, overflowPath?: string): string {
	const sections: string[] = [];
	if (stdout.length > 0) sections.push(stdout);
	if (stderr.length > 0) sections.push(`${sections.length > 0 ? "\n" : ""}[stderr]\n${stderr}`);
	if (overflowPath) sections.push(`${sections.length > 0 ? "\n" : ""}[output truncated; full log: ${overflowPath}]`);
	return sections.join("") || "(no output)";
}

export function createBashTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
}): AgentTool<typeof BashParameters> {
	return {
		name: "bash",
		description: "Run one non-interactive, non-login Shell command with host-user authority from the Workspace.",
		parameters: BashParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const temporaryDirectory = join(options.runtime.homeDirectory, ".coda", "tmp");
			await options.fileSystem.makeDirectory(temporaryDirectory, { recursive: true, mode: 0o700 });
			await options.fileSystem.setMode(temporaryDirectory, 0o700);
			const safeInvocationId = context.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
			const overflowPath = join(temporaryDirectory, `shell-${safeInvocationId}.log`);
			const inherited = shellEnvironment(options.runtime, options.settings.shellEnvironmentAllowlist ?? []);
			const configuredShell = options.runtime.environment.SHELL;
			const executable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
			const result = await options.processRunner.run({
				executable,
				args: ["-c", arguments_.command],
				cwd: options.workspace.root,
				environment: inherited.environment,
				signal: context.signal,
				timeoutMs: arguments_.timeoutMs ?? 120_000,
				maxOutputBytes: 50 * 1024,
				maxOutputLines: 2_000,
				overflowPath,
			});
			return {
				content: visibleOutput(result.stdout, result.stderr, result.overflowPath),
				isError: result.timedOut || result.exitCode !== 0,
				details: {
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					truncated: result.truncated,
					overflowPath: result.overflowPath,
					cwd: options.workspace.root,
					strippedEnvironmentVariables: inherited.stripped,
				},
			};
		},
	};
}
