import type { AgentTool, ToolExecutionOutput } from "@coda/agent";
import { type JsonValue, Type } from "@coda/ai";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import { modelProcessDenialNotice, modelShellEnvironment } from "../tools/bash.ts";
import type { Workspace } from "../workspace.ts";
import type { ProcessSessionManager, ProcessSessionSnapshot, ProcessSessionState } from "./process-session-manager.ts";

const ProcessStartParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
		sandbox_permissions: Type.Optional(
			Type.Union(
				[
					Type.Literal("use_default"),
					Type.Literal("require_escalated"),
					Type.Literal("with_additional_permissions"),
				],
				{
					description:
						"Per-process sandbox override. Defaults to `use_default`; use `with_additional_permissions` with `additional_permissions`, or `require_escalated` for unsandboxed execution.",
				},
			),
		),
		justification: Type.Optional(
			Type.String({ description: "User-facing approval question for `require_escalated`; omit otherwise." }),
		),
		prefix_rule: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Reusable approval prefix for `command`, only with `sandbox_permissions: "require_escalated"`; for example ["npm", "run"].',
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
						'Sandboxed filesystem or network access for this process; only with `sandbox_permissions: "with_additional_permissions"`.',
				},
			),
		),
	},
	{ additionalProperties: false },
);

const ProcessIdentityParameters = Type.Object(
	{ processId: Type.String({ minLength: 1, maxLength: 256 }) },
	{ additionalProperties: false },
);

