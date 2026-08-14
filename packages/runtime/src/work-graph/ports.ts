import type { AgentInput, AgentSeed, AgentTool, Clock, IdGenerator, RunBudget } from "@coda/agent";
import type { JsonValue } from "@coda/ai";
import type { CompactionCheckpoint } from "../context-window/types.ts";
import type { RuntimeScheduler } from "../retry.ts";
import type { RunCapabilityHost, RunModelSelection, RunToolContribution } from "../run-capabilities.ts";
import type {
	DesiredRuntimeConfiguration,
	PublicationOutcome,
	WorkExecutionMode,
	WorkGraphId,
	WorkItemId,
	WorkRunEvidence,
	WorkSessionTarget,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import type { WorkerFact } from "./worker-fact.ts";
import type { WorkerControlEvent, WorkerSessionEvent } from "./worker-protocol.ts";

export type WorkspaceEffect = "read" | "write" | "unknown";

export type WorkerSelection = RunModelSelection;

export type WorkerSessionChange =
	| {
			readonly type: "prepare_run";
			readonly promptVersion: string;
			readonly promptSha256: string;
	  }
	| { readonly type: "context_compacted"; readonly checkpoint: CompactionCheckpoint };

export interface WorkerSession {
	readonly id: string;
	readonly seed?: AgentSeed;
	readonly compactionCheckpoint?: CompactionCheckpoint;
	accept(event: WorkerSessionEvent): Promise<void> | void;
	record(change: WorkerSessionChange): Promise<void>;
	close(): Promise<void>;
}

export type WorkspaceToolContribution = RunToolContribution;

export interface WorkSessionReservation {
	readonly session: WorkerSession;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	evidence(runId: string): WorkRunEvidence | undefined;
}

export interface WorkSessionStore {
	reserve(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly parentItemId?: WorkItemId;
		readonly target: WorkSessionTarget;
		readonly placement: WorkspacePlacementDescriptor;
	}): Promise<WorkSessionReservation>;
}

export interface WorkspacePlacementReservation {
	readonly placement: WorkspacePlacementDescriptor;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface WorkspaceExecution {
	reserve(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly parentItemId?: WorkItemId;
		readonly parent?: WorkspacePlacementDescriptor;
		readonly mode: WorkExecutionMode;
		readonly sourceOrder: number;
		readonly publicationOrder: number;
	}): Promise<WorkspacePlacementReservation>;
	recover(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly parentItemId?: WorkItemId;
		readonly placement: WorkspacePlacementDescriptor;
		readonly mode: WorkExecutionMode;
		readonly sourceOrder: number;
		readonly publicationOrder: number;
		/** Latest durably settled identity for the Placement's Publication target. */
		readonly expectedTargetIdentity?: string;
	}): Promise<WorkspacePlacementReservation>;
	tools(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
		readonly mode: WorkExecutionMode;
	}): Promise<readonly WorkspaceToolContribution[]> | readonly WorkspaceToolContribution[];
	bindTools(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
		readonly contributions: readonly WorkspaceToolContribution[];
	}): readonly AgentTool[];
	quiesce(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
	}): Promise<void>;
	capture(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly placement: WorkspacePlacementDescriptor;
		readonly signal: AbortSignal;
	}): Promise<WorkspaceArtifact | undefined>;
	publish(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly artifact: WorkspaceArtifact;
		readonly placement: WorkspacePlacementDescriptor;
		readonly target?: WorkspacePlacementDescriptor;
		readonly signal: AbortSignal;
	}): Promise<PublicationOutcome>;
	release(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly placement: WorkspacePlacementDescriptor;
		readonly preserve: boolean;
	}): Promise<void>;
	close(): Promise<void>;
}

export interface InputResourceReservation {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface InputResourceStore {
	reserve(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly input: AgentInput;
		readonly references: readonly string[];
	}): Promise<InputResourceReservation>;
}

