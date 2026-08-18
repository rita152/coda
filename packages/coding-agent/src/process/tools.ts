import type { AgentTool, ToolExecutionOutput } from "@coda/agent";
import { type JsonValue, Type } from "@coda/ai";
import type { ProcessConfinement } from "@coda/sandbox";
import { type HostProcessRuntime, hostProcessEnvironment } from "../host/runtime.ts";
import type { Workspace } from "../host/workspace.ts";
import { toolFailure } from "../tools/failure.ts";
import type { ProcessSessionManager, ProcessSessionSnapshot, ProcessSessionState } from "./process-session-manager.ts";

const ProcessParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("start"), Type.Literal("poll"), Type.Literal("write"), Type.Literal("stop")]),
		command: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Required for action=start. The non-interactive Shell command to run.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 86_400_000,
				description: "Optional lifetime limit for action=start.",
			}),
		),
		processId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "Required for action=poll, write, and stop.",
			}),
		),
		input: Type.Optional(
			Type.String({
				description: "Required for action=write. Bytes to write to the process stdin.",
			}),
		),
		closeStdin: Type.Optional(
			Type.Boolean({
				description: "For action=write, close stdin after writing.",
			}),
		),
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

function snapshotOutput(
	snapshot: ProcessSessionSnapshot,
	includeOutput: boolean,
	details: Record<string, unknown> = {},
): ToolExecutionOutput {
	const status = observationStatus(snapshot.state);
	return {
		content: snapshotContent(snapshot, includeOutput),
		observation: {
			status,
			truncated: snapshot.truncated,
			facts: snapshotFacts(snapshot),
			...(snapshot.outputRef ? { outputRef: snapshot.outputRef } : {}),
		},
		details: { ...snapshot, ...details },
	};
}

function requiredProcessId(action: string, processId: string | undefined): string | ToolExecutionOutput {
	if (typeof processId !== "string" || processId.length === 0) {
		return toolFailure(`process action=${action} requires processId`, { code: "invalid_arguments", action });
	}
	return processId;
}

export function createProcessTool(options: {
	readonly workspace: Workspace;
	readonly manager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly runtime: HostProcessRuntime;
	readonly sessionId: string;
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
}): AgentTool<typeof ProcessParameters> {
	return {
		name: "process",
		description:
			"Control one background non-interactive Shell process on the host. action=start runs a command and returns an opaque process-local identity. action=poll reads the next bounded output increment. action=write writes stdin. action=stop stops the process and its descendants.",
		parameters: ProcessParameters,
		replaySafety: "never",
		execute: async (arguments_, context): Promise<ToolExecutionOutput> => {
			switch (arguments_.action) {
				case "start":
					return startProcess(options, arguments_.command, arguments_.timeoutMs, context);
				case "poll": {
					const processId = requiredProcessId("poll", arguments_.processId);
					if (typeof processId !== "string") return processId;
					context.signal.throwIfAborted();
					return snapshotOutput(await options.manager.poll(processId), true);
				}
				case "write": {
					const processId = requiredProcessId("write", arguments_.processId);
					if (typeof processId !== "string") return processId;
					if (typeof arguments_.input !== "string") {
						return toolFailure("process action=write requires input", {
							code: "invalid_arguments",
							action: "write",
						});
					}
					context.signal.throwIfAborted();
					const result = await options.manager.write(processId, arguments_.input, arguments_.closeStdin ?? false);
					if (result.accepted) {
						const output = snapshotOutput(result.snapshot, false);
						return {
							...output,
							content: `Wrote ${Buffer.byteLength(arguments_.input)} bytes to process ${processId}${arguments_.closeStdin ? " and closed stdin" : ""}.`,
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
				}
				case "stop": {
					const processId = requiredProcessId("stop", arguments_.processId);
					if (typeof processId !== "string") return processId;
					context.signal.throwIfAborted();
					return snapshotOutput(await options.manager.stop(processId), true);
				}
			}
		},
	};
}

async function startProcess(
	options: {
		readonly workspace: Workspace;
		readonly manager: ProcessSessionManager;
		readonly shellExecutable: string;
		readonly runtime: HostProcessRuntime;
		readonly sessionId: string;
		readonly wrapScript?: (
			request: Parameters<ProcessConfinement["wrapScript"]>[0],
		) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
	},
	command: string | undefined,
	timeoutMs: number | undefined,
	context: Parameters<AgentTool["execute"]>[1],
): Promise<ToolExecutionOutput> {
	if (typeof command !== "string" || command.length === 0) {
		return toolFailure("process action=start requires command", { code: "invalid_arguments", action: "start" });
	}
	const environment = hostProcessEnvironment(options.runtime);
	try {
		const confined = options.wrapScript
			? await options.wrapScript({
					command,
					shell: options.shellExecutable,
					cwd: options.workspace.root,
					environment,
					commandId: String(context.invocationId),
				})
			: undefined;
		const spawn = confined ?? {
			executable: options.shellExecutable,
			args: ["-c", command] as const,
			environment,
		};
		const snapshot = await options.manager.start(
			{
				executable: spawn.executable,
				args: [...spawn.args],
				cwd: options.workspace.root,
				environment: spawn.environment,
				signal: context.signal,
				timeoutMs: timeoutMs ?? 3_600_000,
			},
			options.sessionId,
		);
		return snapshotOutput(snapshot, false, { retainLease: snapshot.state === "running" });
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
}
