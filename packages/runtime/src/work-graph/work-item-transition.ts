import type { WorkItemState, WorkResult } from "./types.ts";

const TERMINAL_WORK_ITEM_STATES = new Set<WorkItemState>(["succeeded", "failed", "canceled", "interrupted", "blocked"]);

const WORK_ITEM_TRANSITIONS: Readonly<Record<Exclude<WorkItemState, WorkResult["state"]>, readonly WorkItemState[]>> =
	Object.freeze({
		pending: Object.freeze(["ready", "blocked", "canceled", "interrupted"] as WorkItemState[]),
		ready: Object.freeze(["preparing", "blocked", "canceled", "interrupted"] as WorkItemState[]),
		preparing: Object.freeze(["running", "settling", "canceled", "failed", "interrupted"] as WorkItemState[]),
		running: Object.freeze(["settling", "canceled", "failed", "interrupted"] as WorkItemState[]),
		settling: Object.freeze(["succeeded", "failed", "canceled", "interrupted"] as WorkItemState[]),
	});

export function isTerminalWorkItemState(state: WorkItemState): state is WorkResult["state"] {
	return TERMINAL_WORK_ITEM_STATES.has(state);
}

export type WorkItemTransitionCause = "item_transitioned" | "run_started";

export function workItemTransitionPermitted(
	from: WorkItemState,
	to: WorkItemState,
	cause: WorkItemTransitionCause = "item_transitioned",
): boolean {
	if (isTerminalWorkItemState(from) || !WORK_ITEM_TRANSITIONS[from].includes(to)) return false;
	return to !== "running" || cause === "run_started";
}
