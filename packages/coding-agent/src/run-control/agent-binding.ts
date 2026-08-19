import type { AgentEvent, Clock } from "@coda/agent";
import { resolveToolObservation } from "@coda/ai";
import type { Scheduler } from "@coda/tui";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import { RunControl } from "./run-control.ts";
import type {
	RunControlConfiguration,
	RunControlProgressFact,
	RunControlReport,
	RunControlReportProvider,
	RunControlTrigger,
} from "./types.ts";

const INSPECTION_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"read_tool_output",
	"read_session_history",
	"web_search",
	"fetch",
]);

export interface AgentRunControlBindingOptions {
	readonly work: Pick<SessionWorkController, "cancel" | "deliver" | "subscribeControl" | "subscribeResult">;
	readonly configuration: RunControlConfiguration;
	readonly clock: Clock;
	readonly scheduler: Scheduler;
}

export interface AgentRunControlBinding extends RunControlReportProvider {
	observe(fact: RunControlProgressFact): boolean;
	dispose(): void;
}

interface ActiveControl {
	readonly runId: string;
	readonly control: RunControl;
}

export function bindAgentRunControl(options: AgentRunControlBindingOptions): AgentRunControlBinding {
	let active: ActiveControl | undefined;
	const completed = new Map<string, RunControlReport>();
	const remember = (runId: string, report: RunControlReport): void => {
		completed.set(runId, report);
		while (completed.size > 128) completed.delete(completed.keys().next().value!);
	};
	const requestWrapUp = (runId: string, trigger: RunControlTrigger): void => {
		if (active?.runId !== runId) return;
		void options.work
			.deliver("steering", wrapUpSteering(trigger, options.configuration.graceDurationMs))
			.catch(() => undefined);
	};
	const hardStop = (runId: string): void => {
		if (active?.runId !== runId) return;
		void options.work.cancel().catch(() => undefined);
	};
	const beginControl = (runId: string, startedAt: number): void => {
		active?.control.dispose();
		const control = new RunControl({
			configuration: options.configuration,
			clock: options.clock,
			scheduler: options.scheduler,
			startedAt,
			requestWrapUp: (trigger) => requestWrapUp(runId, trigger),
			hardStop: () => hardStop(runId),
		});
		active = { runId, control };
	};
	const finishActive = (timestamp: number, reason: "run_ended" | "work_item_settled"): void => {
		if (!active) return;
		active.control.complete(timestamp, reason);
		remember(active.runId, active.control.report());
		active = undefined;
	};
	const detachControl = options.work.subscribeControl((event) => {
		if (event.type === "run_start") {
			const runId = String(event.runId);
			beginControl(runId, event.timestamp);
			return;
		}
		if (!active || active.runId !== String(event.runId)) return;
		switch (event.type) {
			case "turn_start":
				active.control.markFinalizing(event.timestamp);
				active.control.beginTurn();
				break;
			case "tool_execution_end":
			case "tool_execution_rejected":
				for (const fact of progressFactsFromAgentEvent(event)) active.control.observe(fact, event.timestamp);
				break;
			case "turn_end":
				active.control.finishTurn(event.timestamp);
				break;
			case "run_end": {
				finishActive(event.timestamp, "run_ended");
				break;
			}
		}
	});
	const detachResult = options.work.subscribeResult((result) => {
		finishActive(result.timing.settledAt, "work_item_settled");
	});
	return {
		reportForRun: (runId) => (active?.runId === runId ? active.control.report() : completed.get(runId)),
		observe: (fact) => active?.control.observe(fact) ?? false,
		dispose: () => {
			detachControl();
			detachResult();
			active?.control.dispose();
			active = undefined;
		},
	};
}

function wrapUpSteering(trigger: RunControlTrigger, graceDurationMs: number): string {
	const reason = trigger === "work_deadline" ? "the work deadline was reached" : "the Run stopped making net progress";
	const graceSeconds = Math.max(1, Math.floor(graceDurationMs / 1_000));
	return [
		`Coda RunControl requested finalization because ${reason}.`,
		`Approximately ${graceSeconds} seconds remain before the hard stop.`,
		"Stop exploratory work. Preserve the current workspace, perform only the most important bounded verification if safe, inspect final diff/status, and give a concise final response that clearly states completed, partial, or blocked work.",
	].join(" ");
}

function progressFactsFromAgentEvent(
	event: Extract<AgentEvent, { type: "tool_execution_end" | "tool_execution_rejected" }>,
): readonly RunControlProgressFact[] {
	const facts: RunControlProgressFact[] = [];
	const toolName = event.invocation.toolName;
	const arguments_ = event.invocation.arguments;
	const invocationFingerprint = `${toolName}\u0000${canonicalJson(arguments_)}`;
	const resultMessage = event.result.message;
	const observation =
		resultMessage.role === "toolResult"
			? resolveToolObservation(resultMessage)
			: ({ status: "error", truncated: false } as const);
	const successful =
		event.type === "tool_execution_end" && event.settlement === "returned" && observation.status === "ok";

	if (successful && INSPECTION_TOOLS.has(toolName)) {
		facts.push({ kind: "read", fingerprint: invocationFingerprint });
	}
	const mutation = mutationDeltas(observation.facts);
	if (mutation) {
		for (const delta of mutation) {
			facts.push({
				kind: "workspace_content",
				path: delta.path,
				digest: delta.afterSha256 ?? `deleted:${delta.beforeSha256 ?? "unknown"}`,
			});
		}
	}

	const command = toolName === "bash" && typeof arguments_.command === "string" ? arguments_.command : undefined;
	if (command && isVerificationCommand(command)) {
		facts.push({
			kind: "verification",
			target: normalizeVerificationCommand(command),
			status: successful ? "passed" : "failed",
		});
	} else if (!successful) {
		facts.push({ kind: "failure", fingerprint: `${invocationFingerprint}\u0000${observation.status}` });
	}
	return Object.freeze(facts);
}

function mutationDeltas(
	facts: Readonly<Record<string, unknown>> | undefined,
):
	| readonly { readonly path: string; readonly beforeSha256: string | null; readonly afterSha256: string | null }[]
	| undefined {
	const mutation = facts?.mutation;
	if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) return undefined;
	const candidate = mutation as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.committedDelta)) return undefined;
	const deltas = candidate.committedDelta.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const delta = value as Record<string, unknown>;
		if (typeof delta.path !== "string" || !nullableDigest(delta.beforeSha256) || !nullableDigest(delta.afterSha256)) {
			return [];
		}
		return [{ path: delta.path, beforeSha256: delta.beforeSha256, afterSha256: delta.afterSha256 }];
	});
	return deltas.length === candidate.committedDelta.length ? Object.freeze(deltas) : undefined;
}

function nullableDigest(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function normalizeVerificationCommand(command: string): string {
	return command.trim().replace(/\s+/gu, " ");
}

function isVerificationCommand(command: string): boolean {
	const normalized = normalizeVerificationCommand(command).toLowerCase();
	return (
		/(?:^|[;&|()]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck)\b/u.test(normalized) ||
		/(?:^|[;&|()]\s*)(?:pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|vitest|jest|tsc\b|make\s+(?:test|check))\b/u.test(
			normalized,
		)
	);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