export type WorkGraphRecord =
	| {
			readonly type: "batch_accepted";
			readonly batchId: string;
			readonly acceptedAt: number;
			readonly payload: JsonValue;
	  }
	| {
			readonly type: "input_resources_settled";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly deliveryId: string;
			readonly outcome: "committed" | "failed";
			readonly timestamp: number;
			readonly diagnostic?: string;
	  }
	| {
			readonly type: "item_transition";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly from: string;
			readonly to: string;
			readonly timestamp: number;
			readonly payload?: JsonValue;
	  }
	| {
			readonly type: "worker_fact";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly runtimeId: string;
			readonly sessionId: string;
			readonly fact: WorkerFact;
	  }
	| {
			readonly type: "item_result";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly timestamp: number;
			readonly payload: JsonValue;
	  }
	| {
			readonly type: "graph_result";
			readonly graphId: WorkGraphId;
			readonly timestamp: number;
			readonly payload: JsonValue;
	  }
	| {
			readonly type: "cancellation_requested";
			readonly graphId: WorkGraphId;
			readonly itemId?: WorkItemId;
			readonly timestamp: number;
	  }
	| {
			readonly type: "publication";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly timestamp: number;
			readonly payload: JsonValue;
	  }
	| {
			readonly type: "ownership_released";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly timestamp: number;
			readonly preservePlacement: boolean;
	  }
	| {
			readonly type: "recovery_interrupted";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly timestamp: number;
			readonly reasons: readonly string[];
			readonly payload: JsonValue;
	  };

export interface WorkGraphStoreRestore {
	readonly records: readonly WorkGraphRecord[];
	readonly diagnostics: readonly string[];
}

export interface WorkGraphStore {
	load(): Promise<WorkGraphStoreRestore>;
	append(record: WorkGraphRecord): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

export interface WorkspaceGraphIndexEntry {
	readonly graphId: WorkGraphId;
	readonly order: number;
}

export interface WorkspaceSessionOwner {
	readonly sessionId: string;
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
}

export interface WorkspaceTargetIdentity {
	readonly targetPlacementId: string;
	readonly targetIdentity: string;
}

export interface WorkspaceLedgerRestore {
	readonly activeGraphs: readonly WorkspaceGraphIndexEntry[];
	readonly nextGraphOrder: number;
	readonly nextPublicationOrder: number;
	readonly sessionOwners: readonly WorkspaceSessionOwner[];
	readonly targetIdentities: readonly WorkspaceTargetIdentity[];
	readonly diagnostics: readonly string[];
}

export interface WorkspaceLedgerAcceptance {
	readonly activeGraphs: readonly WorkspaceGraphIndexEntry[];
	readonly nextGraphOrder: number;
	readonly nextPublicationOrder: number;
	readonly sessionOwners: readonly WorkspaceSessionOwner[];
}

/** Small Workspace-global ordering and ownership record. It never stores Graph facts. */
export interface WorkspaceLedger {
	load(): Promise<WorkspaceLedgerRestore>;
	accept(acceptance: WorkspaceLedgerAcceptance): Promise<void>;
	releaseSession(owner: WorkspaceSessionOwner): Promise<void>;
	recordTargetIdentity(identity: WorkspaceTargetIdentity): Promise<void>;
	archiveGraph(graphId: WorkGraphId): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

/** Explicit process epoch. Closing it releases every Graph store and the Workspace process lease. */
export interface WorkspacePersistenceLease {
	readonly epoch: string;
	readonly ledger: WorkspaceLedger;
	openGraph(graphId: WorkGraphId): Promise<WorkGraphStore>;
	openHistoricalGraph(graphId: WorkGraphId): Promise<WorkGraphStore | undefined>;
	archiveGraph(graphId: WorkGraphId): Promise<void>;
	close(): Promise<void>;
}

export interface WorkspacePersistence {
	acquire(): Promise<WorkspacePersistenceLease>;
}

export interface OpenCodingAgentOptions {
	readonly workspaceExecution: WorkspaceExecution;
	readonly sessions: WorkSessionStore;
	readonly resources?: InputResourceStore;
	readonly persistence?: WorkspacePersistence;
	readonly resolveConfiguration: (
		configuration: DesiredRuntimeConfiguration,
	) => WorkerSelection | Promise<WorkerSelection>;
	readonly runCapabilities: RunCapabilityHost;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly processMaximumConcurrency?: number;
	readonly scheduler?: RuntimeScheduler;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print" | "evaluation";
	readonly controlWorker?: (event: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly runtimeId: string;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
		readonly event: WorkerControlEvent;
	}) => Promise<void> | void;
}
