import type { RetryOptions } from "@coda/agent";
import type { RuntimeScheduler } from "./work-graph/ports.ts";

const DELAYS = [2_000, 4_000, 8_000] as const;

function abortError(): Error {
	const error = new Error("Retry wait was aborted");
	error.name = "AbortError";
	return error;
}

export function createCodingAgentRetry(scheduler: RuntimeScheduler): RetryOptions {
	return {
		policy: {
			decide: async ({ attempt, transient }) => {
				const delayMs = DELAYS[attempt - 1];
				if (!transient || delayMs === undefined) return { retry: false };
				return {
					retry: true,
					delayMs,
					reason: `transient model failure (retry ${attempt}/${DELAYS.length})`,
				};
			},
		},
		delay: {
			wait: (delayMs, signal) => {
				if (signal.aborted) return Promise.reject(abortError());
				return new Promise<void>((resolve, reject) => {
					let task: ReturnType<RuntimeScheduler["schedule"]> | undefined;
					let settled = false;
					const finish = (error?: Error): void => {
						if (settled) return;
						settled = true;
						signal.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else resolve();
					};
					const onAbort = (): void => {
						task?.cancel();
						finish(abortError());
					};
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) {
						onAbort();
						return;
					}
					task = scheduler.schedule(delayMs, () => finish());
					if (signal.aborted) onAbort();
				});
			},
		},
	};
}
