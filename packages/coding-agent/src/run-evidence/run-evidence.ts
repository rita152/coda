import type { AgentEvent, ToolInvocation } from "@coda/agent";
import { resolveToolObservation, type ToolObservation, type ToolResultMessage, type Usage } from "@coda/ai";

const MAX_PATHS = 50;
const MAX_COMMANDS = 32;
const MAX_TOOL_ISSUES = 64;
const MAX_UNRESOLVED_FAILURES = 64;
const MAX_PATH_CHARACTERS = 256;
const MAX_COMMAND_CHARACTERS = 512;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_ID_CHARACTERS = 128;
const MAX_TOOL_NAME_CHARACTERS = 128;

const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

export type RunEvidenceOutcome = "success" | "error" | "aborted" | "interrupted";

export interface RunEvidenceCommand {
	readonly invocationId: string;
	readonly command: string;
	readonly status: ToolObservation["status"];
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly truncated: boolean;
}

export interface RunEvidenceToolIssue {
	readonly invocationId: string;
	readonly toolName: string;
	readonly status: ToolObservation["status"];
	readonly settlement: "returned" | "threw" | "aborted" | null;
	readonly truncated: boolean;
	readonly outputRecoverable: boolean;
	readonly reason: string | null;
}

export interface RunEvidenceFailure {
	readonly kind: "attempt" | "tool" | "run";
	readonly id: string;
	readonly status: "error" | "denied" | "aborted" | "interrupted";
	readonly summary: string;
}

export interface RunEvidenceUsage {
	readonly attempts: number;
	readonly retries: number;
	readonly discardedAttempts: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cacheWrite1hTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly currency: "USD";
		readonly status: "complete" | "partial" | "unavailable";
		/** Null unless every completed Attempt carried historical price data. */
		readonly totalUsd: number | null;
		/** Sum of recorded prices; useful when status is partial. */
		readonly knownTotalUsd: number;
		readonly pricedAttempts: number;
		readonly unpricedAttempts: number;
	};
}

/** Stable JSONL envelope emitted after one completed Run. */
export interface RunEvidenceEnvelope {
	readonly schemaVersion: 1;
	readonly type: "run_evidence";
	readonly runId: string;
	readonly outcome: RunEvidenceOutcome;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly elapsedMs: number;
	readonly paths: {
		readonly inspected: readonly string[];
		readonly changed: readonly string[];
		readonly omitted: {
			readonly inspected: number;
			readonly changed: number;
		};
	};
	readonly commands: readonly RunEvidenceCommand[];
	readonly toolIssues: readonly RunEvidenceToolIssue[];
	readonly unresolvedFailures: readonly RunEvidenceFailure[];
	readonly usage: RunEvidenceUsage;
	readonly omitted: {
		readonly commands: number;
		readonly toolIssues: number;
		readonly unresolvedFailures: number;
	};
}

/** Minimal structural view of a private Session Record used for reconstruction. */
export interface RunEvidenceSessionRecord {
	readonly type: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly runId?: string;
	readonly turnId?: string;
	readonly attemptId?: string;
	readonly payload: unknown;
}

interface UsageSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h: number;
	readonly reasoning: number;
	readonly totalTokens: number;
	readonly costTotal?: number;
}

interface AttemptEvidence {
	readonly id: string;
	readonly order: number;
	readonly outcome: "success" | "error" | "aborted";
	readonly discarded: boolean;
	readonly usage: UsageSnapshot;
	readonly error?: string;
}

interface ObservationEvidence {
	readonly status: ToolObservation["status"];
	readonly truncated: boolean;
	readonly outputRecoverable: boolean;
	readonly code?: string;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly timedOut: boolean;
}

interface ToolEvidence {
	readonly invocationId: string;
	readonly toolName: string;
	readonly order: number;
	readonly pathKind?: "inspected" | "changed";
	readonly path?: string;
	readonly command?: string;
	settlement?: "returned" | "threw" | "aborted";
	outcome?: "success" | "error" | "aborted" | "rejected" | "interrupted";
	rejectionReason?: string;
	observation?: ObservationEvidence;
}

interface RunState {
	readonly runId: string;
	startedAt: number;
	readonly attempts: Map<string, AttemptEvidence>;
	readonly retriedAttempts: Set<string>;
	retries: number;
	readonly tools: Map<string, ToolEvidence>;
}

