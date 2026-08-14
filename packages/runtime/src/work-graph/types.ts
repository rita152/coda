import type { ActiveRun, AgentInput, RunBudgetExhaustion, RunFailure, RunLimits } from "@coda/agent";
import type { JsonValue, ThinkingLevel } from "@coda/ai";

declare const workIdentity: unique symbol;

export type WorkGraphId = string & { readonly [workIdentity]: "WorkGraphId" };
export type WorkItemId = string & { readonly [workIdentity]: "WorkItemId" };

export type WorkExecutionMode = "read_only" | "write";
export type WorkItemState =
	| "pending"
	| "ready"
	| "preparing"
	| "running"
	| "settling"
	| "succeeded"
	| "failed"
	| "canceled"
	| "interrupted"
	| "blocked";
export type WorkGraphOutcome = "succeeded" | "partial" | "failed" | "canceled" | "interrupted";

export interface DesiredRuntimeConfiguration {
	readonly model: {
		readonly provider: string;
		readonly id: string;
	};
	readonly reasoning: ThinkingLevel | "off";
	readonly runLimits?: RunLimits;
}

export type WorkSessionTarget =
	| { readonly type: "create"; readonly sessionId?: string }
	| { readonly type: "resume"; readonly sessionId: string };

export interface StartWorkGraph {
	readonly type: "start_work_graph";
	readonly graphId?: WorkGraphId | string;
	readonly objective: string;
	readonly root: {
		readonly itemId: WorkItemId | string;
		readonly objective?: string;
		readonly executionMode: WorkExecutionMode;
	};
	readonly maximumConcurrency: number;
	readonly configuration: DesiredRuntimeConfiguration;
	readonly session: WorkSessionTarget;
}

export interface AddWorkItemSpecification {
	readonly itemId: WorkItemId | string;
	readonly parentItemId: WorkItemId | string;
	readonly dependencies?: readonly (WorkItemId | string)[];
	readonly objective: string;
	readonly executionMode: WorkExecutionMode;
	readonly configuration?: DesiredRuntimeConfiguration;
}

export interface AddWorkItems {
	readonly type: "add_work_items";
	readonly graphId: WorkGraphId | string;
	readonly items: readonly AddWorkItemSpecification[];
}

export type WorkItemInputKind = "prompt" | "steering" | "follow_up";

export interface DeliverWorkItemInput {
	readonly type: "deliver_work_item_input";
	readonly graphId: WorkGraphId | string;
	readonly itemId: WorkItemId | string;
	readonly kind: WorkItemInputKind;
	readonly input: AgentInput;
	readonly resources?: readonly string[];
}

export interface ConfigureWorkItem {
	readonly type: "configure_work_item";
	readonly graphId: WorkGraphId | string;
	readonly itemId: WorkItemId | string;
	readonly configuration: DesiredRuntimeConfiguration;
}

export type CancelWork =
	| {
			readonly type: "cancel_work";
			readonly target: { readonly type: "graph"; readonly graphId: WorkGraphId | string };
	  }
	| {
			readonly type: "cancel_work";
			readonly target: {
				readonly type: "item";
				readonly graphId: WorkGraphId | string;
				readonly itemId: WorkItemId | string;
			};
	  };

export type CodingAgentCommand = StartWorkGraph | AddWorkItems | DeliverWorkItemInput | ConfigureWorkItem | CancelWork;

export interface CodingAgentCommandBatch {
	readonly batchId?: string;
	readonly commands: readonly CodingAgentCommand[];
}

export type CodingAgentRejectionCode =
	| "closed"
	| "empty_batch"
	| "invalid_command"
	| "invalid_identity"
	| "duplicate_identity"
	| "graph_not_found"
	| "item_not_found"
	| "missing_parent"
	| "missing_dependency"
	| "dependency_cycle"
	| "invalid_state"
	| "session_leased"
	| "session_reservation_failed"
	| "resource_reservation_failed"
	| "placement_reservation_failed"
	| "graph_store_failed"
	| "ledger_failed";

export interface CodingAgentRejection {
	readonly code: CodingAgentRejectionCode;
	readonly message: string;
	readonly commandIndex?: number;
	readonly itemId?: string;
	readonly graphId?: string;
}

export type CodingAgentReceipt =
	| {
			readonly status: "accepted";
			readonly batchId: string;
			readonly sequence: number;
			readonly graphIds: readonly WorkGraphId[];
			readonly itemIds: readonly WorkItemId[];
	  }
	| {
			readonly status: "rejected";
			readonly batchId: string;
			readonly rejection: CodingAgentRejection;
	  };

export interface WorkRunResult {
	readonly runId: string;
	readonly outcome: "success" | "error" | "aborted";
	readonly failure?: RunFailure;
	readonly assistantText?: string;
}

export interface WorkRunEvidence {
	readonly version: number;
	readonly facts: JsonValue;
}

export interface WorkspacePlacementDescriptor {
	readonly placementId: string;
	readonly root: string;
	readonly baseIdentity: string;
	/** Adapter-owned Publication target captured when this Placement was accepted. */
	readonly targetPlacementId?: string;
	/** Durable target state used to reject changed-source recovery. */
	readonly targetIdentity?: string;
	readonly kind: "direct" | "git_worktree" | "memory";
}

export interface WorkspaceArtifact {
	readonly artifactId: string;
	readonly placementId: string;
	readonly baseIdentity: string;
	readonly kind: "none" | "git_commit" | "memory";
	readonly reference?: string;
	readonly metadata?: JsonValue;
}

