import type { Session } from "../session/types.ts";

export type SessionPresentation = Pick<
	Session,
	| "descriptor"
	| "hasRetainedActivity"
	| "title"
	| "seed"
	| "recoverableFollowUps"
	| "composerSubmissions"
	| "toolInvocations"
	| "runEvidence"
	| "compactionCheckpoint"
	| "mediaReferences"
>;
