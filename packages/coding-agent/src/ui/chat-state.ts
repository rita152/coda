import type { AgentEvent, AgentSeed } from "@coda/agent";
import type { Clock, ColorLevel, RenderContext } from "@coda/tui";
import type { RunEvidenceEnvelope } from "../run-evidence/run-evidence.ts";
import type { SessionToolLifecycle } from "../session/types.ts";
import { ActivityProjection, type ActivityStatus, type ActivitySummaryMode } from "./activity-status.ts";
import type { ChatComposerProjection } from "./chat-composer.ts";
import { MINIMUM_CHAT_COLUMNS, MINIMUM_CHAT_ROWS } from "./chat-rendering.ts";
import { IDLE_CTRL_C_CONFIRMATION_WINDOW_MS } from "./chat-timeline-renderer.ts";
import { SemanticTimeline } from "./semantic-timeline.ts";
import type { UserShellSnapshot } from "./user-shell.ts";

export interface ChatStateView {
	readonly timeline: SemanticTimeline;
	readonly running: boolean;
	readonly agentRunning: boolean;
	readonly shellRunning: boolean;
	readonly modelLabel: string;
	readonly reasoning: string;
	readonly activity?: ActivityStatus;
	readonly error?: string;
	readonly notice?: string;
	readonly runEvidence?: RunEvidenceEnvelope;
}

export type ChatStateMutation =
	| {
			readonly type: "set_model_presentation";
			readonly modelLabel: string;
			readonly reasoning: string;
			readonly activitySummaryMode?: ActivitySummaryMode;
	  }
	| { readonly type: "set_reasoning"; readonly reasoning: string }
	| {
			readonly type: "set_activity_override";
			readonly key: string;
			readonly text: string;
			readonly present: boolean;
			readonly motion: "active" | "waiting";
	  }
	| { readonly type: "accept_run_evidence"; readonly evidence: RunEvidenceEnvelope }
	| {
			readonly type: "resynchronize";
			readonly seed: AgentSeed;
			readonly toolInvocations: readonly SessionToolLifecycle[];
			readonly running: boolean;
	  }
	| { readonly type: "begin_agent_preparation" }
	| { readonly type: "cancel_agent_preparation" }
	| { readonly type: "set_error"; readonly value: string | undefined }
	| { readonly type: "set_notice"; readonly value: string | undefined };

export type ChatStateProjection =
	| { readonly type: "agent_event"; readonly event: AgentEvent }
	| { readonly type: "user_shell"; readonly snapshot: UserShellSnapshot };

export type ChatStateHostMutation =
	| { readonly type: "accept_run_start_attachment"; readonly messageId: string }
	| { readonly type: "project_composer"; readonly projection: ChatComposerProjection }
	| { readonly type: "note_timeline_update" }
	| { readonly type: "reset_timeline_caches" }
	| { readonly type: "invalidate" };

export interface ChatStateHost {
	mutate(mutation: ChatStateHostMutation): void;
}

export class ChatStateController {
	readonly #clock: Clock;
	readonly #activitySummaryMode?: ActivitySummaryMode;
	readonly #motion: "full" | "reduced";
	readonly #colorLevel: ColorLevel;
	readonly #host: ChatStateHost;
	#timeline: SemanticTimeline;
	#activity: ActivityProjection;
	#agentRunning = false;
	#shellRunning = false;
	#error?: string;
	#notice?: string;
	#runEvidence?: RunEvidenceEnvelope;
	#modelLabel: string;
	#reasoning: string;

	constructor(input: {
		readonly modelLabel: string;
		readonly reasoning: string;
		readonly clock: Clock;
		readonly activitySummaryMode?: ActivitySummaryMode;
		readonly motion: "full" | "reduced";
		readonly colorLevel: ColorLevel;
		readonly seed?: AgentSeed;
		readonly restoredToolInvocations?: readonly SessionToolLifecycle[];
		readonly host: ChatStateHost;
	}) {
		this.#modelLabel = input.modelLabel;
		this.#reasoning = input.reasoning;
		this.#clock = input.clock;
		this.#activitySummaryMode = input.activitySummaryMode;
		this.#motion = input.motion;
		this.#colorLevel = input.colorLevel;
		this.#host = input.host;
		this.#timeline = new SemanticTimeline(input.seed, input.restoredToolInvocations);
		this.#activity = new ActivityProjection(input.activitySummaryMode);
	}