interface FinishedRun {
	readonly outcome: RunEvidenceOutcome;
	readonly completedAt: number;
	readonly failure?: { readonly kind: string; readonly message: string };
	readonly interruptionReason?: string;
}

class EvidenceReducer {
	readonly #runs = new Map<string, RunState>();

	startRun(runId: string, timestamp: number): void {
		const existing = this.#runs.get(runId);
		if (existing) {
			existing.startedAt = timestamp;
			return;
		}
		this.#runs.set(runId, createRunState(runId, timestamp));
	}

	finishAttempt(
		runId: string,
		timestamp: number,
		attempt: {
			readonly id: string;
			readonly order: number;
			readonly outcome: "success" | "error" | "aborted";
			readonly discarded: boolean;
			readonly usage: unknown;
			readonly error?: unknown;
		},
	): void {
		const state = this.#ensureRun(runId, timestamp);
		state.attempts.set(attempt.id, {
			id: boundedText(attempt.id, MAX_ID_CHARACTERS),
			order: attempt.order,
			outcome: attempt.outcome,
			discarded: attempt.discarded,
			usage: usageSnapshot(attempt.usage),
			...(typeof attempt.error === "string" ? { error: safeText(attempt.error, MAX_SUMMARY_CHARACTERS) } : {}),
		});
	}

	noteRetry(runId: string, timestamp: number, attemptId: string): void {
		const state = this.#ensureRun(runId, timestamp);
		state.retriedAttempts.add(attemptId);
		state.retries++;
	}

	startTool(runId: string, timestamp: number, order: number, invocation: unknown): void {
		const state = this.#ensureRun(runId, timestamp);
		const seed = toolSeed(invocation, order);
		if (seed) state.tools.set(seed.invocationId, seed);
	}

	finishTool(
		runId: string,
		timestamp: number,
		order: number,
		invocation: unknown,
		finish: {
			readonly settlement?: unknown;
			readonly outcome?: unknown;
			readonly rejectionReason?: unknown;
			readonly observation?: ObservationEvidence;
		},
	): void {
		const state = this.#ensureRun(runId, timestamp);
		const seed = toolSeed(invocation, order);
		if (!seed) return;
		const existing = state.tools.get(seed.invocationId);
		const tool = existing ?? seed;
		if (isSettlement(finish.settlement)) tool.settlement = finish.settlement;
		if (isToolOutcome(finish.outcome)) tool.outcome = finish.outcome;
		if (typeof finish.rejectionReason === "string") {
			tool.rejectionReason = safeText(finish.rejectionReason, MAX_SUMMARY_CHARACTERS);
		}
		tool.observation = finish.observation ?? fallbackObservation(tool.outcome, tool.rejectionReason);
		state.tools.set(tool.invocationId, tool);
	}

	finishRun(runId: string, timestamp: number, finished: FinishedRun): RunEvidenceEnvelope {
		const state = this.#ensureRun(runId, timestamp);
		this.#runs.delete(runId);
		return projectEnvelope(state, finished);
	}

	#ensureRun(runId: string, timestamp: number): RunState {
		let state = this.#runs.get(runId);
		if (!state) {
			state = createRunState(runId, timestamp);
			this.#runs.set(runId, state);
		}
		return state;
	}
}

/** Incremental, side-effect-free projection over immutable live Agent Events. */
export class RunEvidenceProjection {
	readonly #reducer = new EvidenceReducer();

	accept(event: AgentEvent): RunEvidenceEnvelope | undefined {
		switch (event.type) {
			case "run_start":
				this.#reducer.startRun(event.runId, event.timestamp);
				break;
			case "attempt_end":
				this.#reducer.finishAttempt(event.runId, event.timestamp, {
					id: event.attemptId,
					order: event.sequence,
					outcome: event.outcome,
					discarded: event.discarded,
					usage: event.candidate.message.usage,
					error: event.candidate.message.errorMessage,
				});
				break;
			case "retry_scheduled":
				this.#reducer.noteRetry(event.runId, event.timestamp, event.attemptId);
				break;
			case "tool_execution_start":
				this.#reducer.startTool(event.runId, event.timestamp, event.sequence, event.invocation);
				break;
			case "tool_execution_end":
				this.#reducer.finishTool(event.runId, event.timestamp, event.sequence, event.invocation, {
					settlement: event.settlement,
					outcome: event.outcome,
					observation: observationFromResult(event.result.message),
				});
				break;
			case "tool_execution_rejected":
				this.#reducer.finishTool(event.runId, event.timestamp, event.sequence, event.invocation, {
					outcome: "rejected",
					rejectionReason: event.reason,
					observation: observationFromResult(event.result.message),
				});
				break;
			case "run_end":
				return this.#reducer.finishRun(event.runId, event.timestamp, {
					outcome: event.outcome,
					completedAt: event.timestamp,
					failure: event.failure,
				});
		}
		return undefined;
	}
}

