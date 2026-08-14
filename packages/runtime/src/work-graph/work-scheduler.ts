import type { WorkCapacityPolicy } from "./types.ts";

export interface SchedulableWorkGraph<Work> {
	readonly graphId: string;
	readonly activeConcurrency: number;
	readonly maximumConcurrency: number;
	next(): Work | undefined;
}

/** Deterministic round-robin selection across accepted Work Graphs. */
export class WorkScheduler {
	readonly #capacity: WorkCapacityPolicy;
	#lastGraphId?: string;

	constructor(capacity: WorkCapacityPolicy) {
		for (const name of ["processMaximumConcurrency", "graphMaximumConcurrency"] as const) {
			const value = capacity[name];
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error(`${name} must be a positive safe integer`);
			}
		}
		this.#capacity = Object.freeze({ ...capacity });
	}

	next<Work>(request: {
		readonly activeProcessConcurrency: number;
		readonly graphs: readonly SchedulableWorkGraph<Work>[];
	}): Work | undefined {
		if (request.activeProcessConcurrency >= this.#capacity.processMaximumConcurrency) return undefined;
		if (request.graphs.length === 0) return undefined;

		const previous = this.#lastGraphId
			? request.graphs.findIndex(({ graphId }) => graphId === this.#lastGraphId)
			: -1;
		const start = previous < 0 ? 0 : (previous + 1) % request.graphs.length;
		for (let offset = 0; offset < request.graphs.length; offset++) {
			const graph = request.graphs[(start + offset) % request.graphs.length]!;
			if (graph.activeConcurrency >= graph.maximumConcurrency) continue;
			const work = graph.next();
			if (work === undefined) continue;
			this.#lastGraphId = graph.graphId;
			return work;
		}
		return undefined;
	}
}
