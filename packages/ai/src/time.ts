import type { Clock, RandomSource, Scheduler, Sleeper, TimeRuntime } from "./types.ts";

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
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

export interface SystemTimeRuntimeOptions {
	readonly clock?: Clock;
	readonly scheduler?: Scheduler;
	readonly sleep?: Sleeper;
	readonly random?: RandomSource;
}

export function createSystemTimeRuntime(options: SystemTimeRuntimeOptions = {}): TimeRuntime {
	const scheduler = options.scheduler ?? createSystemScheduler();
	const sleep =
		options.sleep ??
		({
			wait: (delayMs, signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal?.aborted) {
						reject(abortError());
						return;
					}
					let settled = false;
					let task: ReturnType<Scheduler["schedule"]> | undefined;
					const onAbort = (): void => {
						task?.cancel();
						finish(abortError());
					};
					const finish = (error?: Error): void => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else resolve();
					};
					task = scheduler.schedule(delayMs, () => finish());
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				}),
		} satisfies Sleeper);
	return {
		clock: options.clock ?? createSystemClock(),
		scheduler,
		sleep,
		random: options.random ?? { next: () => Math.random() },
	};
}
