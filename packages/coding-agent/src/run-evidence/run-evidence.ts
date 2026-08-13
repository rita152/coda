import type { AgentEvent, ToolInvocation } from "@coda/agent";
import { resolveToolObservation, type ToolObservation, type ToolResultMessage, type Usage } from "@coda/ai";
import type { RunControlReport } from "../run-control/types.ts";
import {
	type MutationFacts,
	mutationFactsFromObservation,
	mutationRequestMetadata,
} from "../tools/mutation-contract.ts";
import {
	RUN_EVIDENCE_RUN_CONTROL_SCHEMA_VERSION,
	RUN_EVIDENCE_SCHEMA_VERSION,
	type RunEvidenceChangedPath,
	type RunEvidenceChangedPathProvenance,
	type RunEvidenceCommand,
	type RunEvidenceCommandV1,
	type RunEvidenceEnvelope,
	type RunEvidenceFailure,
	type RunEvidenceFailureV1,
	type RunEvidenceObservationCompleteness,
	type RunEvidenceObservationLimitation,
	type RunEvidenceOperation,
	type RunEvidenceOperationPath,
	type RunEvidenceOutcome,
	type RunEvidencePendingOperation,
	type RunEvidenceResolutionTarget,
	type RunEvidenceToolIssue,
	type RunEvidenceToolIssueV1,
	type RunEvidenceUsage,
	type RunEvidenceV1Projection,
	type RunEvidenceWithRunControlEnvelope,
	type RunEvidenceWorkspaceDiffSupplement,
} from "./contracts.ts";
import {
	commandResolutionKey,
	type FailureResolutionEvent,
	reconcileFailures,
	resolutionScope,
} from "./failure-semantics.ts";
import { resolveObservationSemantics } from "./observation-semantics.ts";

export * from "./contracts.ts";
export { normalizeRunEvidenceCommand } from "./failure-semantics.ts";

const MAX_PATHS = 50;
const MAX_OPERATIONS = 128;
const MAX_COMMANDS = 32;
const MAX_OBSERVATION_LIMITATIONS = 64;
const MAX_TOOL_ISSUES = 64;
const MAX_FAILURES = 64;
const MAX_PENDING_OPERATIONS = 64;
const MAX_PATH_CHARACTERS = 256;
const MAX_COMMAND_CHARACTERS = 512;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_ID_CHARACTERS = 128;
const MAX_TOOL_NAME_CHARACTERS = 128;

const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
	readonly turnId?: string;
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
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly limitationReason?: RunEvidenceObservationLimitation["reason"];
	readonly paths: readonly { readonly path: string; readonly effect: "inspected" | "changed" }[];
	readonly omittedPaths: { readonly inspected: number; readonly changed: number };
	readonly resolutionTarget?: RunEvidenceResolutionTarget;
	readonly code?: string;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly timedOut: boolean;
	readonly mutation?: MutationFacts;
}

interface ToolEvidence {
	readonly invocationId: string;
	readonly toolName: string;
	readonly order: number;
	completedOrder?: number;
	readonly pathKind?: "inspected" | "changed";
	readonly path?: string;
	readonly resolutionTarget?: RunEvidenceResolutionTarget;
	readonly legacyMutationPaths?: readonly string[];
	readonly command?: string;
	readonly rawCommand?: string;
	settlement?: "returned" | "threw" | "aborted";
	outcome?: "success" | "error" | "aborted" | "rejected" | "interrupted";
	rejectionReason?: string;
	observation?: ObservationEvidence;
}

interface RunState {
	readonly runId: string;
	startedAt: number;
	readonly attempts: Map<string, AttemptEvidence>;
	retries: number;
	readonly tools: Map<string, ToolEvidence>;
}

interface FinishedRun {
	readonly outcome: RunEvidenceOutcome;
	readonly completedAt: number;
	readonly sequence: number;
	readonly failure?: { readonly kind: string; readonly message: string };
	readonly interruptionReason?: string;
}

