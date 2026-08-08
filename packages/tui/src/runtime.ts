import { performance } from "node:perf_hooks";

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
	return { now: () => performance.now() };
}

export function createSystemScheduler(): Scheduler {
	return {
		schedule(delayMs, run) {
			const timer = setTimeout(() => {
				void run();
			}, delayMs);
			return { cancel: () => clearTimeout(timer) };
		},
	};
}
