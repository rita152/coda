import type { WorkAdmission } from "./ports.ts";
import type { WorkCapacityPolicy } from "./types.ts";

/** Owns deterministic round-robin admission position across Work Graphs. */
export class AdmissionController implements WorkAdmission {
	readonly #capacity: WorkCapacityPolicy;
	#lastGraphId?: string;
	#admissionTail: Promise<void> = Promise.resolve();
	#mutationTail: Promise<void> = Promise.resolve();

	constructor(capacity: WorkCapacityPolicy) {
		for (const name of ["processMaximumConcurrency", "graphMaximumConcurrency"] as const) {
			const value = capacity[name];
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error(`${name} must be a positive safe integer`);
			}
		}
		this.#capacity = Object.freeze({ ...capacity });
	}

	reserve(): { readonly ready: Promise<void>; release(): void } {
		const ready = this.#admissionTail;
		let finish!: () => void;
		const completed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.#admissionTail = ready.then(() => completed);
		let released = false;
		return {
			ready,
			release: () => {
				if (released) return;
				released = true;
				finish();
			},
		};
	}

	async mutation<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#mutationTail;
		this.#mutationTail = previous.then(() => turn);
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	select<Candidate>(request: {
		readonly activeProcessConcurrency: number;
		readonly graphs: readonly {
			readonly graphId: string;
			readonly activeConcurrency: number;
			readonly maximumConcurrency: number;
			next(): Candidate | undefined;
		}[];
	}): Candidate | undefined {
		if (request.activeProcessConcurrency >= this.#capacity.processMaximumConcurrency) return undefined;
		if (request.graphs.length === 0) return undefined;
		const previous = this.#lastGraphId
			? request.graphs.findIndex(({ graphId }) => graphId === this.#lastGraphId)
			: -1;
		const start = previous < 0 ? 0 : (previous + 1) % request.graphs.length;
		for (let offset = 0; offset < request.graphs.length; offset++) {
			const graph = request.graphs[(start + offset) % request.graphs.length]!;
			if (graph.activeConcurrency >= graph.maximumConcurrency) continue;
			const candidate = graph.next();
			if (candidate === undefined) continue;
			this.#lastGraphId = graph.graphId;
			return candidate;
		}
		return undefined;
	}
}

export function createWorkAdmission(capacity: WorkCapacityPolicy): WorkAdmission {
	return new AdmissionController(capacity);
}
