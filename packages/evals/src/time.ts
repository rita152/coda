export class DeterministicTimeRuntime {
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

	readonly scheduler = {
		schedule: (delayMs: number, run: () => void | Promise<void>) => {
			let canceled = false;
			queueMicrotask(() => {
				if (canceled) return;
				this.advance(Math.max(0, delayMs));
				void run();
			});
			return {
				cancel: () => {
					canceled = true;
				},
			};
		},
	};

	advance(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Elapsed time must be non-negative");
		this.#time += milliseconds;
	}
}