	view(now?: number): ChatStateView {
		return {
			timeline: this.#timeline,
			running: this.#agentRunning || this.#shellRunning,
			agentRunning: this.#agentRunning,
			shellRunning: this.#shellRunning,
			modelLabel: this.#modelLabel,
			reasoning: this.#reasoning,
			...(now === undefined ? {} : { activity: this.#activity.status(now) }),
			...(this.#error === undefined ? {} : { error: this.#error }),
			...(this.#notice === undefined ? {} : { notice: this.#notice }),
			...(this.#runEvidence === undefined ? {} : { runEvidence: this.#runEvidence }),
		};
	}

	mutate(mutation: ChatStateMutation): void {
		switch (mutation.type) {
			case "set_model_presentation":
				this.#modelLabel = mutation.modelLabel;
				this.#reasoning = mutation.reasoning;
				if (mutation.activitySummaryMode) this.#activity.setSummaryMode(mutation.activitySummaryMode);
				this.#host.mutate({ type: "invalidate" });
				return;
			case "set_reasoning":
				this.#reasoning = mutation.reasoning;
				this.#host.mutate({ type: "invalidate" });
				return;
			case "set_activity_override":
				this.#activity.setOverride(
					mutation.key,
					mutation.text,
					mutation.present,
					this.#clock.now(),
					mutation.motion,
				);
				this.#host.mutate({ type: "invalidate" });
				return;
			case "accept_run_evidence":
				this.#runEvidence = structuredClone(mutation.evidence);
				this.#host.mutate({ type: "invalidate" });
				return;
			case "resynchronize":
				this.#timeline = new SemanticTimeline(mutation.seed, mutation.toolInvocations);
				this.#activity = new ActivityProjection(this.#activitySummaryMode);
				this.#agentRunning = mutation.running;
				this.#host.mutate({ type: "project_composer", projection: { type: "resynchronize" } });
				this.#host.mutate({ type: "reset_timeline_caches" });
				this.#host.mutate({ type: "invalidate" });
				return;
			case "begin_agent_preparation":
				this.#agentRunning = true;
				this.#activity.beginPreparation(this.#clock.now());
				return;
			case "cancel_agent_preparation":
				this.#agentRunning = false;
				this.#activity.cancelPreparation();
				return;
			case "set_error":
				this.#error = mutation.value;
				return;
			case "set_notice":
				this.#notice = mutation.value;
				return;
		}
	}

	project(projection: ChatStateProjection): void {
		switch (projection.type) {
			case "agent_event":
				this.#acceptAgentEvent(projection.event);
				return;
			case "user_shell":
				this.#acceptUserShell(projection.snapshot);
				return;
		}
	}

	animationInterval(context: RenderContext, lastIdleCtrlCAt?: number): number | undefined {
		if (context.width < MINIMUM_CHAT_COLUMNS || context.height < MINIMUM_CHAT_ROWS) return undefined;
		const intervals: number[] = [];
		const activity = this.#activity.status(context.now);
		if (activity) {
			intervals.push(1_000);
			if (this.#motion === "full" && activity.motion === "active" && this.#colorLevel > 0) intervals.push(32);
		}
		if (this.#motion === "full" && activity?.motion !== "waiting" && this.#timeline.hasActiveTools) {
			intervals.push(this.#colorLevel === 3 ? 80 : 600);
		}
		if (lastIdleCtrlCAt !== undefined) {
			const remaining = IDLE_CTRL_C_CONFIRMATION_WINDOW_MS - (context.now - lastIdleCtrlCAt);
			if (remaining > 0) intervals.push(remaining);
		}
		return intervals.length > 0 ? Math.min(...intervals) : undefined;
	}

	#acceptAgentEvent(event: AgentEvent): void {
		this.#activity.accept(event);
		if (event.type === "run_start") {
			this.#host.mutate({ type: "accept_run_start_attachment", messageId: event.inputMessage.id });
		}
		this.#host.mutate({ type: "project_composer", projection: { type: "before_agent_event", event } });
		const mutation = this.#timeline.accept(event);
		switch (event.type) {
			case "run_start":
				this.#agentRunning = true;
				this.#notice = undefined;
				this.#runEvidence = undefined;
				break;
			case "run_end":
				this.#agentRunning = false;
				if (event.outcome === "error") this.#error = event.failure?.message ?? "Run failed";
				break;
		}
		this.#host.mutate({ type: "project_composer", projection: { type: "after_agent_event", event } });
		if (mutation.changed) this.#host.mutate({ type: "note_timeline_update" });
		this.#host.mutate({ type: "invalidate" });
	}

	#acceptUserShell(snapshot: UserShellSnapshot): void {
		this.#activity.acceptUserShell(snapshot, this.#clock.now());
		if (snapshot.status === "running") {
			// A resumed mixed queue may optimistically mark an Agent Run as pending before
			// discovering that its next item is a local Shell command.
			this.#agentRunning = false;
		}
		this.#host.mutate({ type: "project_composer", projection: { type: "user_shell", snapshot } });
		this.#shellRunning = snapshot.status === "running";
		this.#timeline.acceptUserShell(snapshot);
		this.#host.mutate({ type: "note_timeline_update" });
		this.#host.mutate({ type: "invalidate" });
	}
}
