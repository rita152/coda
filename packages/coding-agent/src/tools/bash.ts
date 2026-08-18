import type { AgentTool, ToolExecutionOutput } from "@coda/agent";
import { type JsonValue, Type } from "@coda/ai";
import type { ProcessConfinement } from "@coda/sandbox";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import { type HostProcessRuntime, hostProcessEnvironment } from "../host/runtime.ts";
import type { Workspace } from "../host/workspace.ts";
import { createToolOutputCapture, discardStoredToolOutput, type StoredToolOutput } from "../process/output-store.ts";
import { planShellExecution, SHELL_EXECUTION_FACTS_VERSION } from "./shell-execution.ts";

const SandboxPermissions = Type.Optional(
	Type.Union([
		Type.Literal("use_default"),
		Type.Literal("require_escalated"),
		Type.Literal("with_additional_permissions"),
	]),
);

const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_400_000 })),
		sandbox_permissions: SandboxPermissions,
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
	},
	{ additionalProperties: false },
);

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

export function createBashTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly shellExecutable: string;
	readonly runtime: HostProcessRuntime;
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
}): AgentTool<typeof BashParameters> {
	return {
		name: "bash",
		description:
			"Run one non-interactive Shell command directly on the host. Pipelines use pipefail with an explicitly supported Bash or Zsh dialect; unsupported dialects reject pipelines. Use preview for bounded display without changing exit status. sandbox_permissions defaults to use_default; require_escalated runs unsandboxed after Command Permission allows it.",
		parameters: BashParameters,
		replaySafety: "never",
		execute: async (arguments_, context): Promise<ToolExecutionOutput> => {
			const shellExecution = planShellExecution(options.shellExecutable, arguments_.command);
			if (shellExecution.kind === "reject") {
				return {
					content: shellExecution.diagnostic,
					observation: {
						status: "error",
						truncated: false,
						facts: {
							shellExecutionFactsVersion: SHELL_EXECUTION_FACTS_VERSION,
							exitCode: 2,
							exitCodeScope: "coda-shell-policy",
							shell: shellExecution.shell,
							shellDialect: shellExecution.shellDialect,
							pipelineDetected: shellExecution.pipelineDetected,
							pipelineStatusMode: shellExecution.pipelineStatusMode,
							outputRefAvailable: false,
							outputRefComplete: false,
						},
					},
					details: {
						exitCode: 2,
						signal: null,
						timedOut: false,
						truncated: false,
						cwd: options.workspace.root,
						shell: shellExecution.shell,
						shellDialect: shellExecution.shellDialect,
						pipelineStatusMode: shellExecution.pipelineStatusMode,
						pipelineRejected: true,
						outputRef: undefined,
						outputStoredTruncated: undefined,
					},
				};
			}
			const environment = hostProcessEnvironment(options.runtime);
			let executable = shellExecution.shell;
			let args = shellExecution.args;
			let spawnEnvironment = environment;
			if (options.wrapScript && arguments_.sandbox_permissions !== "require_escalated") {
				try {
					const confined = await options.wrapScript({
						command: arguments_.command,
						shell: shellExecution.shell,
						cwd: options.workspace.root,
						environment,
						commandId: String(context.invocationId),
					});
					if (confined) {
						executable = confined.executable;
						args = confined.args;
						spawnEnvironment = confined.environment;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: message,
						observation: {
							status: "error",
							truncated: false,
							facts: {
								shellExecutionFactsVersion: SHELL_EXECUTION_FACTS_VERSION,
								exitCode: 2,
								exitCodeScope: "coda-shell-policy",
								confinementFailed: true,
								outputRefAvailable: false,
								outputRefComplete: false,
							},
						},
						details: {
							exitCode: 2,
							signal: null,
							timedOut: false,
							truncated: false,
							cwd: options.workspace.root,
							confinementFailed: true,
						},
					};
				}
			}
			const capture = await createToolOutputCapture(
				options.fileSystem,
				options.runtime.homeDirectory,
				context.invocationId,
			);
			let result: Awaited<ReturnType<ProcessRunner["run"]>>;
			let stored: StoredToolOutput | undefined;
			let observedStderr = false;
			try {
				result = await options.processRunner.run({
					executable,
					args: [...args],
					cwd: options.workspace.root,
					environment: spawnEnvironment,
					signal: context.signal,
					timeoutMs: arguments_.timeoutMs ?? 120_000,
					maxOutputBytes: 50 * 1024,
					maxOutputLines: 2_000,
					onOutput: (chunk) => {
						if (chunk.channel === "stderr" && chunk.text.length > 0) observedStderr = true;
						capture?.append(chunk);
					},
				});
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
			const status = result.timedOut || result.exitCode !== 0 ? "error" : "ok";
			const facts: Record<string, JsonValue> = {
				shellExecutionFactsVersion: SHELL_EXECUTION_FACTS_VERSION,
				exitCode: result.exitCode,
				exitCodeScope: "shell-command",
				shell: shellExecution.shell,
				shellDialect: shellExecution.shellDialect,
				pipelineDetected: shellExecution.pipelineDetected,
				pipelineStatusMode: shellExecution.pipelineStatusMode,
				signal: result.signal,
				timedOut: result.timedOut,
				stderrPresent: observedStderr || result.stderr.length > 0,
				outputRefAvailable: stored !== undefined,
				outputRefComplete: stored !== undefined && stored.storedTruncated !== true,
				...(arguments_.preview
					? { previewMode: arguments_.preview.mode, previewLines: arguments_.preview.lines, previewComplete }
					: {}),
			};
			return {
				content: output,
				observation: {
					status,
					truncated,
					facts,
					...(stored ? { outputRef: stored.outputRef } : {}),
				},
				details: {
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					truncated,
					outputRef: stored?.outputRef,
					overflowPath: stored?.overflowPath,
					cwd: options.workspace.root,
					shell: shellExecution.shell,
					shellDialect: shellExecution.shellDialect,
					pipelineStatusMode: shellExecution.pipelineStatusMode,
					preview: arguments_.preview,
					previewComplete,
					outputStoredTruncated: stored?.storedTruncated,
				},
			};
		},
	};
}
