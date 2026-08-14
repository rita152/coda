import type {
	AgentEvent,
	AgentInput,
	AgentSeed,
	AgentState,
	Clock,
	IdGenerator,
	PreparedRun,
	QueueItemId,
	RunPreparation,
	RunResult,
} from "@coda/agent";

declare const runtimeIdentity: unique symbol;

export type RuntimeId = string & { readonly [runtimeIdentity]: "RuntimeId" };
export type RuntimeSessionId = string & { readonly [runtimeIdentity]: "RuntimeSessionId" };

export interface RuntimeSession {
	readonly id: RuntimeSessionId | string;
	readonly seed?: AgentSeed;
	accept(event: AgentEvent): Promise<void> | void;
	close(): Promise<void>;
}

export interface RuntimePreparation<TConfiguration> extends RunPreparation {
	readonly runtimeId: RuntimeId;
	readonly sessionId: RuntimeSessionId;
	readonly configuration: Readonly<TConfiguration>;
}

export interface RuntimePreparedRun<TActiveSnapshot> extends PreparedRun {
	readonly snapshot: Readonly<TActiveSnapshot>;
}

export type RuntimePrepareRun<TConfiguration, TActiveSnapshot> = (
	preparation: RuntimePreparation<TConfiguration>,
) => RuntimePreparedRun<TActiveSnapshot> | Promise<RuntimePreparedRun<TActiveSnapshot>>;

export interface ActiveRuntimeRun<TConfiguration, TActiveSnapshot> {
	readonly runId: string;
	readonly configuration: Readonly<TConfiguration>;
	readonly prepared: Readonly<TActiveSnapshot>;
}

export interface AgentRuntimeSnapshot<TConfiguration, TActiveSnapshot> {
	readonly runtimeId: RuntimeId;
	readonly sessionId: RuntimeSessionId;
	readonly closed: boolean;
	readonly desired: Readonly<TConfiguration>;
	readonly activeRun?: ActiveRuntimeRun<TConfiguration, TActiveSnapshot>;
	readonly agent: AgentState;
}

export type AgentRuntimeEvent =
	| {
			readonly type: "agent";
			readonly runtimeId: RuntimeId;
			readonly sessionId: RuntimeSessionId;
			readonly runId: string;
			readonly event: AgentEvent;
	  }
	| {
			readonly type: "closed";
			readonly runtimeId: RuntimeId;
			readonly sessionId: RuntimeSessionId;
	  };

export type AgentRuntimeListener = (event: AgentRuntimeEvent) => Promise<void> | void;

export type RuntimeCommand =
	| { readonly type: "prompt"; readonly input: AgentInput }
	| { readonly type: "steer"; readonly input: AgentInput }
	| { readonly type: "follow_up"; readonly input: AgentInput }
	| { readonly type: "run_next_follow_up" }
	| { readonly type: "resume_follow_ups" }
	| { readonly type: "cancel"; readonly queueItemId?: QueueItemId };

export type RuntimeCommandResult = RunResult | QueueItemId | undefined;

export interface AgentRuntime<TConfiguration extends object, TActiveSnapshot> {
	readonly runtimeId: RuntimeId;
	readonly sessionId: RuntimeSessionId;
	snapshot(): AgentRuntimeSnapshot<TConfiguration, TActiveSnapshot>;
	updateConfiguration(configuration: TConfiguration): void;
	prompt(input: AgentInput): Promise<RunResult>;
	steer(input: AgentInput): QueueItemId;
	followUp(input: AgentInput): QueueItemId;
	cancel(queueItemId?: QueueItemId): void;
	dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult>;
	waitForIdle(): Promise<void>;
	subscribe(listener: AgentRuntimeListener): () => void;
	close(): Promise<void>;
}

export interface OpenAgentRuntimeOptions<TConfiguration extends object, TActiveSnapshot> {
	readonly runtimeId: RuntimeId | string;
	readonly session: RuntimeSession;
	readonly configuration: TConfiguration;
	readonly prepareRun: RuntimePrepareRun<TConfiguration, TActiveSnapshot>;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly retry?: ConstructorParameters<typeof import("@coda/agent").Agent>[0]["retry"];
	readonly runBudget?: ConstructorParameters<typeof import("@coda/agent").Agent>[0]["runBudget"];
	readonly autoDrainFollowUps?: boolean;
}
