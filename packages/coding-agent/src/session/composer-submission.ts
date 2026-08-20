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

/** Durable input fact shared by the Session Adapter and interactive presentation. */
export interface ComposerSubmission {
	readonly id: string;
	readonly kind: ComposerSubmissionKind;
	/** Text as it appeared in the Composer, including a leading `\\!` escape. */
	readonly text: string;
	readonly references?: readonly ComposerExtensionReference[];
	readonly queueItemId?: string;
	/** Host-only selection retained so a durable Follow-up recreates the same Run catalog. */
	readonly capabilitySelections?: RunCapabilitySelections;
}

export type RunCapabilitySelectionValue =
	| null
	| boolean
	| number
	| string
	| readonly RunCapabilitySelectionValue[]
	| { readonly [key: string]: RunCapabilitySelectionValue };

export type RunCapabilitySelections = Readonly<Record<string, RunCapabilitySelectionValue>>;
