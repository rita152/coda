import type {
	AgentEvent,
	AgentInput,
	AgentSeed,
	AgentTool,
	Clock,
	IdGenerator,
	RunBudget,
	ToolExecutionContext,
	ToolExecutionOutput,
} from "@coda/agent";
import type { Api, AuthResult, JsonValue, Model, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult, McpToolSnapshot } from "@coda/mcp";
import type { CompactionCheckpoint } from "../context-window/types.ts";
import type { McpAgentElicitation } from "../mcp/tools.ts";
import type { SystemPromptSnapshot, TrustedProjectInstructions } from "../prompt/prompt-builder.ts";
import type { RuntimeScheduler } from "../retry.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
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
import type { WorkerRuntimeEvent } from "./worker-protocol.ts";

export type WorkspaceEffect = "read" | "write" | "unknown";

export interface WorkerSelection {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot?: AuthResult;
}

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
	accept(event: AgentEvent): Promise<void> | void;
	record(change: WorkerSessionChange): Promise<void>;
	close(): Promise<void>;
}

export interface WorkerSkillsSource {
	readonly initial: CodingSkillsSnapshot;
	current(): CodingSkillsSnapshot | undefined;
	refresh(): Promise<CodingSkillsSnapshot>;
	synchronize?(snapshot: CodingSkillsSnapshot): void;
}

export interface WorkerMcpSource {
	current(): McpToolSnapshot;
	refresh?(): Promise<void>;
}

export interface WorkspaceToolContribution {
	readonly tool: AgentTool;
	readonly effect: WorkspaceEffect;
	/** Reuse an already retained Workspace lease, such as control of a running background Process. */
	readonly leaseIdentity?: (arguments_: unknown) => string | undefined;
	readonly retainLease?: (
		output: ToolExecutionOutput,
		context: ToolExecutionContext,
	) => { readonly identity: string; readonly settled: Promise<void> } | undefined;
}

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

export type WorkJournalRecord =
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
			readonly type: "worker_event";
			readonly graphId: WorkGraphId;
			readonly itemId: WorkItemId;
			readonly runtimeId: string;
			readonly sessionId: string;
			readonly event: WorkerRuntimeEvent;
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

export interface WorkJournalRestore {
	readonly records: readonly WorkJournalRecord[];
	readonly diagnostics: readonly string[];
}

export interface WorkJournal {
	load(): Promise<WorkJournalRestore>;
	append(record: WorkJournalRecord): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

export interface OpenCodingAgentOptions {
	readonly workspaceExecution: WorkspaceExecution;
	readonly sessions: WorkSessionStore;
	readonly resources?: InputResourceStore;
	readonly journal?: WorkJournal;
	readonly models: Pick<Models, "completeSimple" | "streamSimple">;
	readonly resolveConfiguration: (
		configuration: DesiredRuntimeConfiguration,
	) => WorkerSelection | Promise<WorkerSelection>;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly processMaximumConcurrency?: number;
	readonly scheduler?: RuntimeScheduler;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print" | "evaluation";
	readonly projectInstructions?: (
		placement: WorkspacePlacementDescriptor,
	) => TrustedProjectInstructions | undefined | Promise<TrustedProjectInstructions | undefined>;
	readonly systemPrompt?: SystemPromptSnapshot;
	readonly skills: WorkerSkillsSource;
	readonly mcp: WorkerMcpSource;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly controlWorkerEvent?: (event: {
		readonly graphId: WorkGraphId;
		readonly itemId: WorkItemId;
		readonly runtimeId: string;
		readonly sessionId: string;
		readonly placement: WorkspacePlacementDescriptor;
		readonly event: WorkerRuntimeEvent;
	}) => Promise<void> | void;
}