/** Reconstructs completed Run evidence from existing Session facts without a cache record or migration. */
export function projectSessionRunEvidence(
	records: readonly RunEvidenceSessionRecord[],
): readonly RunEvidenceEnvelope[] {
	const observations = sessionObservations(records);
	const reducer = new EvidenceReducer();
	const completed: RunEvidenceEnvelope[] = [];
	for (const record of records) {
		if (!record.runId) continue;
		const payload = asRecord(record.payload);
		switch (record.type) {
			case "run_started":
				reducer.startRun(record.runId, record.timestamp);
				break;
			case "attempt_finished": {
				const outcome = attemptOutcome(payload?.outcome);
				if (!outcome) break;
				reducer.finishAttempt(record.runId, record.timestamp, {
					id:
						record.attemptId ??
						(typeof payload?.messageId === "string"
							? `message:${payload.messageId}`
							: `record:${record.sequence}`),
					order: record.sequence,
					outcome,
					discarded: payload?.discarded === true,
					usage: payload?.usage,
					error: payload?.errorMessage,
				});
				break;
			}
			case "retry_scheduled":
				if (record.attemptId) reducer.noteRetry(record.runId, record.timestamp, record.attemptId);
				break;
			case "tool_started":
				reducer.startTool(record.runId, record.timestamp, record.sequence, payload?.invocation);
				break;
			case "tool_finished": {
				const resultMessageId = typeof payload?.resultMessageId === "string" ? payload.resultMessageId : undefined;
				reducer.finishTool(record.runId, record.timestamp, record.sequence, payload?.invocation, {
					settlement: payload?.settlement,
					outcome: payload?.outcome,
					rejectionReason: payload?.reason,
					observation: resultMessageId ? observations.get(resultMessageId) : undefined,
				});
				break;
			}
			case "run_finished": {
				const outcome = runOutcome(payload?.outcome);
				if (!outcome) break;
				const failure = asRecord(payload?.failure);
				completed.push(
					reducer.finishRun(record.runId, record.timestamp, {
						outcome,
						completedAt: record.timestamp,
						...(typeof failure?.kind === "string" && typeof failure.message === "string"
							? { failure: { kind: failure.kind, message: failure.message } }
							: {}),
						...(typeof payload?.reason === "string" ? { interruptionReason: payload.reason } : {}),
					}),
				);
				break;
			}
		}
	}
	return deepFreeze(completed);
}

function createRunState(runId: string, timestamp: number): RunState {
	return {
		runId,
		startedAt: timestamp,
		attempts: new Map(),
		retriedAttempts: new Set(),
		retries: 0,
		tools: new Map(),
	};
}

function toolSeed(value: unknown, order: number): ToolEvidence | undefined {
	const invocation = asRecord(value) as (Record<string, unknown> & Partial<ToolInvocation>) | undefined;
	if (!invocation || typeof invocation.id !== "string" || typeof invocation.toolName !== "string") return undefined;
	const arguments_ = asRecord(invocation.arguments);
	const toolName = boundedText(invocation.toolName, MAX_TOOL_NAME_CHARACTERS);
	const requestedPath =
		INSPECTION_TOOLS.has(toolName) || MUTATION_TOOLS.has(toolName)
			? typeof arguments_?.path === "string"
				? arguments_.path
				: toolName === "grep" || toolName === "find" || toolName === "ls"
					? "."
					: undefined
			: undefined;
	return {
		invocationId: boundedText(invocation.id, MAX_ID_CHARACTERS),
		toolName,
		order,
		...(requestedPath !== undefined
			? {
					pathKind: MUTATION_TOOLS.has(toolName) ? ("changed" as const) : ("inspected" as const),
					path: safeText(requestedPath, MAX_PATH_CHARACTERS),
				}
			: {}),
		...(toolName === "bash" && typeof arguments_?.command === "string"
			? { command: safeText(arguments_.command, MAX_COMMAND_CHARACTERS) }
			: {}),
	};
}

