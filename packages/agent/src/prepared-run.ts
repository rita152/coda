import type { PrepareRun, StaticRunPreparation } from "./types.ts";

/**
 * Adapts one static execution capability to the per-Run preparation Interface.
 * Dynamic consumers should implement `prepareRun` directly.
 */
export function prepareStaticRun(prepared: StaticRunPreparation): PrepareRun {
	const snapshot = Object.freeze({ ...prepared });
	return () => snapshot;
}
