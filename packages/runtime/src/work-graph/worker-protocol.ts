import type { AgentEvent, AgentInput } from "@coda/agent";
import type { WorkGraphId, WorkItemId } from "./types.ts";
import type { OpenAttemptEffect, OpenToolEffect, WorkerFact } from "./worker-fact.ts";

/** Host-only input envelope. It is never appended to the model-visible transcript as metadata. */
export interface WorkerSubmission {
	readonly preparationId: string;
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
	readonly kind: "prompt" | "steering" | "follow_up";
	readonly input: AgentInput;
	readonly resourceReferences: readonly string[];
}

type AgentEventOf<TType extends AgentEvent["type"]> = Extract<AgentEvent, { readonly type: TType }>;

export type WorkerSessionEvent = AgentEventOf<
	| "run_start"
	| "turn_start"
	| "attempt_start"
	| "attempt_end"
	| "retry_scheduled"
	| "message_end"
	| "tool_execution_rejected"
	| "tool_execution_start"
	| "tool_execution_end"
	| "turn_end"
	| "run_end"
>;

export type WorkerControlEvent = AgentEventOf<
	| "run_start"
	| "turn_start"
	| "attempt_end"
	| "retry_scheduled"
	| "message_end"
	| "tool_execution_rejected"
	| "tool_execution_start"
	| "tool_execution_end"
	| "turn_end"
	| "run_end"
>;

export type WorkerPreparationObservation =
	| {
			readonly type: "preparation_started";
			readonly preparationId: string;
			readonly submissionKind: WorkerSubmission["kind"];
			readonly resourceReferences: readonly string[];
			readonly deadline?: number;
	  }
	| {
			readonly type: "preparation_settled";
			readonly preparationId: string;
			readonly outcome: "prepared" | "canceled" | "failed";
			readonly diagnostic?: string;
	  }
	| {
			readonly type: "prepared_run_disposed";
			readonly preparationId: string;
	  };

/** Full-fidelity, best-effort data. It never crosses a fatal or Control seam. */
export type WorkerObservation = AgentEvent | WorkerPreparationObservation;

export interface WorkerEventDisposition {
	readonly session?: WorkerSessionEvent;
	readonly fact?: WorkerFact;
	readonly control?: WorkerControlEvent;
	readonly observation: AgentEvent;
}

export interface WorkerBarrierFailure {
	readonly barrier: "session" | "work_graph_store";
	readonly source: WorkerSessionEvent["type"] | WorkerFact["type"] | "prepare_run" | "context_compacted";
	readonly diagnostic: string;
	readonly openAttempts: readonly OpenAttemptEffect[];
	readonly openTools: readonly OpenToolEffect[];
	readonly externalEffectMayHaveOccurred: boolean;
}
