import { type AgentEvent, deepFreeze } from "@coda/agent";
import type { CompletionTemporalSnapshot } from "./types.ts";

const MAX_COMMAND_CHARACTERS = 512;

interface MutableRunActivity {
	readonly candidates: Map<string, CompletionTemporalSnapshot["terminalCandidate"]>;
	terminalCandidate?: CompletionTemporalSnapshot["terminalCandidate"];
}

/** Tracks terminal assistant candidates; Tool chronology comes from public RunEvidence operations. */
export class CompletionActivityProjection {
	readonly #runs = new Map<string, MutableRunActivity>();

	accept(event: AgentEvent): void {
		if (event.type === "run_start") {
			this.#runs.set(event.runId, { candidates: new Map() });
			return;
		}
		const run = this.#runs.get(event.runId);
		if (!run) return;
		switch (event.type) {
			case "turn_start":
				run.terminalCandidate = undefined;
				break;
			case "message_end": {
				const hasToolCalls = event.message.message.content.some(({ type }) => type === "toolCall");
				if (hasToolCalls) {
					run.candidates.delete(event.turnId);
					break;
				}
				run.candidates.set(event.turnId, {
					messageId: event.message.id,
					turnId: event.turnId,
					sequence: event.sequence,
				});
				break;
			}
			case "turn_end":
				run.terminalCandidate = event.outcome === "success" ? run.candidates.get(event.turnId) : undefined;
				run.candidates.delete(event.turnId);
				break;
		}
	}

	snapshot(runId: string): CompletionTemporalSnapshot {
		const candidate = this.#runs.get(runId)?.terminalCandidate;
		return candidate ? deepFreeze({ terminalCandidate: { ...candidate } }) : Object.freeze({});
	}

	delete(runId: string): void {
		this.#runs.delete(runId);
	}
}

export type CompletionShellCommandEffect = "verification" | "read_only" | "potential_mutation";

export function classifyShellCommand(command: string): CompletionShellCommandEffect {
	const normalized = normalizeCommand(command);
	if (!normalized) return "read_only";
	if (hasShellControl(normalized)) return "potential_mutation";
	if (isVerificationCommand(normalized)) return "verification";
	if (isReadOnlyCommand(normalized)) return "read_only";
	return "potential_mutation";
}

export function sanitizeCompletionCommand(command: string): string {
	return bounded(
		normalizeCommand(command)
			.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/giu, "$1=[REDACTED]")
			.replace(/(--?(?:api[-_]?key|token|password|secret)(?:=|\s+))([^\s]+)/giu, "$1[REDACTED]")
			.replace(/:\/\/[^/@\s]+@/gu, "://[REDACTED]@"),
		MAX_COMMAND_CHARACTERS,
	);
}

function isVerificationCommand(command: string): boolean {
	return (
		/^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|build|typecheck|type-check))(?:\s|$)/u.test(command) ||
		/^(?:npx\s+)?(?:vitest|jest|mocha|ava)(?:\s|$)/u.test(command) ||
		/^(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)/u.test(command) ||
		/^cargo\s+(?:test|check|clippy)(?:\s|$)/u.test(command) ||
		/^go\s+test(?:\s|$)/u.test(command) ||
		/^(?:dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/u.test(command) ||
		/^make\s+(?:test|check|lint)(?:\s|$)/u.test(command) ||
		/^(?:node\s+--test|tsc(?:\s|$)|biome\s+check|eslint(?:\s|$))/u.test(command) ||
		/^git\s+diff\s+--check(?:\s|$)/u.test(command)
	);
}

function isReadOnlyCommand(command: string): boolean {
	return /^(?:pwd|ls|find|fd|rg|grep|cat|head|tail|wc|stat|file|which|whereis|uname|env|printenv|git\s+(?:status|diff|show|log|rev-parse|ls-files|branch))(?:\s|$)/u.test(
		command,
	);
}

function hasShellControl(command: string): boolean {
	return /(?:\r|\n|\|\||&&|[|;<>`]|\$\()/u.test(command);
}

function normalizeCommand(command: string): string {
	return [...command]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? " " : character;
		})
		.join("")
		.trim()
		.replace(/\s+/gu, " ");
}

function bounded(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
