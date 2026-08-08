import type { Clock, TimeRuntime } from "@coda/ai";

export function testTimeRuntime(clockOrValue: Clock | number = 0): TimeRuntime {
	const clock = typeof clockOrValue === "number" ? { now: () => clockOrValue } : clockOrValue;
	return {
		clock,
		random: { next: () => 0 },
		sleep: { wait: async () => {} },
	};
}
