export interface Clock {
	now(): number;
}

export interface ScheduledTask {
	cancel(): void;
}

export interface Scheduler {
	schedule(delayMs: number, run: () => void | Promise<void>): ScheduledTask;
}

export function createSystemClock(): Clock {
	return { now: () => globalThis.performance.now() };
}

export function createSystemScheduler(): Scheduler {
	return {
		schedule(delayMs, run) {
			const timer = setTimeout(
				() => {
					void run();
				},
				Math.max(0, delayMs),
			);
			return { cancel: () => clearTimeout(timer) };
		},
	};
}
