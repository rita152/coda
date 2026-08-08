export type AgentErrorCode =
	| "busy"
	| "invalid_input"
	| "invalid_seed"
	| "invalid_lifecycle"
	| "queue_item_not_found"
	| "queue_item_not_cancellable"
	| "listener_failed";

export class AgentError extends Error {
	readonly code: AgentErrorCode;

	constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentError";
		this.code = code;
	}
}
