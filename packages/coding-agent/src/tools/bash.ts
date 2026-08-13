import type { AgentTool } from "@coda/agent";
import { type JsonValue, Type } from "@coda/ai";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { PermissionAuditSink } from "../permissions/audit.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";
import { createToolOutputCapture, discardStoredToolOutput, type StoredToolOutput } from "./tool-output-store.ts";

const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_400_000 })),
		preview: Type.Optional(
			Type.Object(
				{
					mode: Type.Union([Type.Literal("head"), Type.Literal("tail")]),
					lines: Type.Integer({ minimum: 1, maximum: 2_000 }),
				},
				{
					additionalProperties: false,
					description:
						"Select a model-visible head or tail preview after execution. This never changes the Shell command or its exit status.",
				},
			),
		),
		sandbox_permissions: Type.Optional(
			Type.Union(
				[
					Type.Literal("use_default"),
					Type.Literal("require_escalated"),
					Type.Literal("with_additional_permissions"),
				],
				{
					description:
						"Per-command permission request. Defaults to `use_default`; use `with_additional_permissions` with `additional_permissions`, or `require_escalated` for explicit command approval. Restricted read roots remain enforced.",
				},
			),
		),
		justification: Type.Optional(
			Type.String({
				description: "User-facing approval question for an explicit permission request; omit otherwise.",
			}),
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

export function modelShellEnvironment(
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

function visibleOutput(stdout: string, stderr: string): string {
	const sections: string[] = [];
	if (stdout.length > 0) sections.push(stdout);
	if (stderr.length > 0) sections.push(`${sections.length > 0 ? "\n" : ""}[stderr]\n${stderr}`);
	return sections.join("") || "(no output)";
}

function lineChunks(value: string): string[] {
	return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function selectPreview(
	value: string,
	preview: { readonly mode: "head" | "tail"; readonly lines: number },
): { readonly text: string; readonly omitted: boolean } {
	const lines = lineChunks(value);
	const selected = preview.mode === "head" ? lines.slice(0, preview.lines) : lines.slice(-preview.lines);
	return { text: selected.join("") || "(no output)", omitted: lines.length > selected.length };
}

async function storedText(fileSystem: FileSystem, stored: StoredToolOutput | undefined): Promise<string | undefined> {
	if (!stored || stored.storedBytes === 0) return undefined;
	try {
		return new TextDecoder("utf-8").decode(await fileSystem.readFile(stored.overflowPath));
	} catch {
		return undefined;
	}
}

function capturedVisibleOutput(value: string): string {
	return value.startsWith("[stdout]\n") ? value.slice("[stdout]\n".length) : value;
}

export function modelProcessDenialNotice(
	denial: NonNullable<Awaited<ReturnType<ModelProcessRunner["run"]>>["denial"]>,
): string {
	if (denial.kind === "network") {
		return `Sandbox denied network access to ${denial.protocol}://${denial.host}:${denial.port}: ${denial.reason}. If this access is intended, retry with sandbox_permissions "with_additional_permissions" and additional_permissions.network.enabled true.`;
	}
	return `Sandbox denied filesystem access${denial.path ? ` to ${denial.path}` : ""}: ${denial.reason}. If this access is intended, retry with the narrow path under additional_permissions.file_system.`;
}

export function createBashTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
	readonly onAudit?: PermissionAuditSink;
}): AgentTool<typeof BashParameters> {
	return {
		name: "bash",
		description:
			"Run one non-interactive Shell command under the active Permission Profile. Use preview instead of piping to head/tail so display limiting cannot mask the command exit status.",
		parameters: BashParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const authorization = options.permissions.authorizationFor(context.invocationId);
			if (!authorization) throw new Error("Bash execution was not authorized by the Permission Engine");
			const inherited = modelShellEnvironment(options.runtime, options.settings.shellEnvironmentAllowlist ?? []);
			const capture = await createToolOutputCapture(
				options.fileSystem,
				options.runtime.homeDirectory,
				context.invocationId,
			);
			let result: Awaited<ReturnType<ModelProcessRunner["run"]>>;
			let stored: StoredToolOutput | undefined;
			let observedStderr = false;
			try {
				result = await options.processRunner.run(
					{
						executable: options.shellExecutable,
						args: ["-c", arguments_.command],
						cwd: options.workspace.root,
						environment: inherited.environment,
						signal: context.signal,
						timeoutMs: arguments_.timeoutMs ?? 120_000,
						maxOutputBytes: 50 * 1024,
						maxOutputLines: 2_000,
						onOutput: (chunk) => {
							if (chunk.channel === "stderr" && chunk.text.length > 0) observedStderr = true;
							capture?.append(chunk);
						},
					},
					{
						readAccessPolicy: authorization.readAccessPolicy,
						managedNetwork: authorization.managedNetwork,
						auditContext: { invocationId: context.invocationId, toolName: "bash" },
						audit: options.onAudit,
					},
				);
				stored = await capture?.finish();
			} catch (error) {
				stored = await capture?.finish();
				if (stored) await discardStoredToolOutput(options.fileSystem, stored);
				throw error;
			}
			if (stored?.storedBytes === 0 && (result.truncated || result.stdout.length > 0 || result.stderr.length > 0)) {
				await discardStoredToolOutput(options.fileSystem, stored);
				stored = undefined;
			}

			const bounded = visibleOutput(result.stdout, result.stderr);
			let output = bounded;
			let previewComplete = true;
			let truncated = result.truncated;
			if (arguments_.preview) {
				const captured =
					arguments_.preview.mode === "tail" ? await storedText(options.fileSystem, stored) : undefined;
				const source = captured === undefined ? bounded : capturedVisibleOutput(captured);
				const preview = selectPreview(source, arguments_.preview);
				output = preview.text;
				previewComplete =
					captured !== undefined
						? stored?.storedTruncated !== true
						: !result.truncated ||
							(arguments_.preview.mode === "head" && lineChunks(bounded).length > arguments_.preview.lines);
				truncated = preview.omitted || !previewComplete;
				if (!previewComplete && arguments_.preview.mode === "tail") {
					output = `${output}\n[tail preview is incomplete because full output capture was unavailable]`;
				}
			}
			if (stored && !truncated) {
				await discardStoredToolOutput(options.fileSystem, stored);
				stored = undefined;
			}
			if (truncated) {
				output += stored
					? `\n[output omitted; continue with read_tool_output using ref ${JSON.stringify(stored.outputRef)}]`
					: "\n[output omitted; no recoverable output reference is available]";
			}
			const status = result.denial ? "denied" : result.timedOut || result.exitCode !== 0 ? "error" : "ok";
			const facts: Record<string, JsonValue> = {
				exitCode: result.exitCode,
				exitCodeScope: "shell-command",
				signal: result.signal,
				timedOut: result.timedOut,
				stderrPresent: observedStderr || result.stderr.length > 0,
				backend: result.backend,
				outputRefAvailable: stored !== undefined,
				outputRefComplete: stored !== undefined && stored.storedTruncated !== true,
				strippedEnvironmentVariableCount: inherited.stripped.length,
				...(arguments_.preview
					? { previewMode: arguments_.preview.mode, previewLines: arguments_.preview.lines, previewComplete }
					: {}),
				...(result.denial?.kind === "network"
					? {
							denialKind: "network",
							deniedHost: result.denial.host,
							deniedPort: result.denial.port,
							deniedProtocol: result.denial.protocol,
							requiredPermission: "network",
						}
					: result.denial
						? {
								denialKind: "filesystem",
								...(result.denial.path ? { deniedPath: result.denial.path } : {}),
								requiredPermission: "filesystem",
							}
						: {}),
			};
			return {
				content: result.denial ? `${output}\n[${modelProcessDenialNotice(result.denial)}]` : output,
				observation: {
					status,
					truncated,
					facts,
					...(stored ? { outputRef: stored.outputRef } : {}),
				},
				isError: status !== "ok",
				details: {
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					truncated,
					outputRef: stored?.outputRef,
					overflowPath: stored?.overflowPath,
					cwd: options.workspace.root,
					strippedEnvironmentVariableCount: inherited.stripped.length,
					backend: result.backend,
					denial: result.denial,
					preview: arguments_.preview,
					previewComplete,
					outputStoredTruncated: stored?.storedTruncated,
				},
			};
		},
	};
}