interface ProjectedToolEvidence {
	readonly tool: ToolEvidence;
	readonly observation: ObservationEvidence;
	readonly completedSequence: number;
	readonly settled: boolean;
	readonly paths: readonly RunEvidenceOperationPath[];
	readonly commandKey?: string;
	readonly failure?: RunEvidenceFailure;
	readonly resolutionScope?: string;
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
			readonly turnId?: string;
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
			...(attempt.turnId ? { turnId: boundedText(attempt.turnId, MAX_ID_CHARACTERS) } : {}),
			order: attempt.order,
			outcome: attempt.outcome,
			discarded: attempt.discarded,
			usage: usageSnapshot(attempt.usage),
			...(typeof attempt.error === "string" ? { error: safeText(attempt.error, MAX_SUMMARY_CHARACTERS) } : {}),
		});
	}

	noteRetry(runId: string, timestamp: number): void {
		const state = this.#ensureRun(runId, timestamp);
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
		tool.completedOrder = order;
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

	snapshotRun(runId: string, finished: FinishedRun): RunEvidenceEnvelope | undefined {
		const state = this.#runs.get(runId);
		return state ? projectEnvelope(state, finished) : undefined;
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

	/**
	 * Projects the evidence observed so far without settling or deleting the Run.
	 * Application-owned gates may use this only at a safe Agent event boundary;
	 * the completed `run_evidence` envelope remains authoritative after `run_end`.
	 */
	snapshot(
		runId: string,
		completedAt: number,
		outcome: RunEvidenceOutcome = "success",
	): RunEvidenceEnvelope | undefined {
		return this.#reducer.snapshotRun(runId, {
			outcome,
			completedAt,
			// A live completion snapshot has no lifecycle event sequence. This
			// sentinel is observable only for a synthetic interrupted snapshot.
			sequence: Number.MAX_SAFE_INTEGER,
		});
	}

	accept(event: AgentEvent): RunEvidenceEnvelope | undefined {
		switch (event.type) {
			case "run_start":
				this.#reducer.startRun(event.runId, event.timestamp);
				break;
			case "attempt_end":
				this.#reducer.finishAttempt(event.runId, event.timestamp, {
					id: event.attemptId,
					turnId: event.turnId,
					order: event.sequence,
					outcome: event.outcome,
					discarded: event.discarded,
					usage: event.candidate.message.usage,
					error: event.candidate.message.errorMessage,
				});
				break;
			case "retry_scheduled":
				this.#reducer.noteRetry(event.runId, event.timestamp);
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
					sequence: event.sequence,
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
					...(record.turnId ? { turnId: record.turnId } : {}),
					order: record.sequence,
					outcome,
					discarded: payload?.discarded === true,
					usage: payload?.usage,
					error: payload?.errorMessage,
				});
				break;
			}
			case "retry_scheduled":
				if (record.attemptId) reducer.noteRetry(record.runId, record.timestamp);
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
						sequence: record.sequence,
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
		retries: 0,
		tools: new Map(),
	};
}