const ProcessWriteParameters = Type.Object(
	{
		processId: Type.String({ minLength: 1, maxLength: 256 }),
		input: Type.String(),
		closeStdin: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

function observationStatus(state: ProcessSessionState): "ok" | "error" | "denied" {
	if (state === "denied") return "denied";
	if (state === "failed" || state === "stale") return "error";
	return "ok";
}

function snapshotFacts(snapshot: ProcessSessionSnapshot): Record<string, JsonValue> {
	return {
		processId: snapshot.processId,
		state: snapshot.state,
		timedOut: snapshot.timedOut,
		stderrPresent: snapshot.stderrPresent,
		outputOmitted: snapshot.outputOmitted,
		outputRefAvailable: snapshot.outputRef !== undefined,
		...(snapshot.backend ? { backend: snapshot.backend } : {}),
		...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
		...(snapshot.signal !== undefined ? { signal: snapshot.signal } : {}),
		...(snapshot.denial?.kind === "network"
			? {
					denialKind: "network",
					deniedHost: snapshot.denial.host,
					deniedPort: snapshot.denial.port,
					deniedProtocol: snapshot.denial.protocol,
					requiredPermission: "network",
				}
			: snapshot.denial
				? {
						denialKind: "filesystem",
						...(snapshot.denial.path ? { deniedPath: snapshot.denial.path } : {}),
						requiredPermission: "filesystem",
					}
				: {}),
	};
}

function snapshotContent(snapshot: ProcessSessionSnapshot, includeOutput: boolean): string {
	const lines = [`Process ${snapshot.processId} is ${snapshot.state}.`];
	if (includeOutput) lines.push(snapshot.output || "(no new output)");
	if (snapshot.denial) lines.push(`[${modelProcessDenialNotice(snapshot.denial)}]`);
	if (snapshot.truncated) {
		lines.push(
			snapshot.outputRef
				? `[output omitted; continue with read_tool_output using ref ${JSON.stringify(snapshot.outputRef)}]`
				: "[output omitted; no recoverable output reference is available]",
		);
	}
	return lines.join("\n");
}

function snapshotOutput(snapshot: ProcessSessionSnapshot, includeOutput: boolean): ToolExecutionOutput {
	const status = observationStatus(snapshot.state);
	return {
		content: snapshotContent(snapshot, includeOutput),
		observation: {
			status,
			truncated: snapshot.truncated,
			facts: snapshotFacts(snapshot),
			...(snapshot.outputRef ? { outputRef: snapshot.outputRef } : {}),
		},
		isError: status !== "ok",
		details: snapshot,
	};
}

export function createProcessTools(options: {
	readonly workspace: Workspace;
	readonly manager: ProcessSessionManager;
	readonly permissions: PermissionEngine;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
}): readonly AgentTool[] {
	const start: AgentTool<typeof ProcessStartParameters> = {
		name: "process_start",
		description:
			"Start one background non-interactive Shell process under the active Permission Profile. Returns an opaque process-local identity for polling, stdin, or stop.",
		parameters: ProcessStartParameters,
		replaySafety: "never",
		execute: async (arguments_, context): Promise<ToolExecutionOutput> => {
			const authorization = options.permissions.authorizationFor(context.invocationId);
			if (!authorization) throw new Error("Process execution was not authorized by the Permission Engine");
			const inherited = modelShellEnvironment(options.runtime, options.settings.shellEnvironmentAllowlist ?? []);
			try {
				const snapshot = await options.manager.start(
					{
						executable: options.shellExecutable,
						args: ["-c", arguments_.command],
						cwd: options.workspace.root,
						environment: inherited.environment,
						signal: context.signal,
						timeoutMs: arguments_.timeoutMs ?? 3_600_000,
					},
					{
						readAccessPolicy: authorization.readAccessPolicy,
						managedNetwork: authorization.managedNetwork,
						auditContext: { invocationId: context.invocationId, toolName: "process_start" },
					},
				);
				const result = snapshotOutput(snapshot, false);
				const facts: Record<string, JsonValue> = {
					...result.observation?.facts,
					strippedEnvironmentVariableCount: inherited.stripped.length,
				};
				return {
					...result,
					observation: {
						...result.observation!,
						facts,
					},
				};
			} catch (error) {
				context.signal.throwIfAborted();
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: `Process failed to start: ${message}`,
					observation: {
						status: "error",
						truncated: false,
						facts: {
							state: "failed",
							code: "launch_failed",
							strippedEnvironmentVariableCount: inherited.stripped.length,
						},
					},
					isError: true,
					details: { state: "failed", code: "launch_failed", error: message },
				};
			}
		},
	};
	const poll: AgentTool<typeof ProcessIdentityParameters> = {
		name: "process_poll",
		description: "Read the next bounded stdout/stderr increment and current state for a background process.",
		parameters: ProcessIdentityParameters,
		replaySafety: "never",
		execute: async ({ processId }, context) => {
			context.signal.throwIfAborted();
			return snapshotOutput(await options.manager.poll(processId), true);
		},
	};
	const write: AgentTool<typeof ProcessWriteParameters> = {
		name: "process_write",
		description: "Write bytes to a running background process and optionally close its stdin.",
		parameters: ProcessWriteParameters,
		replaySafety: "never",
		execute: async ({ processId, input, closeStdin }, context) => {
			context.signal.throwIfAborted();
			const result = await options.manager.write(processId, input, closeStdin ?? false);
			if (result.accepted) {
				const output = snapshotOutput(result.snapshot, false);
				return {
					...output,
					content: `Wrote ${Buffer.byteLength(input)} bytes to process ${processId}${closeStdin ? " and closed stdin" : ""}.`,
				};
			}
			return {
				content: `Could not write to process ${processId}: ${result.reason ?? "process is unavailable"}`,
				observation: {
					status: result.snapshot.state === "denied" ? "denied" : "error",
					truncated: false,
					facts: snapshotFacts(result.snapshot),
				},
				isError: true,
				details: { ...result.snapshot, writeAccepted: false, reason: result.reason },
			};
		},
	};
	const stop: AgentTool<typeof ProcessIdentityParameters> = {
		name: "process_stop",
		description: "Stop a background process and all descendants, returning its final bounded output increment.",
		parameters: ProcessIdentityParameters,
		replaySafety: "never",
		execute: async ({ processId }, context) => {
			context.signal.throwIfAborted();
			return snapshotOutput(await options.manager.stop(processId), true);
		},
	};
	return Object.freeze([start, poll, write, stop]);
}
