export type ComposerSubmissionKind = "follow_up" | "prompt" | "steering";

export interface ComposerExtensionReference {
	/** Opaque identity of this selected extension occurrence. */
	readonly id: string;
	readonly commandId: string;
	readonly source: "skill" | "mcp";
	readonly name: string;
	/** UTF-16 offsets into ComposerSubmission.text. */
	readonly start: number;
	readonly end: number;
}

export interface ComposerSubmission {
	readonly id: string;
	readonly kind: ComposerSubmissionKind;
	/** Text as it appeared in the Composer, including a leading `\\!` escape. */
	readonly text: string;
	readonly references?: readonly ComposerExtensionReference[];
	readonly queueItemId?: string;
}

export interface UserShellSubmission {
	readonly id: string;
	readonly command: string;
}
