import type { AgentEvent, AgentInput } from "@coda/agent";
import type { WorkGraphId, WorkItemId } from "./types.ts";

/** Host-only input envelope. It is never appended to the model-visible transcript as metadata. */
export interface WorkerSubmission {
	readonly preparationId: string;
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
	readonly kind: "prompt" | "steering" | "follow_up";
	readonly input: AgentInput;
	readonly resourceReferences: readonly string[];
}

/** Data-only Worker lifecycle events; executable Prepared Run capabilities never cross this boundary. */
export type WorkerRuntimeEvent =
	| AgentEvent
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
	  }
	| {
			readonly type: "fatal_barrier_failed";
			readonly barrier: "session";
			readonly failedEventType: string;
			readonly externalEffectMayHaveOccurred: boolean;
			readonly diagnostic: string;
	  };
