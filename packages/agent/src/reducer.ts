import type { ToolResultMessage } from "@coda/ai";
import { deepFreeze } from "./immutable.ts";
import type { AgentEvent, AgentMessage, AgentState, FollowUp, Steering } from "./types.ts";

interface ToolBatchState {
	readonly count: number;
	readonly nextIndex: number;
	readonly pending: ReadonlyMap<number, AgentMessage<ToolResultMessage>>;
}

export interface RuntimeState {
	readonly public: AgentState;
	readonly toolBatch?: ToolBatchState;
}

export type StateAction =
	| { readonly type: "event"; readonly event: AgentEvent }
	| { readonly type: "settled" }
	| { readonly type: "queue_steering"; readonly item: Steering }
	| { readonly type: "queue_follow_up"; readonly item: FollowUp }
	| { readonly type: "restore_follow_up"; readonly item: FollowUp }
	| { readonly type: "remove_queue_item"; readonly id: string }
	| { readonly type: "clear_steering" };

export function initialRuntimeState(
	messages: readonly AgentMessage[] = [],
	pendingFollowUps: readonly FollowUp[] = [],
): RuntimeState {
	return deepFreeze({
		public: {
			status: "idle",
			messages: [...messages],
			pendingSteering: [],
			pendingFollowUps: [...pendingFollowUps],
		},
	});
}

function appendToolResult(
	state: RuntimeState,
	sourceIndex: number,
	result: AgentMessage<ToolResultMessage>,
): RuntimeState {
	const batch = state.toolBatch;
	if (!batch) throw new Error("Tool result arrived without an active Tool batch");
	if (sourceIndex < 0 || sourceIndex >= batch.count) throw new Error("Tool result source index is out of range");
	if (batch.pending.has(sourceIndex) || sourceIndex < batch.nextIndex) {
		throw new Error("Tool result arrived more than once");
	}
	const pending = new Map(batch.pending);
	pending.set(sourceIndex, result);
	const messages = [...state.public.messages];
	let nextIndex = batch.nextIndex;
	while (pending.has(nextIndex)) {
		messages.push(pending.get(nextIndex)!);
		pending.delete(nextIndex);
		nextIndex++;
	}
	return {
		public: { ...state.public, messages },
		toolBatch: nextIndex === batch.count ? undefined : { count: batch.count, nextIndex, pending },
	};
}

function reduceEvent(state: RuntimeState, event: AgentEvent): RuntimeState {
	switch (event.type) {
		case "run_start":
			if (state.public.status !== "idle") throw new Error("Cannot start a Run unless the Agent is idle");
			return {
				public: {
					...state.public,
					status: "running",
					activeRun: {
						id: event.runId,
						source: event.source,
						queueItemId: event.queueItemId,
						...(event.budget ? { budget: event.budget } : {}),
					},
					messages: [...state.public.messages, event.inputMessage],
				},
			};
		case "turn_start":
			return {
				...state,
				public: {
					...state.public,
					activeTurnId: event.turnId,
					messages: [...state.public.messages, ...event.steeringMessages],
				},
			};
		case "message_end": {
			const toolCount = event.message.message.content.filter((block) => block.type === "toolCall").length;
			return {
				public: { ...state.public, messages: [...state.public.messages, event.message] },
				toolBatch: toolCount > 0 ? { count: toolCount, nextIndex: 0, pending: new Map() } : undefined,
			};
		}
		case "tool_execution_rejected":
		case "tool_execution_end":
			return appendToolResult(state, event.invocation.sourceIndex, event.result as AgentMessage<ToolResultMessage>);
		case "turn_end":
			if (state.toolBatch && event.outcome === "success") {
				throw new Error("A successful Turn cannot end with unresolved Tool results");
			}
			return { public: { ...state.public, activeTurnId: undefined } };
		case "run_budget_exhausted":
			if (!state.public.activeRun) throw new Error("Run budget exhausted without an active Run");
			return {
				...state,
				public: {
					...state.public,
					activeRun: { ...state.public.activeRun, budgetExhaustion: event.exhaustion },
				},
			};
		case "run_end":
			return {
				...state,
				public: {
					...state.public,
					status: "settling",
					activeTurnId: undefined,
					lastRun: { id: event.runId, outcome: event.outcome, failure: event.failure },
				},
			};
		default:
			return state;
	}
}

export function reduceState(state: RuntimeState, action: StateAction): RuntimeState {
	let next: RuntimeState;
	switch (action.type) {
		case "event":
			next = reduceEvent(state, action.event);
			break;
		case "settled":
			next = {
				...state,
				public: { ...state.public, status: "idle", activeRun: undefined, activeTurnId: undefined },
			};
			break;
		case "queue_steering":
			next = {
				...state,
				public: {
					...state.public,
					pendingSteering: [...state.public.pendingSteering, action.item],
				},
			};
			break;
		case "queue_follow_up":
			next = {
				...state,
				public: {
					...state.public,
					pendingFollowUps: [...state.public.pendingFollowUps, action.item],
				},
			};
			break;
		case "restore_follow_up":
			next = {
				...state,
				public: {
					...state.public,
					pendingFollowUps: [action.item, ...state.public.pendingFollowUps],
				},
			};
			break;
		case "remove_queue_item":
			next = {
				...state,
				public: {
					...state.public,
					pendingSteering: state.public.pendingSteering.filter(({ id }) => id !== action.id),
					pendingFollowUps: state.public.pendingFollowUps.filter(({ id }) => id !== action.id),
				},
			};
			break;
		case "clear_steering":
			next = { ...state, public: { ...state.public, pendingSteering: [] } };
			break;
	}
	return deepFreeze(next);
}
