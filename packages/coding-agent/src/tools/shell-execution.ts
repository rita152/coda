import { basename } from "node:path";

export const SHELL_EXECUTION_FACTS_VERSION = 1;

export type PipelineStatusMode = "pipefail" | "not-applicable" | "rejected";

interface ShellExecutionMetadata {
	readonly shell: string;
	readonly shellDialect: string;
	readonly pipelineDetected: boolean;
	readonly pipelineStatusMode: PipelineStatusMode;
}

export type ShellExecutionPlan =
	| (ShellExecutionMetadata & {
			readonly kind: "execute";
			readonly args: readonly string[];
	  })
	| (ShellExecutionMetadata & {
			readonly kind: "reject";
			readonly diagnostic: string;
	  });

const PIPEFAIL_DIALECTS = new Set(["bash", "zsh"]);

function dialectName(shell: string): string {
	const name = basename(shell).toLowerCase();
	return name.endsWith(".exe") ? name.slice(0, -".exe".length) : name || "unknown";
}

function closingQuote(script: string, start: number, quote: "'" | '"' | "`"): number {
	for (let index = start; index < script.length; index++) {
		const character = script[index]!;
		if (character === "\\" && quote !== "'") {
			index++;
			continue;
		}
		if (character === quote) return index;
	}
	return script.length;
}

function containsUnescapedPipelineToken(script: string): boolean {
	for (let index = 0; index < script.length; index++) {
		if (script[index] === "\\") {
			index++;
			continue;
		}
		if (script[index] !== "|") continue;
		if (script[index + 1] === "|") {
			index++;
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Conservatively identifies shell pipeline syntax without treating a plain
 * logical OR or a literal quoted pipe as a pipeline. Ambiguous expansions are
 * classified as pipelines so an unsupported dialect fails closed.
 */
function containsPotentialPipeline(script: string): boolean {
	let atWordStart = true;
	for (let index = 0; index < script.length; index++) {
		const character = script[index]!;
		if (character === "\\") {
			index++;
			atWordStart = false;
			continue;
		}
		if (character === "'") {
			index = closingQuote(script, index + 1, "'");
			atWordStart = false;
			continue;
		}
		if (character === '"') {
			const end = closingQuote(script, index + 1, '"');
			const quoted = script.slice(index + 1, end);
			if ((quoted.includes("$(") || quoted.includes("`")) && containsUnescapedPipelineToken(quoted)) {
				return true;
			}
			index = end;
			atWordStart = false;
			continue;
		}
		if (character === "`") {
			const end = closingQuote(script, index + 1, "`");
			if (containsPotentialPipeline(script.slice(index + 1, end))) return true;
			index = end;
			atWordStart = false;
			continue;
		}
		if (character === "#" && atWordStart) {
			const newline = script.indexOf("\n", index + 1);
			if (newline < 0) return false;
			index = newline;
			atWordStart = true;
			continue;
		}
		if (character === "|") {
			if (script[index + 1] === "|") {
				index++;
				atWordStart = true;
				continue;
			}
			return true;
		}
		atWordStart = /\s/u.test(character) || ";&()<>".includes(character);
	}
	return false;
}

export function planShellExecution(shell: string, command: string): ShellExecutionPlan {
	const shellDialect = dialectName(shell);
	const pipelineDetected = containsPotentialPipeline(command);
	if (PIPEFAIL_DIALECTS.has(shellDialect)) {
		return Object.freeze({
			kind: "execute",
			shell,
			shellDialect,
			pipelineDetected,
			pipelineStatusMode: "pipefail",
			args: Object.freeze(["-o", "pipefail", "-c", command]),
		});
	}
	if (!pipelineDetected) {
		return Object.freeze({
			kind: "execute",
			shell,
			shellDialect,
			pipelineDetected,
			pipelineStatusMode: "not-applicable",
			args: Object.freeze(["-c", command]),
		});
	}
	return Object.freeze({
		kind: "reject",
		shell,
		shellDialect,
		pipelineDetected,
		pipelineStatusMode: "rejected",
		diagnostic: `Coda refused to execute this pipeline with ${JSON.stringify(shell)} (dialect ${JSON.stringify(shellDialect)}) because that shell is not explicitly supported with pipefail. Configure SHELL to an absolute Bash or Zsh executable, or remove the pipeline and use the Bash Tool preview option for output limiting.`,
	});
}