function sessionObservations(records: readonly RunEvidenceSessionRecord[]): Map<string, ObservationEvidence> {
	const observations = new Map<string, ObservationEvidence>();
	for (const record of records) {
		if (record.type !== "message_committed") continue;
		const message = asRecord(asRecord(record.payload)?.message);
		const body = asRecord(message?.message);
		if (typeof message?.id !== "string" || body?.role !== "toolResult") continue;
		observations.set(message.id, observationFromResult(body as unknown as ToolResultMessage));
	}
	return observations;
}

function observationFromResult(message: unknown): ObservationEvidence {
	const body = asRecord(message);
	if (body?.role !== "toolResult") return fallbackObservation("error");
	return observationEvidence(resolveToolObservation(body));
}

function observationEvidence(observation: ToolObservation): ObservationEvidence {
	const facts = asRecord(observation.facts);
	return {
		status: observation.status,
		truncated: observation.truncated,
		outputRecoverable: typeof observation.outputRef === "string" && observation.outputRef.length > 0,
		...(typeof facts?.code === "string" ? { code: safeText(facts.code, MAX_SUMMARY_CHARACTERS) } : {}),
		...(Number.isSafeInteger(facts?.exitCode) ? { exitCode: Number(facts?.exitCode) } : {}),
		...(typeof facts?.signal === "string" && facts.signal.length > 0
			? { signal: safeText(facts.signal, MAX_SUMMARY_CHARACTERS) }
			: {}),
		timedOut: facts?.timedOut === true,
	};
}

function fallbackObservation(outcome: unknown, rejectionReason?: string): ObservationEvidence {
	const status: ToolObservation["status"] =
		outcome === "success"
			? "ok"
			: outcome === "aborted" || rejectionReason === "aborted" || rejectionReason === "not_started"
				? "aborted"
				: rejectionReason === "policy"
					? "denied"
					: "error";
	return { status, truncated: false, outputRecoverable: false, timedOut: false };
}

function projectEnvelope(state: RunState, finished: FinishedRun): RunEvidenceEnvelope {
	const attempts = [...state.attempts.values()].sort((left, right) => left.order - right.order);
	const tools = [...state.tools.values()].sort((left, right) => left.order - right.order);
	const inspectedPaths: string[] = [];
	const changedPaths: string[] = [];
	const commands: RunEvidenceCommand[] = [];
	const toolIssues: RunEvidenceToolIssue[] = [];
	const failures: RunEvidenceFailure[] = [];

	for (const tool of tools) {
		const observation = tool.observation ?? fallbackObservation(tool.outcome, tool.rejectionReason);
		const settled = tool.settlement !== "threw" && tool.settlement !== "aborted";
		if (observation.status === "ok" && settled && tool.path && tool.pathKind === "inspected") {
			inspectedPaths.push(tool.path);
		}
		if (observation.status === "ok" && settled && tool.path && tool.pathKind === "changed") {
			changedPaths.push(tool.path);
		}
		if (tool.command !== undefined) {
			commands.push(
				deepFreeze({
					invocationId: tool.invocationId,
					command: tool.command,
					status: observation.status,
					exitCode: observation.exitCode ?? null,
					signal: observation.signal ?? null,
					timedOut: observation.timedOut,
					truncated: observation.truncated,
				}),
			);
		}
		if (
			observation.status !== "ok" ||
			observation.truncated ||
			tool.settlement === "threw" ||
			tool.settlement === "aborted"
		) {
			const reason = toolIssueReason(tool, observation);
			toolIssues.push(
				deepFreeze({
					invocationId: tool.invocationId,
					toolName: tool.toolName,
					status: observation.status,
					settlement: tool.settlement ?? null,
					truncated: observation.truncated,
					outputRecoverable: observation.outputRecoverable,
					reason,
				}),
			);
		}
		if (observation.status !== "ok" || tool.settlement === "threw") {
			const status = observation.status === "ok" || tool.settlement === "threw" ? "error" : observation.status;
			failures.push(
				deepFreeze({
					kind: "tool" as const,
					id: tool.invocationId,
					status,
					summary: toolFailureSummary(tool, observation),
				}),
			);
		}
	}

	for (const attempt of attempts) {
		if (attempt.outcome !== "error" || state.retriedAttempts.has(attempt.id)) continue;
		failures.push(
			deepFreeze({
				kind: "attempt" as const,
				id: attempt.id,
				status: "error" as const,
				summary: attempt.error || "Model Attempt failed",
			}),
		);
	}

	if (finished.failure) {
		failures.push(
			deepFreeze({
				kind: "run" as const,
				id: boundedText(finished.failure.kind, MAX_ID_CHARACTERS),
				status: "error" as const,
				summary: safeText(finished.failure.message, MAX_SUMMARY_CHARACTERS),
			}),
		);
	} else if (finished.outcome === "interrupted") {
		failures.push(
			deepFreeze({
				kind: "run" as const,
				id: "interrupted",
				status: "interrupted" as const,
				summary:
					finished.interruptionReason === "process_ended_before_run_finished"
						? "Process ended before Run finished"
						: "Run was interrupted",
			}),
		);
	}

	const inspected = boundedUnique(inspectedPaths, MAX_PATHS);
	const changed = boundedUnique(changedPaths, MAX_PATHS);
	const boundedCommands = boundedList(commands, MAX_COMMANDS);
	const boundedIssues = boundedList(toolIssues, MAX_TOOL_ISSUES);
	const boundedFailures = boundedList(failures, MAX_UNRESOLVED_FAILURES);
	return deepFreeze({
		schemaVersion: 1 as const,
		type: "run_evidence" as const,
		runId: state.runId,
		outcome: finished.outcome,
		startedAt: state.startedAt,
		completedAt: finished.completedAt,
		elapsedMs: Math.max(0, finished.completedAt - state.startedAt),
		paths: {
			inspected: inspected.values,
			changed: changed.values,
			omitted: { inspected: inspected.omitted, changed: changed.omitted },
		},
		commands: boundedCommands.values,
		toolIssues: boundedIssues.values,
		unresolvedFailures: boundedFailures.values,
		usage: projectUsage(attempts, state.retries),
		omitted: {
			commands: boundedCommands.omitted,
			toolIssues: boundedIssues.omitted,
			unresolvedFailures: boundedFailures.omitted,
		},
	});
}

