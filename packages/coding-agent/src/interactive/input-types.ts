export type ComposerSubmissionKind = "follow_up" | "prompt" | "steering";

export interface ComposerSubmission {
	readonly id: string;
	readonly kind: ComposerSubmissionKind;
	/** Text as it appeared in the Composer, including a leading `\\!` escape. */
	readonly text: string;
	readonly queueItemId?: string;
}

export interface UserShellSubmission {
	readonly id: string;
	readonly command: string;
}
