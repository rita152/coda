import type {
	CodingAgent,
	CodingAgentCloseResult,
	CodingAgentCommandBatch,
	CodingAgentObservation,
	CodingAgentReceipt,
	ObservationOptions,
} from "./types.ts";
import type { WorkGraphEngine } from "./work-graph-engine.ts";

/** Public-contract adapter. All Work Graph mechanisms live behind the engine ports. */
export class WorkCoordinator implements CodingAgent {
	readonly #engine: WorkGraphEngine;

	constructor(engine: WorkGraphEngine) {
		this.#engine = engine;
	}

	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		return this.#engine.submit(batch);
	}

	observe(options?: ObservationOptions): AsyncIterable<CodingAgentObservation> {
		return this.#engine.observe(options);
	}

	close(): Promise<CodingAgentCloseResult> {
		return this.#engine.close();
	}
}
