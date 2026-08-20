import type { AgentInput } from "@coda/agent";
import type { RunCapabilitySelections } from "../session/composer-submission.ts";

/** Model-visible input plus host-only capability selection for one future Run. */
export interface PreparedWorkInput {
	readonly input: AgentInput;
	readonly capabilitySelections?: RunCapabilitySelections;
}

export interface UserShellSubmission {
	readonly id: string;
	readonly command: string;
}
