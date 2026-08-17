import type { AgentTool, ToolExecutionOutput } from "@coda/agent";
import { type JsonValue, Type } from "@coda/ai";
import { type HostProcessRuntime, hostProcessEnvironment } from "../host/runtime.ts";
import type { Workspace } from "../host/workspace.ts";
import type { ProcessSessionManager, ProcessSessionSnapshot, ProcessSessionState } from "./process-session-manager.ts";

const ProcessStartParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
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

function observationStatus(state: ProcessSessionState): "ok" | "error" {
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
		...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
		...(snapshot.signal !== undefined ? { signal: snapshot.signal } : {}),
	};
}

function snapshotContent(snapshot: ProcessSessionSnapshot, includeOutput: boolean): string {
	const lines = [`Process ${snapshot.processId} is ${snapshot.state}.`];
	if (includeOutput) lines.push(snapshot.output || "(no new output)");
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
		details: snapshot,
	};
}

export function createProcessTools(options: {
	readonly workspace: Workspace;
	readonly manager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly runtime: HostProcessRuntime;
	readonly sessionId: string;
}): readonly AgentTool[] {
	const start: AgentTool<typeof ProcessStartParameters> = {
		name: "process_start",
		description:
			"Start one background non-interactive Shell process directly on the host. Returns an opaque process-local identity for polling, stdin, or stop.",
		parameters: ProcessStartParameters,
		replaySafety: "never",
		execute: async (arguments_, context): Promise<ToolExecutionOutput> => {
			const environment = hostProcessEnvironment(options.runtime);
			try {
				const snapshot = await options.manager.start(
					{
						executable: options.shellExecutable,
						args: ["-c", arguments_.command],
						cwd: options.workspace.root,
						environment,
						signal: context.signal,
						timeoutMs: arguments_.timeoutMs ?? 3_600_000,
					},
					options.sessionId,
				);
				const result = snapshotOutput(snapshot, false);
				return result;
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
						},
					},
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
					status: "error",
					truncated: false,
					facts: snapshotFacts(result.snapshot),
				},
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
