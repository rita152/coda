import type { Session } from "../session/types.ts";
import type { SessionPresentation } from "../ui/session-presentation.ts";

/** Live read-only application projection consumed by UI. */
export function createSessionPresentation(session: Session): SessionPresentation {
	return Object.freeze({
		get descriptor() {
			return session.descriptor;
		},
		get seed() {
			return session.seed;
		},
		get recoverableFollowUps() {
			return session.recoverableFollowUps;
		},
		get composerSubmissions() {
			return session.composerSubmissions;
		},
		get toolInvocations() {
			return session.toolInvocations;
		},
		get runEvidence() {
			return session.runEvidence;
		},
		get compactionCheckpoint() {
			return session.compactionCheckpoint;
		},
		get mediaReferences() {
			return session.mediaReferences;
		},
	});
}
