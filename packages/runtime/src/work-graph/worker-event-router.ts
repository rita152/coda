import type { AgentEvent } from "@coda/agent";
import { MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH, type WorkerFact } from "./worker-fact.ts";
import type { WorkerControlEvent, WorkerEventDisposition, WorkerSessionEvent } from "./worker-protocol.ts";

function assertNever(value: never): never {
	throw new Error(`Unhandled Agent event: ${String((value as { type?: unknown }).type)}`);
}

function totalTokens(event: Extract<AgentEvent, { readonly type: "attempt_end" }>): number {
	const usage = event.candidate.message.usage;
	const value =
		usage.totalTokens > 0 && Number.isFinite(usage.totalTokens)
			? usage.totalTokens
			: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Attempt ${String(event.attemptId)} reported an invalid total token count`);
	}
	return value;
}

function session(event: WorkerSessionEvent): WorkerSessionEvent {
	return event;
}

function control(event: WorkerControlEvent): WorkerControlEvent {
	return event;
}

function disposition(
	event: AgentEvent,
	options: {
		readonly session?: WorkerSessionEvent;
		readonly fact?: WorkerFact;
		readonly control?: WorkerControlEvent;
	} = {},
): WorkerEventDisposition {
	return Object.freeze({ ...options, observation: event });
}

/** Exhaustive, pure classification for every Agent event crossing a Worker Runtime. */
export function routeWorkerEvent(event: AgentEvent): WorkerEventDisposition {
	switch (event.type) {
		case "run_start":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "run_started",
					runId: String(event.runId),
					source: event.source,
					...(event.queueItemId ? { queueItemId: String(event.queueItemId) } : {}),
					...(event.budget ? { budget: event.budget } : {}),
					timestamp: event.timestamp,
				},
				control: control(event),
			});
		case "turn_start":
			return disposition(event, { session: session(event), control: control(event) });
		case "attempt_start":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "attempt_started",
					runId: String(event.runId),
					turnId: String(event.turnId),
					attemptId: String(event.attemptId),
					messageId: String(event.messageId),
					attempt: event.attempt,
					timestamp: event.timestamp,
				},
			});
		case "message_start":
		case "message_update":
			return disposition(event);
		case "attempt_end":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "attempt_settled",
					runId: String(event.runId),
					turnId: String(event.turnId),
					attemptId: String(event.attemptId),
					messageId: String(event.messageId),
					attempt: event.attempt,
					outcome: event.outcome,
					discarded: event.discarded,
					totalTokens: totalTokens(event),
					timestamp: event.timestamp,
				},
				control: control(event),
			});
		case "retry_scheduled":
		case "message_end":
		case "tool_execution_rejected":
			return disposition(event, { session: session(event), control: control(event) });
		case "tool_execution_start":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "tool_started",
					runId: String(event.runId),
					turnId: String(event.turnId),
					invocationId: String(event.invocation.id),
					toolName: event.invocation.toolName.slice(0, MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH),
					replaySafety: event.invocation.replaySafety ?? "never",
					timestamp: event.timestamp,
				},
				control: control(event),
			});
		case "tool_execution_progress":
			return disposition(event);
		case "tool_execution_end":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "tool_settled",
					runId: String(event.runId),
					turnId: String(event.turnId),
					invocationId: String(event.invocation.id),
					settlement: event.settlement,
					outcome: event.outcome,
					timestamp: event.timestamp,
				},
				control: control(event),
			});
		case "turn_end":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "turn_settled",
					runId: String(event.runId),
					turnId: String(event.turnId),
					outcome: event.outcome,
					timestamp: event.timestamp,
				},
				control: control(event),
			});
		case "run_budget_exhausted":
			return disposition(event, {
				fact: {
					type: "budget_exhausted",
					runId: String(event.runId),
					exhaustion: event.exhaustion,
					timestamp: event.timestamp,
				},
			});
		case "run_end":
			return disposition(event, {
				session: session(event),
				fact: {
					type: "run_settled",
					runId: String(event.runId),
					outcome: event.outcome,
					...(event.failure ? { failureKind: event.failure.kind } : {}),
					timestamp: event.timestamp,
				},
				control: control(event),
			});
	}
	return assertNever(event);
}
