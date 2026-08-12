import type { TimeRuntime } from "@coda/ai";

export class DeterministicTimeRuntime implements TimeRuntime {
	#time = 0;

	readonly clock = {
		now: (): number => this.#time,
	};

	readonly sleep = {
		wait: async (delayMs: number, signal?: AbortSignal): Promise<void> => {
			signal?.throwIfAborted();
			this.advance(delayMs);
		},
	};

	readonly random = {
		next: (): number => 0.5,
	};

	advance(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Elapsed time must be non-negative");
		this.#time += milliseconds;
	}
}
