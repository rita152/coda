import type { AgentEvent } from "@coda/agent";

export const JSON_AGENT_EVENT_SCHEMA_VERSION = 2;
/** Version of the semantic event-selection policy; retained Agent envelopes remain JSONL v2. */
export const SEMANTIC_JSON_EVENT_STREAM_SCHEMA_VERSION = 1;

export type JsonEventStreamMode = "raw" | "semantic";

export interface JsonRunStartMetadata {
	readonly model: {
		readonly provider: string;
		readonly id: string;
	};
	readonly reasoning: string;
	readonly prompt: {
		readonly version: string;
		readonly sha256: string;
	};
	readonly permissions: {
		readonly profile: string;
		readonly approvalPolicy: string;
	};
}

export interface JsonEventOutput {
	write(chunk: string): void | Promise<void>;
}

export interface JsonEventWriterOptions {
	readonly mode: JsonEventStreamMode;
	readonly output: JsonEventOutput;
	readonly project?: (value: unknown) => unknown;
}

const SEMANTIC_TRANSIENT_EVENT_TYPES: ReadonlySet<AgentEvent["type"]> = new Set([
	"message_update",
	"tool_execution_progress",
]);

/**
 * Serializes the stable print-mode JSONL contract while keeping stream policy
 * independent from the Coding Agent application composition root.
 */
export class JsonEventWriter {
	readonly #mode: JsonEventStreamMode;
	readonly #output: JsonEventOutput;
	readonly #project: (value: unknown) => unknown;

	constructor(options: JsonEventWriterOptions) {
		this.#mode = options.mode;
		this.#output = options.output;
		this.#project = options.project ?? ((value) => value);
	}

	async writeAgentEvent(event: AgentEvent, runStart?: JsonRunStartMetadata): Promise<boolean> {
		if (this.#mode === "semantic" && SEMANTIC_TRANSIENT_EVENT_TYPES.has(event.type)) return false;
		let envelope: unknown;
		if (event.type === "run_start") {
			if (!runStart) throw new Error("run_start JSON metadata is required");
			envelope = { schemaVersion: JSON_AGENT_EVENT_SCHEMA_VERSION, ...event, ...runStart };
		} else {
			envelope = { schemaVersion: JSON_AGENT_EVENT_SCHEMA_VERSION, ...event };
		}
		await this.#write(envelope, true);
		return true;
	}

	async writeRecord(value: unknown): Promise<void> {
		await this.#write(value, false);
	}

	async #write(value: unknown, project: boolean): Promise<void> {
		await this.#output.write(`${JSON.stringify(project ? this.#project(value) : value)}\n`);
	}
}
