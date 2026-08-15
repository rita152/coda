/**
 * Runtime owns Work Graph/Item/Result, Worker Runtime, Publication, Observation,
 * Desired Runtime Configuration, Workspace Ledger, and Work Graph Store vocabulary.
 * Physical host knowledge crosses only the named capabilities declared here.
 */
import type { AgentInput, AgentTool, IdGenerator, RunBudget, Session } from "@coda/agent";
import type { SystemPromptSnapshot, TrustedProjectInstructions } from "../prompt/prompt-builder.ts";
import type {
	ModelDriverLease,
	RunCapabilitySource,
	RunModelSelection,
	RunToolContribution,
} from "../run-capabilities.ts";
import type {
	CodingAgentObservation,
	DesiredRuntimeConfiguration,
	PublicationOutcome,
	WorkCapacityPolicy,
	WorkExecutionMode,
	WorkGraphId,
	WorkItemId,
	WorkRunEvidence,
	WorkSessionTarget,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import type { WorkerControlEvent } from "./worker-protocol.ts";

export type WorkspaceEffect = "read" | "write" | "unknown";

export interface RuntimeClock {
	now(): number;
}

export interface RuntimeSleeper {
	wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeRandomSource {
	next(): number;
}

export interface RuntimeScheduledTask {
	cancel(): void;
}

export interface RuntimeScheduler {
	schedule(delayMs: number, run: () => void | Promise<void>): RuntimeScheduledTask;
}

/** Runtime-owned timing capabilities; composition roots may pass any structural adapter. */
export interface RuntimeTime {
	readonly clock: RuntimeClock;
	readonly sleep: RuntimeSleeper;
	readonly random: RuntimeRandomSource;
	readonly scheduler: RuntimeScheduler;
}

export type WorkerSelection = RunModelSelection;

/** Owns generation of runtime identities. */
export type Identity = IdGenerator;

/** Owns immutable Observation sequencing and bounded subscriber delivery. */
export interface ObservationBus {
	readonly sequence: number;
	subscribe(capacity: number): AsyncIterable<CodingAgentObservation>;
	publish(factory: (sequence: number) => CodingAgentObservation): number;
	closeAll(): void;
}

/** Owns Desired Runtime Configuration resolution and Model Driver leasing. */
export interface RunModelProvider {
	resolve(configuration: DesiredRuntimeConfiguration, signal: AbortSignal): WorkerSelection | Promise<WorkerSelection>;
	lease(selection: WorkerSelection, signal: AbortSignal): ModelDriverLease | Promise<ModelDriverLease>;
}

/** Optional application-side sink for physical worker controls. */
export interface WorkerControlSink {
	accept(event: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly runtimeId: string;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
		readonly event: WorkerControlEvent;
	}): Promise<void> | void;
}

export type WorkspaceToolContribution = RunToolContribution;

export interface WorkSessionReservation {
	readonly session: Session;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	release(): Promise<void>;
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

export interface WorkspacePlacement {
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
	release(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly placement: WorkspacePlacementDescriptor;
		readonly preserve: boolean;
	}): Promise<void>;
	close(): Promise<void>;
}

export interface WorkspaceTooling {
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
}

export interface WorkspacePublication {
	publish(request: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly artifact: WorkspaceArtifact;
		readonly placement: WorkspacePlacementDescriptor;
		readonly target?: WorkspacePlacementDescriptor;
		readonly signal: AbortSignal;
	}): Promise<PublicationOutcome>;
}

export interface WorkspaceExecution {
	readonly placement: WorkspacePlacement;
	readonly tooling: WorkspaceTooling;
	readonly publication: WorkspacePublication;
}

/** Owns fairness state while selecting the next runnable candidate. */
export interface WorkAdmission {
	reserve(): { readonly ready: Promise<void>; release(): void };
	mutation<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
	select<Candidate>(request: {
		readonly activeProcessConcurrency: number;
		readonly graphs: readonly {
			readonly graphId: string;
			readonly activeConcurrency: number;
			readonly maximumConcurrency: number;
			next(): Candidate | undefined;
		}[];
	}): Candidate | undefined;
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

export interface WorkGraphStoreRestore {
	/** Opaque runtime-owned replay value. Persistence adapters must not interpret it. */
	readonly restore: unknown;
	readonly diagnostics: readonly string[];
}

export interface WorkGraphStore {
	load(): Promise<WorkGraphStoreRestore>;
	/** Appends one atomic semantic segment; recovery sees all Facts or none. */
	append(commit: unknown): Promise<void>;
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
	readonly time: RuntimeTime;
	readonly identity: Identity;
	readonly modelProvider: RunModelProvider;
	readonly capabilitySources: readonly RunCapabilitySource[];
	readonly placement: WorkspacePlacement;
	readonly tooling: WorkspaceTooling;
	readonly publication: WorkspacePublication;
	readonly sessions: WorkSessionStore;
	readonly resources?: InputResourceStore;
	readonly persistence?: WorkspacePersistence;
	readonly admission?: WorkAdmission;
	readonly observationBus?: ObservationBus;
	readonly capacity: WorkCapacityPolicy;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print" | "evaluation";
	readonly projectInstructions?: (
		placement: WorkspacePlacementDescriptor,
	) => TrustedProjectInstructions | undefined | Promise<TrustedProjectInstructions | undefined>;
	readonly systemPrompt?: SystemPromptSnapshot;
	readonly workerControl?: WorkerControlSink;
}