export type PublicationOutcome =
	| {
			readonly state: "not_required" | "published";
			readonly publicationId?: string;
			readonly targetPlacementId?: string;
			readonly targetIdentity?: string;
	  }
	| {
			readonly state: "not_published";
			readonly publicationId?: string;
			readonly targetPlacementId?: string;
			readonly reason: "canceled" | "conflict" | "changed_source" | "failed" | "interrupted";
			readonly diagnostic?: string;
	  };

export interface WorkBudgetUsage {
	readonly modelAttempts: number;
	readonly toolInvocations: number;
	readonly totalTokens: number;
	readonly elapsedMs: number;
	readonly exhaustion?: RunBudgetExhaustion;
}

export interface WorkDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly details?: JsonValue;
}

export interface WorkResult {
	/** Whether the terminal boundary is present in the Work Graph store. */
	readonly durability: "confirmed" | "unknown";
	readonly itemId: WorkItemId;
	readonly parentItemId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly runtimeId: string;
	readonly sessionId: string;
	readonly state: Extract<WorkItemState, "succeeded" | "failed" | "canceled" | "interrupted" | "blocked">;
	readonly run?: WorkRunResult;
	readonly evidence?: WorkRunEvidence;
	readonly placement: WorkspacePlacementDescriptor;
	readonly artifact?: WorkspaceArtifact;
	readonly publication: PublicationOutcome;
	readonly diagnostics: readonly WorkDiagnostic[];
	readonly timing: {
		readonly acceptedAt: number;
		readonly startedAt?: number;
		readonly settledAt: number;
	};
	readonly budget: WorkBudgetUsage;
	readonly blockedBy?: readonly WorkItemId[];
}

export interface WorkItemSnapshot {
	readonly itemId: WorkItemId;
	readonly parentItemId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: WorkExecutionMode;
	readonly state: WorkItemState;
	readonly desiredConfiguration: DesiredRuntimeConfiguration;
	readonly runtimeId?: string;
	readonly activeRun?: ActiveRun;
	readonly sessionId: string;
	readonly placement: WorkspacePlacementDescriptor;
	readonly cancellationRequested: boolean;
	readonly result?: WorkResult;
}

export interface WorkGraphResult {
	/** `unknown` means this is only a process-local fail-stop outcome and may be recovered again. */
	readonly durability: "confirmed" | "unknown";
	readonly graphId: WorkGraphId;
	readonly rootItemId: WorkItemId;
	readonly objective: string;
	readonly outcome: WorkGraphOutcome;
	readonly maximumConcurrency: number;
	readonly effectiveConcurrency: number;
	readonly results: readonly WorkResult[];
	readonly cancellationRequested: boolean;
	readonly acceptedAt: number;
	readonly settledAt: number;
	readonly finalPublication: "published" | "not_published" | "mixed" | "not_required";
}

export interface WorkGraphSnapshot {
	readonly graphId: WorkGraphId;
	readonly objective: string;
	readonly rootItemId: WorkItemId;
	readonly maximumConcurrency: number;
	readonly activeConcurrency: number;
	readonly effectiveConcurrency: number;
	readonly cancellationRequested: boolean;
	readonly items: readonly WorkItemSnapshot[];
	readonly result?: WorkGraphResult;
}

export interface CodingAgentSnapshot {
	readonly closed: boolean;
	readonly graphs: readonly WorkGraphSnapshot[];
}

export type CodingAgentObservation =
	| { readonly type: "snapshot"; readonly sequence: number; readonly snapshot: CodingAgentSnapshot }
	| {
			readonly type: "batch_accepted";
			readonly sequence: number;
			readonly batchId: string;
			readonly graphIds: readonly WorkGraphId[];
			readonly itemIds: readonly WorkItemId[];
	  }
	| {
			readonly type: "item_state_changed";
			readonly sequence: number;
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly from: WorkItemState;
			readonly to: WorkItemState;
	  }
	| {
			readonly type: "work_item_event";
			readonly sequence: number;
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly runtimeId: string;
			readonly sessionId: string;
			readonly event: JsonValue;
	  }
	| {
			readonly type: "work_item_settled";
			readonly sequence: number;
			readonly graphId: WorkGraphId;
			readonly result: WorkResult;
	  }
	| {
			readonly type: "work_graph_settled";
			readonly sequence: number;
			readonly result: WorkGraphResult;
	  }
	| {
			readonly type: "diagnostic";
			readonly sequence: number;
			readonly diagnostic: WorkDiagnostic;
			readonly graphId?: WorkGraphId;
			readonly itemId?: WorkItemId;
	  }
	| {
			readonly type: "resync_required";
			readonly sequence: number;
			readonly reason: "slow_consumer" | "upstream_overflow";
	  }
	| { readonly type: "closed"; readonly sequence: number; readonly result: CodingAgentCloseResult };

export interface ObservationOptions {
	readonly capacity?: number;
}

export interface CodingAgentCloseResult {
	readonly canceledGraphIds: readonly WorkGraphId[];
	readonly droppedInputs: number;
	readonly unknownWork: readonly {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly phase: "pending" | "ready" | "preparing" | "running" | "settling" | "result" | "publication";
	}[];
}

export interface CodingAgent {
	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt>;
	observe(options?: ObservationOptions): AsyncIterable<CodingAgentObservation>;
	close(): Promise<CodingAgentCloseResult>;
}
