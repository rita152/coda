import type { TimeRuntime } from "../src/index.ts";

export function testTimeRuntime(now = 0): TimeRuntime {
	return {
		clock: { now: () => now },
		random: { next: () => 0 },
		scheduler: { schedule: () => ({ cancel: () => undefined }) },
		sleep: { wait: async () => {} },
	};
}
