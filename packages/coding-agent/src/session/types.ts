import type {
	Agent,
	AgentSeed,
	Clock,
	FollowUp,
	IdGenerator,
	Immutable,
	MessageId,
	QueueItemId,
	RunFailure,
	ToolInvocation,
	ToolRejectionReason,
} from "@coda/agent";
import type { ThinkingLevel } from "@coda/ai";
import type { ModelSelection, ProjectTrustRecord } from "../application.ts";
import type { ComposerSubmission } from "../interactive/input-types.ts";

declare const sessionIdBrand: unique symbol;
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };

export interface SessionWorkspace {
	readonly id: string;
	readonly path: string;
}

export interface SessionDescriptor {
	readonly id: SessionId;
	readonly workspace: SessionWorkspace;
	readonly createdAt: number;
	readonly persistent: boolean;
	readonly path?: string;
}

export interface RestoredSessionState {
	readonly model?: ModelSelection;
	readonly reasoning?: ThinkingLevel | "off";
	readonly projectTrust?: ProjectTrustRecord;
}

export interface SessionMediaRendition {
	readonly digest: string;
	readonly mimeType: string;
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
}

export interface SessionMediaReference {
	readonly type: "media";
	readonly digest: string;
	readonly filename: string;
	readonly mimeType: string;
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	readonly rendition: SessionMediaRendition;
}

export interface SessionMediaRegistration {
	readonly reference: SessionMediaReference;
	readonly modelPath: string;
}

export interface RecoverableFollowUp {
	readonly item: FollowUp;
	readonly state: "paused" | "failed";
	readonly failure?: RunFailure;
	readonly messageId?: MessageId;
}

export interface SessionToolLifecycle {
	readonly invocation: Immutable<ToolInvocation>;
	readonly runId?: string;
	readonly turnId?: string;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly outcome?: "success" | "error" | "aborted" | "rejected" | "interrupted";
	readonly rejectionReason?: ToolRejectionReason;
	readonly resultMessageId?: MessageId;
}

export interface OpenSessionRequest {
	readonly workspace: SessionWorkspace;
	readonly mode: "interactive" | "print";
	readonly resumeId?: SessionId | string;
	readonly forceUnlock?: boolean;
	readonly persistent?: boolean;
}

export type SessionChange =
	| {
			readonly type: "prepare_run";
			readonly promptVersion: string;
			readonly promptSha256: string;
	  }
	| {
			readonly type: "model_selected";
			readonly model: ModelSelection;
			readonly reasoning: ThinkingLevel | "off";
	  }
	| { readonly type: "project_trust_changed"; readonly trust: ProjectTrustRecord }
	| { readonly type: "follow_up_enqueued"; readonly item: FollowUp }
	| { readonly type: "composer_submission_recorded"; readonly submission: ComposerSubmission }
	| { readonly type: "composer_submission_retracted"; readonly id: string }
	| {
			readonly type: "follow_up_consumed" | "follow_up_canceled" | "follow_up_reclaimed";
			readonly id: QueueItemId;
	  };

export type DetachSession = () => void;

export interface Session {
	readonly descriptor: SessionDescriptor;
	readonly seed: AgentSeed;
	readonly restored: RestoredSessionState;
	readonly recoverableFollowUps: readonly RecoverableFollowUp[];
	readonly composerSubmissions: readonly ComposerSubmission[];
	readonly toolInvocations: readonly SessionToolLifecycle[];
	readonly mediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]>;
	registerMedia(registrations: readonly SessionMediaRegistration[]): void;
	attach(agent: Agent): DetachSession;
	record(change: SessionChange): Promise<void>;
	close(): Promise<void>;
}

export interface SessionManager {
	open(request: OpenSessionRequest): Promise<Session>;
	list(workspace: SessionWorkspace): Promise<readonly SessionDescriptor[]>;
}

export interface SessionRuntime {
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
}

export interface PersistedMessageReference {
	readonly id: MessageId;
	readonly message: Immutable<AgentSeed["messages"][number]["message"]>;
}
