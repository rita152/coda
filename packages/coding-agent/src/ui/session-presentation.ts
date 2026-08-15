import type { Session } from "../session/types.ts";

export type SessionPresentation = Pick<
	Session,
	| "descriptor"
	| "seed"
	| "recoverableFollowUps"
	| "composerSubmissions"
	| "toolInvocations"
	| "runEvidence"
	| "compactionCheckpoint"
	| "mediaReferences"
>;