function projectUsage(attempts: readonly AttemptEvidence[], retries: number): RunEvidenceUsage {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cacheWrite1hTokens = 0;
	let reasoningTokens = 0;
	let totalTokens = 0;
	let knownTotalUsd = 0;
	let pricedAttempts = 0;
	for (const attempt of attempts) {
		inputTokens += attempt.usage.input;
		outputTokens += attempt.usage.output;
		cacheReadTokens += attempt.usage.cacheRead;
		cacheWriteTokens += attempt.usage.cacheWrite;
		cacheWrite1hTokens += attempt.usage.cacheWrite1h;
		reasoningTokens += attempt.usage.reasoning;
		totalTokens += attempt.usage.totalTokens;
		if (attempt.usage.costTotal !== undefined) {
			knownTotalUsd += attempt.usage.costTotal;
			pricedAttempts++;
		}
	}
	const unpricedAttempts = attempts.length - pricedAttempts;
	const costStatus = pricedAttempts === 0 ? "unavailable" : unpricedAttempts === 0 ? "complete" : ("partial" as const);
	return deepFreeze({
		attempts: attempts.length,
		retries,
		discardedAttempts: attempts.filter(({ discarded }) => discarded).length,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cacheWrite1hTokens,
		reasoningTokens,
		totalTokens,
		cost: {
			currency: "USD" as const,
			status: costStatus,
			totalUsd: costStatus === "complete" ? knownTotalUsd : null,
			knownTotalUsd,
			pricedAttempts,
			unpricedAttempts,
		},
	});
}

function usageSnapshot(value: unknown): UsageSnapshot {
	const usage = asRecord(value) as (Record<string, unknown> & Partial<Usage>) | undefined;
	const cost = asRecord(usage?.cost);
	return {
		input: nonNegativeNumber(usage?.input),
		output: nonNegativeNumber(usage?.output),
		cacheRead: nonNegativeNumber(usage?.cacheRead),
		cacheWrite: nonNegativeNumber(usage?.cacheWrite),
		cacheWrite1h: nonNegativeNumber(usage?.cacheWrite1h),
		reasoning: nonNegativeNumber(usage?.reasoning),
		totalTokens: nonNegativeNumber(usage?.totalTokens),
		...(typeof cost?.total === "number" && Number.isFinite(cost.total) ? { costTotal: Math.max(0, cost.total) } : {}),
	};
}

