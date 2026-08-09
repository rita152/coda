import { join } from "node:path";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";

const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
		sandbox_permissions: Type.Optional(
			Type.Union(
				[
					Type.Literal("use_default"),
					Type.Literal("require_escalated"),
					Type.Literal("with_additional_permissions"),
				],
				{
					description:
						"Per-command sandbox override. Defaults to `use_default`; use `with_additional_permissions` with `additional_permissions`, or `require_escalated` for unsandboxed execution.",
				},
			),
		),
		justification: Type.Optional(
			Type.String({ description: "User-facing approval question for `require_escalated`; omit otherwise." }),
		),
		prefix_rule: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Reusable approval prefix for `command`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
			}),
		),
		additional_permissions: Type.Optional(
			Type.Object(
				{
					network: Type.Optional(
						Type.Object({ enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
					),
					file_system: Type.Optional(
						Type.Object(
							{
								read: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
								write: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
							},
							{ additionalProperties: false },
						),
					),
				},
				{
					additionalProperties: false,
					description:
						'Sandboxed filesystem or network access for this command; only with `sandbox_permissions: "with_additional_permissions"`.',
				},
			),
		),
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

function denialNotice(denial: NonNullable<Awaited<ReturnType<ModelProcessRunner["run"]>>["denial"]>): string {
	if (denial.kind === "network") {
		return `Sandbox denied network access to ${denial.protocol}://${denial.host}:${denial.port}: ${denial.reason}`;
	}
	return `Sandbox denied filesystem access${denial.path ? ` to ${denial.path}` : ""}: ${denial.reason}`;
}

export function createBashTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
}): AgentTool<typeof BashParameters> {
	return {
		name: "bash",
		description: "Run one non-interactive Shell command under the active Permission Profile.",
		parameters: BashParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const temporaryDirectory = join(options.runtime.homeDirectory, ".coda", "tmp");
			await options.fileSystem.makeDirectory(temporaryDirectory, { recursive: true, mode: 0o700 });
			await options.fileSystem.setMode(temporaryDirectory, 0o700);
			const safeInvocationId = context.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
			const overflowPath = join(temporaryDirectory, `shell-${safeInvocationId}.log`);
			const inherited = shellEnvironment(options.runtime, options.settings.shellEnvironmentAllowlist ?? []);
			const authorization = options.permissions.authorizationFor(context.invocationId);
			if (!authorization) throw new Error("Bash execution was not authorized by the Permission Engine");
			const result = await options.processRunner.run(
				{
					executable: options.shellExecutable,
					args: ["-c", arguments_.command],
					cwd: options.workspace.root,
					environment: inherited.environment,
					signal: context.signal,
					timeoutMs: arguments_.timeoutMs ?? 120_000,
					maxOutputBytes: 50 * 1024,
					maxOutputLines: 2_000,
					overflowPath,
				},
				{
					policy: authorization.policy,
					managedNetwork: authorization.managedNetwork,
					auditContext: { invocationId: context.invocationId, toolName: "bash" },
				},
			);
			const output = visibleOutput(result.stdout, result.stderr, result.overflowPath);
			return {
				content: result.denial ? `${output}\n[${denialNotice(result.denial)}]` : output,
				isError: Boolean(result.denial) || result.timedOut || result.exitCode !== 0,
				details: {
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					truncated: result.truncated,
					overflowPath: result.overflowPath,
					cwd: options.workspace.root,
					strippedEnvironmentVariables: inherited.stripped,
					backend: result.backend,
					denial: result.denial,
				},
			};
		},
	};
}