function toolSeed(value: unknown, order: number): ToolEvidence | undefined {
	const invocation = asRecord(value) as (Record<string, unknown> & Partial<ToolInvocation>) | undefined;
	if (!invocation || typeof invocation.id !== "string" || typeof invocation.toolName !== "string") return undefined;
	const arguments_ = asRecord(invocation.arguments);
	const toolName = boundedText(invocation.toolName, MAX_TOOL_NAME_CHARACTERS);
	const requestedPath = INSPECTION_TOOLS.has(toolName)
		? typeof arguments_?.path === "string"
			? arguments_.path
			: toolName === "grep" || toolName === "find" || toolName === "ls"
				? "."
				: undefined
		: undefined;
	let legacyMutationPaths: readonly string[] | undefined;
	if (arguments_) {
		try {
			legacyMutationPaths = mutationRequestMetadata(toolName, arguments_)?.requestedPaths;
		} catch {
			legacyMutationPaths = undefined;
		}
	}
	const mutationTarget = legacyMutationPaths
		? {
				kind: legacyMutationPaths.length === 1 ? ("path" as const) : ("opaque" as const),
				value: legacyMutationPaths.length === 1 ? legacyMutationPaths[0]! : JSON.stringify(legacyMutationPaths),
			}
		: undefined;
	return {
		invocationId: boundedText(invocation.id, MAX_ID_CHARACTERS),
		toolName,
		order,
		...(requestedPath !== undefined
			? {
					pathKind: "inspected" as const,
					path: safeText(requestedPath, MAX_PATH_CHARACTERS),
					resolutionTarget: { kind: "path" as const, value: requestedPath },
				}
			: {}),
		...(legacyMutationPaths
			? {
					legacyMutationPaths: Object.freeze(
						legacyMutationPaths.map((path) => safeText(path, MAX_PATH_CHARACTERS)),
					),
					resolutionTarget: mutationTarget,
				}
			: {}),
		...(toolName === "bash" && typeof arguments_?.command === "string"
			? {
					command: safeText(arguments_.command, MAX_COMMAND_CHARACTERS),
					rawCommand: arguments_.command,
				}
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
	const mutation = mutationFactsFromObservation(observation.facts);
	const outputRecoverable = typeof observation.outputRef === "string" && observation.outputRef.length > 0;
	const semantics = resolveObservationSemantics({
		truncated: observation.truncated,
		outputRecoverable,
		facts,
	});
	return {
		status: observation.status,
		truncated: observation.truncated,
		outputRecoverable,
		completeness: semantics.completeness,
		...(semantics.limitationReason ? { limitationReason: semantics.limitationReason } : {}),
		paths: semantics.paths,
		omittedPaths: semantics.omittedPaths,
		...(semantics.resolutionTarget ? { resolutionTarget: semantics.resolutionTarget } : {}),
		...(typeof facts?.code === "string" ? { code: safeText(facts.code, MAX_SUMMARY_CHARACTERS) } : {}),
		...(Number.isSafeInteger(facts?.exitCode) ? { exitCode: Number(facts?.exitCode) } : {}),
		...(typeof facts?.signal === "string" && facts.signal.length > 0
			? { signal: safeText(facts.signal, MAX_SUMMARY_CHARACTERS) }
			: {}),
		timedOut: facts?.timedOut === true,
		...(mutation ? { mutation } : {}),
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
	return {
		status,
		truncated: false,
		outputRecoverable: false,
		completeness: "complete",
		paths: Object.freeze([]),
		omittedPaths: Object.freeze({ inspected: 0, changed: 0 }),
		timedOut: false,
	};
}

function projectEnvelope(state: RunState, finished: FinishedRun): RunEvidenceEnvelope {
	const attempts = [...state.attempts.values()].sort((left, right) => left.order - right.order);
	const tools = [...state.tools.values()].sort((left, right) => left.order - right.order);
	const inspectedPaths: string[] = [];
	const changedPaths = new Map<string, Set<RunEvidenceChangedPathProvenance>>();
	let omittedInspectedPaths = 0;
	let omittedChangedPaths = 0;
	const operations: RunEvidenceOperation[] = [];
	const commands: RunEvidenceCommand[] = [];
	const observationLimitations: RunEvidenceObservationLimitation[] = [];
	const toolIssues: RunEvidenceToolIssue[] = [];
	const terminalFailures: RunEvidenceFailure[] = [];
	const resolutionEvents: FailureResolutionEvent[] = [];
	const observationCounts: Record<RunEvidenceObservationCompleteness, number> = {
		complete: 0,
		windowed: 0,
		"recoverable-overflow": 0,
		"lossy-overflow": 0,
	};
	const projectedTools = tools.filter(isTerminalTool).map(projectToolEvidence);
	const pendingOperations = tools.filter((tool) => !isTerminalTool(tool)).map(projectPendingOperation);

	for (const projected of projectedTools) {
		const { tool, observation, completedSequence, paths, commandKey } = projected;
		const mutation = operationMutation(tool, observation);
		const boundedOperationPaths = boundedList(paths, MAX_PATHS);
		observationCounts[observation.completeness]++;
		omittedInspectedPaths += observation.omittedPaths.inspected;
		omittedChangedPaths += observation.omittedPaths.changed;
		for (const path of paths) {
			if (path.effect === "inspected") inspectedPaths.push(path.path);
			else noteChangedPath(changedPaths, path.path, "native");
		}
		operations.push(
			deepFreeze({
				invocationId: tool.invocationId,
				toolName: tool.toolName,
				startedSequence: tool.order,
				completedSequence,
				status: observation.status,
				settlement: tool.settlement ?? null,
				completeness: observation.completeness,
				code: observation.code ?? null,
				command: tool.command ?? null,
				commandKey: commandKey ?? null,
				...(mutation ? { mutation } : {}),
				paths: boundedOperationPaths.values,
				omittedPaths:
					boundedOperationPaths.omitted + observation.omittedPaths.inspected + observation.omittedPaths.changed,
			}),
		);
		if (observation.completeness !== "complete") {
			observationLimitations.push(
				deepFreeze({
					invocationId: tool.invocationId,
					toolName: tool.toolName,
					sequence: completedSequence,
					completeness: observation.completeness,
					reason: observation.limitationReason ?? "output-overflow",
				}),
			);
		}
		if (tool.command !== undefined) {
			commands.push(
				deepFreeze({
					invocationId: tool.invocationId,
					sequence: completedSequence,
					command: tool.command,
					commandKey: commandKey!,
					status: observation.status,
					exitCode: observation.exitCode ?? null,
					signal: observation.signal ?? null,
					timedOut: observation.timedOut,
					truncated: observation.truncated,
					completeness: observation.completeness,
				}),
			);
		}
		if (isToolIssue(projected)) {
			const reason = toolIssueReason(tool, observation);
			toolIssues.push(
				deepFreeze({
					invocationId: tool.invocationId,
					toolName: tool.toolName,
					status: observation.status,
					settlement: tool.settlement ?? null,
					truncated: observation.truncated,
					outputRecoverable: observation.outputRecoverable,
					completeness: observation.completeness,
					reason,
				}),
			);
		}
		if (projected.failure) {
			terminalFailures.push(projected.failure);
			resolutionEvents.push({
				sequence: completedSequence,
				failure: projected.failure,
				...(projected.resolutionScope ? { resolutionScope: projected.resolutionScope } : {}),
			});
		} else if (observation.status === "ok" && projected.settled) {
			const scopes = successResolutionScopes(projected);
			if (scopes.length > 0) {
				resolutionEvents.push({
					sequence: completedSequence,
					recoveredById: tool.invocationId,
					resolutionScopes: scopes,
				});
			}
		}
	}

	for (const attempt of attempts) {
		const attemptScope = attempt.turnId ? resolutionScope("attempt", attempt.turnId) : undefined;
		if (attempt.outcome === "error") {
			const failure = deepFreeze({
				kind: "attempt" as const,
				id: attempt.id,
				status: "error" as const,
				summary: attempt.error || "Model Attempt failed",
				sequence: attempt.order,
				resolutionKey: attemptScope ?? null,
			});
			terminalFailures.push(failure);
			resolutionEvents.push({
				sequence: attempt.order,
				failure,
				...(attemptScope ? { resolutionScope: attemptScope } : {}),
			});
		} else if (attempt.outcome === "success" && attemptScope) {
			resolutionEvents.push({
				sequence: attempt.order,
				recoveredById: attempt.id,
				resolutionScopes: [attemptScope],
			});
		}
	}

	if (finished.failure) {
		const failure = deepFreeze({
			kind: "run" as const,
			id: boundedText(finished.failure.kind, MAX_ID_CHARACTERS),
			status: "error" as const,
			summary: safeText(finished.failure.message, MAX_SUMMARY_CHARACTERS),
			sequence: finished.sequence,
			resolutionKey: null,
		});
		terminalFailures.push(failure);
		resolutionEvents.push({ sequence: finished.sequence, failure });
	} else if (finished.outcome === "interrupted") {
		const failure = deepFreeze({
			kind: "run" as const,
			id: "interrupted",
			status: "interrupted" as const,
			summary:
				finished.interruptionReason === "process_ended_before_run_finished"
					? "Process ended before Run finished"
					: "Run was interrupted",
			sequence: finished.sequence,
			resolutionKey: null,
		});
		terminalFailures.push(failure);
		resolutionEvents.push({ sequence: finished.sequence, failure });
	}

	terminalFailures.sort((left, right) => left.sequence - right.sequence);
	const { recoveredFailures, openFailures } = reconcileFailures(resolutionEvents);
	const inspected = boundedUnique(inspectedPaths, MAX_PATHS);
	const changed = boundedChangedPaths(changedPaths, MAX_PATHS);
	const boundedOperations = boundedList(operations, MAX_OPERATIONS);
	const boundedCommands = boundedList(commands, MAX_COMMANDS);
	const boundedLimitations = boundedList(observationLimitations, MAX_OBSERVATION_LIMITATIONS);
	const boundedIssues = boundedList(toolIssues, MAX_TOOL_ISSUES);
	const boundedTerminalFailures = boundedList(terminalFailures, MAX_FAILURES);
	const boundedRecoveredFailures = boundedList(recoveredFailures, MAX_FAILURES);
	const boundedPendingOperations = boundedList(pendingOperations, MAX_PENDING_OPERATIONS);
	const boundedOpenFailures = boundedList(openFailures, MAX_FAILURES);
	return deepFreeze({
		schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
		type: "run_evidence" as const,
		runId: state.runId,
		outcome: finished.outcome,
		startedAt: state.startedAt,
		completedAt: finished.completedAt,
		elapsedMs: Math.max(0, finished.completedAt - state.startedAt),
		paths: {
			inspected: inspected.values,
			changed: changed.values.map(({ path }) => path),
			changedWithProvenance: changed.values,
			workspaceDiff: { status: "unavailable" as const, omitted: 0 },
			omitted: {
				inspected: inspected.omitted + omittedInspectedPaths,
				changed: changed.omitted + omittedChangedPaths,
			},
		},
		operations: boundedOperations.values,
		observations: {
			counts: observationCounts,
			limitations: boundedLimitations.values,
			omittedLimitations: boundedLimitations.omitted,
		},
		commands: boundedCommands.values,
		toolIssues: boundedIssues.values,
		terminalFailures: boundedTerminalFailures.values,
		recoveredFailures: boundedRecoveredFailures.values,
		pendingOperations: boundedPendingOperations.values,
		openFailures: boundedOpenFailures.values,
		unresolvedFailures: boundedOpenFailures.values,
		usage: projectUsage(attempts, state.retries),
		omitted: {
			operations: boundedOperations.omitted,
			commands: boundedCommands.omitted,
			observationLimitations: boundedLimitations.omitted,
			toolIssues: boundedIssues.omitted,
			terminalFailures: boundedTerminalFailures.omitted,
			recoveredFailures: boundedRecoveredFailures.omitted,
			pendingOperations: boundedPendingOperations.omitted,
			openFailures: boundedOpenFailures.omitted,
			unresolvedFailures: boundedOpenFailures.omitted,
		},
	});
}

/** Produces the strict v1 compatibility shape retained by existing summary readers. */
export function projectRunEvidenceV1(evidence: RunEvidenceEnvelope): RunEvidenceV1Projection {
	return deepFreeze({
		schemaVersion: 1 as const,
		type: evidence.type,
		runId: evidence.runId,
		outcome: evidence.outcome,
		startedAt: evidence.startedAt,
		completedAt: evidence.completedAt,
		elapsedMs: evidence.elapsedMs,
		paths: {
			inspected: evidence.paths.inspected,
			changed: evidence.paths.changed,
			omitted: evidence.paths.omitted,
		},
		commands: evidence.commands.map(commandV1),
		toolIssues: evidence.toolIssues.map(toolIssueV1),
		unresolvedFailures: evidence.unresolvedFailures.map(failureV1),
		usage: evidence.usage,
		omitted: {
			commands: evidence.omitted.commands,
			toolIssues: evidence.omitted.toolIssues,
			unresolvedFailures: evidence.omitted.unresolvedFailures,
		},
	});
}

/** Adds final Workspace facts without reinterpreting native Tool observations. */
export function supplementRunEvidenceWorkspaceDiff(
	evidence: RunEvidenceEnvelope,
	supplement: RunEvidenceWorkspaceDiffSupplement,
): RunEvidenceEnvelope {
	const changed = new Map<string, Set<RunEvidenceChangedPathProvenance>>();
	for (const entry of evidence.paths.changedWithProvenance) {
		for (const provenance of entry.provenance) noteChangedPath(changed, entry.path, provenance);
	}
	if (supplement.status !== "unavailable") {
		for (const path of supplement.paths)
			noteChangedPath(changed, safeText(path, MAX_PATH_CHARACTERS), "workspace-diff");
	}
	const bounded = boundedChangedPaths(changed, MAX_PATHS);
	const representedWorkspacePaths = new Set(
		bounded.values.filter(({ provenance }) => provenance.includes("workspace-diff")).map(({ path }) => path),
	);
	const workspaceOmitted =
		Math.max(0, supplement.omitted ?? 0) +
		new Set(
			supplement.status === "unavailable"
				? []
				: supplement.paths
						.map((path) => safeText(path, MAX_PATH_CHARACTERS))
						.filter((path) => !representedWorkspacePaths.has(path)),
		).size;
	const nativeOmitted = Math.max(0, evidence.paths.omitted.changed - evidence.paths.workspaceDiff.omitted);
	return deepFreeze({
		...evidence,
		paths: {
			...evidence.paths,
			changed: bounded.values.map(({ path }) => path),
			changedWithProvenance: bounded.values,
			workspaceDiff: { status: supplement.status, omitted: workspaceOmitted },
			omitted: {
				...evidence.paths.omitted,
				changed: nativeOmitted + workspaceOmitted,
			},
		},
	});
}

/** Adds RunControl to JSON output without changing persisted Session evidence. */
export function withRunControlEvidence(
	evidence: RunEvidenceEnvelope,
	runControl: RunControlReport,
): RunEvidenceWithRunControlEnvelope {
	return deepFreeze({
		...evidence,
		schemaVersion: RUN_EVIDENCE_RUN_CONTROL_SCHEMA_VERSION,
		runControl,
	});
}

function isTerminalTool(tool: ToolEvidence): boolean {
	return tool.completedOrder !== undefined;
}

function projectToolEvidence(tool: ToolEvidence): ProjectedToolEvidence {
	const observation = tool.observation ?? fallbackObservation(tool.outcome, tool.rejectionReason);
	const completedSequence = tool.completedOrder ?? tool.order;
	const settled = tool.settlement !== "threw" && tool.settlement !== "aborted";
	const paths = operationPaths(tool, observation, settled);
	const commandKey = tool.rawCommand === undefined ? undefined : commandResolutionKey(tool.rawCommand);
	const status = toolFailureStatus(tool, observation);
	const identity = failureResolutionIdentity(tool, observation, commandKey);
	const failure =
		status === undefined
			? undefined
			: deepFreeze({
					kind: "tool" as const,
					id: tool.invocationId,
					status,
					summary: toolFailureSummary(tool, observation),
					sequence: completedSequence,
					resolutionKey: identity.resolutionKey ?? null,
				});
	return {
		tool,
		observation,
		completedSequence,
		settled,
		paths,
		...(commandKey ? { commandKey } : {}),
		...(failure ? { failure } : {}),
		...(identity.resolutionScope ? { resolutionScope: identity.resolutionScope } : {}),
	};
}

function operationPaths(
	tool: ToolEvidence,
	observation: ObservationEvidence,
	settled: boolean,
): readonly RunEvidenceOperationPath[] {
	if (!settled) return Object.freeze([]);
	const declared = observation.paths.map((path) => ({
		path: safeText(path.path, MAX_PATH_CHARACTERS),
		effect: path.effect,
		provenance: "tool-observation" as const,
	}));
	const nativeMutationPaths = (observation.mutation?.committedPaths ?? []).map((path) => ({
		path: safeText(path, MAX_PATH_CHARACTERS),
		effect: "changed" as const,
		provenance: "tool-observation" as const,
	}));
	const legacyMutationPaths =
		!observation.mutation && observation.status === "ok"
			? (tool.legacyMutationPaths ?? []).map((path) => ({
					path,
					effect: "changed" as const,
					provenance: "invocation-argument" as const,
				}))
			: [];
	const fallbackPath =
		observation.status === "ok" && tool.path && tool.pathKind
			? [{ path: tool.path, effect: tool.pathKind, provenance: "invocation-argument" as const }]
			: [];
	const paths = [
		...declared,
		...nativeMutationPaths,
		...legacyMutationPaths,
		...(declared.length ? [] : fallbackPath),
	];
	const unique = new Map(paths.map((path) => [`${path.effect}\0${path.path}`, path]));
	return deepFreeze([...unique.values()]);
}

function operationMutation(tool: ToolEvidence, observation: ObservationEvidence): RunEvidenceOperation["mutation"] {
	const attemptedPaths = observation.mutation?.attemptedPaths ?? tool.legacyMutationPaths;
	if (!attemptedPaths) return undefined;
	return deepFreeze({
		attemptedPaths: attemptedPaths.map((path) => safeText(path, MAX_PATH_CHARACTERS)),
		committedPaths: (observation.mutation?.committedPaths ?? []).map((path) => safeText(path, MAX_PATH_CHARACTERS)),
	});
}

function projectPendingOperation(tool: ToolEvidence): RunEvidencePendingOperation {
	const target = tool.resolutionTarget
		? {
				kind: tool.resolutionTarget.kind,
				value: safeText(tool.resolutionTarget.value, MAX_PATH_CHARACTERS),
			}
		: null;
	return deepFreeze({
		invocationId: tool.invocationId,
		toolName: tool.toolName,
		startedSequence: tool.order,
		target,
	});
}

function isToolIssue(projected: ProjectedToolEvidence): boolean {
	return (
		projected.failure !== undefined ||
		projected.tool.settlement === "aborted" ||
		projected.observation.completeness === "recoverable-overflow" ||
		projected.observation.completeness === "lossy-overflow"
	);
}

function toolFailureStatus(
	tool: ToolEvidence,
	observation: ObservationEvidence,
): RunEvidenceFailure["status"] | undefined {
	if (tool.settlement === "aborted") return "aborted";
	if (tool.settlement === "threw" || observation.status === "ok") {
		return tool.settlement === "threw" ? "error" : undefined;
	}
	return observation.status;
}

function failureResolutionIdentity(
	tool: ToolEvidence,
	observation: ObservationEvidence,
	commandKey: string | undefined,
): { readonly resolutionKey?: string; readonly resolutionScope?: string } {
	if (commandKey) return { resolutionKey: commandKey, resolutionScope: commandKey };
	const target = observation.resolutionTarget ?? tool.resolutionTarget;
	if (!target) return {};
	const scope = resolutionScope("tool-target", [tool.toolName, target.kind, target.value].join("\0"));
	const code = observation.code ?? toolIssueReason(tool, observation) ?? observation.status;
	return {
		resolutionKey: resolutionScope("tool-failure", `${scope}\0${code}`),
		resolutionScope: scope,
	};
}

function successResolutionScopes(projected: ProjectedToolEvidence): readonly string[] {
	const scopes: string[] = [];
	if (projected.commandKey) scopes.push(projected.commandKey);
	const target = projected.observation.resolutionTarget ?? projected.tool.resolutionTarget;
	if (target) {
		scopes.push(resolutionScope("tool-target", [projected.tool.toolName, target.kind, target.value].join("\0")));
	}
	return Object.freeze(scopes);
}

function commandV1(command: RunEvidenceCommand): RunEvidenceCommandV1 {
	return {
		invocationId: command.invocationId,
		command: command.command,
		status: command.status,
		exitCode: command.exitCode,
		signal: command.signal,
		timedOut: command.timedOut,
		truncated: command.truncated,
	};
}

function toolIssueV1(issue: RunEvidenceToolIssue): RunEvidenceToolIssueV1 {
	return {
		invocationId: issue.invocationId,
		toolName: issue.toolName,
		status: issue.status,
		settlement: issue.settlement,
		truncated: issue.truncated,
		outputRecoverable: issue.outputRecoverable,
		reason: issue.reason,
	};
}

function failureV1(failure: RunEvidenceFailure): RunEvidenceFailureV1 {
	return { kind: failure.kind, id: failure.id, status: failure.status, summary: failure.summary };
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
	const input = nonNegativeNumber(usage?.input);
	const output = nonNegativeNumber(usage?.output);
	const cacheRead = nonNegativeNumber(usage?.cacheRead);
	const cacheWrite = nonNegativeNumber(usage?.cacheWrite);
	const reportedTotal = nonNegativeNumber(usage?.totalTokens);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h: nonNegativeNumber(usage?.cacheWrite1h),
		reasoning: nonNegativeNumber(usage?.reasoning),
		totalTokens: reportedTotal > 0 ? reportedTotal : input + output + cacheRead + cacheWrite,
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
	if (observation.completeness === "recoverable-overflow" || observation.completeness === "lossy-overflow") {
		return "output_truncated";
	}
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

function noteChangedPath(
	paths: Map<string, Set<RunEvidenceChangedPathProvenance>>,
	path: string,
	provenance: RunEvidenceChangedPathProvenance,
): void {
	const sources = paths.get(path) ?? new Set<RunEvidenceChangedPathProvenance>();
	sources.add(provenance);
	paths.set(path, sources);
}

function boundedChangedPaths(
	paths: ReadonlyMap<string, ReadonlySet<RunEvidenceChangedPathProvenance>>,
	limit: number,
): { readonly values: readonly RunEvidenceChangedPath[]; readonly omitted: number } {
	const values = [...paths].map(([path, provenance]) =>
		deepFreeze({ path, provenance: Object.freeze([...provenance]) }),
	);
	return deepFreeze({ values: values.slice(0, limit), omitted: Math.max(0, values.length - limit) });
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