function toolIssueReason(tool: ToolEvidence, observation: ObservationEvidence): string | null {
	if (tool.rejectionReason) return tool.rejectionReason;
	if (observation.code) return observation.code;
	if (observation.timedOut) return "timed_out";
	if (observation.exitCode !== undefined && observation.exitCode !== 0) return `exit_${observation.exitCode}`;
	if (tool.settlement === "threw") return "implementation_threw";
	if (tool.settlement === "aborted") return "settlement_aborted";
	if (observation.truncated) return "output_truncated";
	return null;
}

function toolFailureSummary(tool: ToolEvidence, observation: ObservationEvidence): string {
	const reason = toolIssueReason(tool, observation);
	const status = tool.settlement === "threw" ? "failed" : observation.status;
	return safeText(`${tool.toolName} ${status}${reason ? ` (${reason})` : ""}`, MAX_SUMMARY_CHARACTERS);
}

function safeText(value: string, limit: number): string {
	let text = stripTerminalControls(value);
	text = redactSecrets(text);
	return boundedText(text.replace(/\s+/gu, " ").trim(), limit);
}

function stripTerminalControls(value: string): string {
	let safe = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			const next = value.charCodeAt(index + 1);
			if (next === 0x5b) {
				index += 2;
				while (index < value.length) {
					const final = value.charCodeAt(index);
					if (final >= 0x40 && final <= 0x7e) break;
					index++;
				}
			} else if (next === 0x5d) {
				index += 2;
				while (index < value.length) {
					const current = value.charCodeAt(index);
					if (current === 0x07) break;
					if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
						index++;
						break;
					}
					index++;
				}
			} else if (next >= 0x40 && next <= 0x5f) {
				index++;
			}
			safe += " ";
			continue;
		}
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			safe += " ";
			continue;
		}
		safe += value[index];
	}
	return safe;
}

function redactSecrets(value: string): string {
	let text = value.replace(
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/giu,
		"[REDACTED PRIVATE KEY]",
	);
	text = text.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
	text = text.replace(/\b(?:sk|rk)-[a-z0-9_-]{8,}\b/giu, "[REDACTED TOKEN]");
	text = text.replace(/\bgh[pousr]_[a-z0-9]{8,}\b/giu, "[REDACTED TOKEN]");
	text = text.replace(/\bxox[baprs]-[a-z0-9-]{8,}\b/giu, "[REDACTED TOKEN]");
	text = text.replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED TOKEN]");
	text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
	text = text.replace(
		/(--(?:api[-_]?key|token|secret|password|passwd|authorization|cookie))(\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
		"$1$2[REDACTED]",
	);
	return text.replace(
		/\b((?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COOKIE)[A-Z0-9_]*|api[-_]?key|token|secret|password|passwd|authorization|cookie))(\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
		"$1$2[REDACTED]",
	);
}

function boundedText(value: string, limit: number): string {
	const characters = Array.from(value);
	return characters.length <= limit ? value : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function boundedUnique(
	values: readonly string[],
	limit: number,
): { readonly values: readonly string[]; readonly omitted: number } {
	const unique = [...new Set(values)];
	return deepFreeze({ values: unique.slice(0, limit), omitted: Math.max(0, unique.length - limit) });
}

function boundedList<T>(
	values: readonly T[],
	limit: number,
): { readonly values: readonly T[]; readonly omitted: number } {
	return deepFreeze({ values: values.slice(0, limit), omitted: Math.max(0, values.length - limit) });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function attemptOutcome(value: unknown): AttemptEvidence["outcome"] | undefined {
	return value === "success" || value === "error" || value === "aborted" ? value : undefined;
}

function runOutcome(value: unknown): RunEvidenceOutcome | undefined {
	return value === "success" || value === "error" || value === "aborted" || value === "interrupted"
		? value
		: undefined;
}

function isSettlement(value: unknown): value is NonNullable<ToolEvidence["settlement"]> {
	return value === "returned" || value === "threw" || value === "aborted";
}

function isToolOutcome(value: unknown): value is NonNullable<ToolEvidence["outcome"]> {
	return (
		value === "success" || value === "error" || value === "aborted" || value === "rejected" || value === "interrupted"
	);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const item of Object.values(value)) deepFreeze(item);
	return value;
}
