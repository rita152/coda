import type { AgentEvent, ToolInvocation } from "@coda/agent";
import type { Api } from "@coda/ai";
import { sanitizeTerminalText } from "@coda/tui";
import type { PermissionApprovalRequest } from "../permissions/permission-engine.ts";
import { toolActionTitle } from "./tool-presentation.ts";
import type { UserShellSnapshot } from "./user-shell.ts";

export type ActivitySummaryMode = "native" | "fallback";

export interface ActivityStatus {
	readonly text: string;
	readonly motion: "active" | "waiting";
	readonly startedAt: number;
	readonly lastEventAt: number;
}

interface ToolActivity {
	readonly invocation: ToolInvocation;
}

interface ThinkingActivity {
	text: string;
	readonly startedAt: number;
}

interface ApprovalActivity {
	readonly invocationId: string;
	readonly action: string;
	readonly startedAt: number;
	readonly order: number;
}

interface RetryActivity {
	readonly startedAt: number;
	readonly retryAt: number;
}

interface ShellActivity {
	readonly id: string;
	readonly command: string;
	readonly startedAt: number;
}

interface ActivityOverride {
	readonly text: string;
	readonly motion: ActivityStatus["motion"];
	readonly startedAt: number;
	readonly order: number;
}

const MAX_PROVIDER_SUMMARY_CHARACTERS = 120;
const ACTION_SUMMARY_PATTERN =
	/^(?:let me\b|i(?:['’]ll|\s+(?:will|am|need to|should|can))\b|we(?:['’]ll|\s+(?:will|are|need to|should|can))\b|next\b|now\b|(?:analyzing|checking|comparing|debugging|exploring|fixing|implementing|inspecting|investigating|looking|planning|preparing|reading|reviewing|running|searching|testing|updating|verifying)\b)/iu;

const NATIVE_SUMMARY_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
]);

/** The API protocol, rather than the Provider label, determines whether streamed Thinking is a native summary. */
export function activitySummaryModeForApi(api: Api): ActivitySummaryMode {
	return NATIVE_SUMMARY_APIS.has(api) ? "native" : "fallback";
}

/** Projects one Session's authoritative runtime events into a single current-activity row. */
export class ActivityProjection {
	#selectedSummaryMode: ActivitySummaryMode;
	#runSummaryMode?: ActivitySummaryMode;
	#preparingStartedAt?: number;
	#runActive = false;
	#phaseStartedAt?: number;
	#lastEventAt?: number;
	#summary?: string;
	#summaryStartedAt?: number;
	readonly #thinking = new Map<number, ThinkingActivity>();
	readonly #tools = new Map<string, ToolActivity>();
	readonly #approvals = new Map<string, ApprovalActivity>();
	#approvalOrder = 0;
	#retry?: RetryActivity;
	#shell?: ShellActivity;
	readonly #overrides = new Map<string, ActivityOverride>();
	#overrideOrder = 0;

	constructor(summaryMode: ActivitySummaryMode = "fallback") {
		this.#selectedSummaryMode = summaryMode;
	}

	setSummaryMode(mode: ActivitySummaryMode): void {
		this.#selectedSummaryMode = mode;
		if (!this.#runActive && this.#preparingStartedAt === undefined && mode === "fallback") this.#clearSummary();
	}

	beginPreparation(at: number): void {
		if (!this.#runActive && this.#preparingStartedAt === undefined) {
			this.#preparingStartedAt = at;
			this.#runSummaryMode = this.#selectedSummaryMode;
		}
		this.#noteEvent(at);
	}

	cancelPreparation(): void {
		if (!this.#runActive) {
			this.#preparingStartedAt = undefined;
			this.#runSummaryMode = undefined;
		}
	}

	accept(event: AgentEvent): void {
		this.#noteEvent(event.timestamp);
		switch (event.type) {
			case "run_start":
				this.#startRun(event.timestamp);
				break;
			case "turn_start":
			case "attempt_start":
				this.#retry = undefined;
				this.#clearSummary();
				this.#phaseStartedAt = event.timestamp;
				break;
			case "message_start":
				this.#phaseStartedAt ??= event.timestamp;
				break;
			case "message_update":
				this.#acceptMessageDelta(event.delta, event.timestamp);
				break;
			case "message_end":
				this.#acceptCompletedMessage(event, event.timestamp);
				break;
			case "attempt_end":
				if (event.discarded) this.#clearSummary();
				break;
			case "retry_scheduled":
				this.#retry = {
					startedAt: event.timestamp,
					retryAt: event.timestamp + Math.max(0, event.delayMs),
				};
				this.#clearSummary();
				break;
			case "tool_execution_start":
				this.#tools.set(event.invocation.id, {
					invocation: event.invocation,
				});
				this.#retry = undefined;
				break;
			case "tool_execution_progress":
				this.#tools.set(event.invocation.id, {
					invocation: event.invocation,
				});
				break;
			case "tool_execution_end":
			case "tool_execution_rejected":
				this.#tools.delete(event.invocation.id);
				this.#approvals.delete(event.invocation.id);
				break;
			case "run_end":
				this.#finishRun();
				break;
		}
	}

	setAwaitingApproval(request: PermissionApprovalRequest, at: number): void {
		const invocation = this.#tools.get(request.invocationId)?.invocation;
		this.#approvals.set(request.invocationId, {
			invocationId: request.invocationId,
			action: invocation ? toolActionTitle(invocation) : approvalAction(request),
			startedAt: at,
			order: ++this.#approvalOrder,
		});
		this.#noteEvent(at);
	}

	setApprovalResult(invocationId: string, at: number): void {
		this.#approvals.delete(invocationId);
		this.#noteEvent(at);
	}

	setOverride(
		key: string,
		text: string,
		present: boolean,
		at: number,
		motion: ActivityStatus["motion"] = "waiting",
	): void {
		if (present) {
			this.#overrides.set(key, {
				text: boundedInline(text, 512),
				motion,
				startedAt: at,
				order: ++this.#overrideOrder,
			});
		} else this.#overrides.delete(key);
		this.#noteEvent(at);
	}

	acceptUserShell(snapshot: UserShellSnapshot, at: number): void {
		this.#noteEvent(at);
		if (snapshot.status === "running") {
			this.#finishRun();
			this.#preparingStartedAt = undefined;
			this.#shell = {
				id: snapshot.id,
				command: boundedInline(snapshot.command, 512),
				startedAt: snapshot.startedAt,
			};
			return;
		}
		if (this.#shell?.id === snapshot.id) this.#shell = undefined;
	}

	status(now: number): ActivityStatus | undefined {
		const lastEventAt = this.#lastEventAt ?? now;
		if (this.#overrides.size > 0) {
			const overrides = [...this.#overrides.values()];
			const actionable = overrides.filter(({ motion }) => motion === "waiting");
			const selectEarliest = actionable.length > 0;
			const override = (selectEarliest ? actionable : overrides).reduce((selected, candidate) => {
				if (selectEarliest) return candidate.order < selected.order ? candidate : selected;
				return candidate.order > selected.order ? candidate : selected;
			});
			return {
				text: override.text,
				motion: override.motion,
				startedAt: override.startedAt,
				lastEventAt,
			};
		}
		if (this.#approvals.size > 0) {
			const approval = [...this.#approvals.values()].reduce((earliest, candidate) =>
				candidate.order < earliest.order ? candidate : earliest,
			);
			return {
				text: `Waiting for approval — ${boundedInline(approval.action, 512)}`,
				motion: "waiting",
				startedAt: approval.startedAt,
				lastEventAt,
			};
		}
		if (this.#shell) {
			return {
				text: `Running ${this.#shell.command || "command"}`,
				motion: "active",
				startedAt: this.#shell.startedAt,
				lastEventAt,
			};
		}
		if (this.#retry) {
			const remainingSeconds = Math.max(0, Math.ceil((this.#retry.retryAt - now) / 1_000));
			return {
				text: remainingSeconds > 0 ? `Retrying in ${remainingSeconds}s...` : "Retrying...",
				motion: "active",
				startedAt: this.#retry.startedAt,
				lastEventAt,
			};
		}
		if (this.#runActive || this.#preparingStartedAt !== undefined) {
			return {
				text: this.#summaryMode === "native" ? (this.#summary ?? "Working...") : "Working...",
				motion: "active",
				startedAt:
					this.#summaryMode === "native" && this.#summary
						? (this.#summaryStartedAt ?? this.#phaseStartedAt ?? now)
						: (this.#phaseStartedAt ?? this.#preparingStartedAt ?? now),
				lastEventAt,
			};
		}
		return undefined;
	}

	#startRun(at: number): void {
		this.#runActive = true;
		this.#runSummaryMode ??= this.#selectedSummaryMode;
		this.#preparingStartedAt = undefined;
		this.#phaseStartedAt = at;
		this.#tools.clear();
		this.#approvals.clear();
		this.#retry = undefined;
		this.#shell = undefined;
		this.#clearSummary();
	}

	#finishRun(): void {
		this.#runActive = false;
		this.#runSummaryMode = undefined;
		this.#preparingStartedAt = undefined;
		this.#phaseStartedAt = undefined;
		this.#tools.clear();
		this.#approvals.clear();
		this.#retry = undefined;
		this.#overrides.clear();
		this.#clearSummary();
	}

	#acceptMessageDelta(delta: Extract<AgentEvent, { type: "message_update" }>["delta"], at: number): void {
		if (delta.type === "thinking_start") {
			this.#thinking.set(delta.contentIndex, { text: "", startedAt: at });
			if (this.#summaryMode === "native") {
				this.#summary = undefined;
				this.#summaryStartedAt = at;
			}
			return;
		}
		if (delta.type !== "thinking_delta" && delta.type !== "thinking_end") return;
		const current = this.#thinking.get(delta.contentIndex) ?? { text: "", startedAt: at };
		current.text = delta.type === "thinking_delta" ? `${current.text}${delta.delta}` : delta.content;
		this.#thinking.set(delta.contentIndex, current);
		if (this.#summaryMode !== "native") return;
		this.#summary = providerSummary(current.text, delta.type === "thinking_end");
		this.#summaryStartedAt = current.startedAt;
	}

	#acceptCompletedMessage(event: Extract<AgentEvent, { type: "message_end" }>, at: number): void {
		if (this.#summaryMode !== "native") return;
		const thinking = [...event.message.message.content]
			.reverse()
			.find((block) => block.type === "thinking" && !block.redacted);
		if (!thinking || thinking.type !== "thinking") return;
		const summary = providerSummary(thinking.thinking);
		if (!summary) return;
		this.#summary = summary;
		this.#summaryStartedAt ??= at;
	}

	#clearSummary(): void {
		this.#summary = undefined;
		this.#summaryStartedAt = undefined;
		this.#thinking.clear();
	}

	#noteEvent(at: number): void {
		this.#lastEventAt = this.#lastEventAt === undefined ? at : Math.max(this.#lastEventAt, at);
	}

	get #summaryMode(): ActivitySummaryMode {
		return this.#runSummaryMode ?? this.#selectedSummaryMode;
	}
}

export function providerSummary(value: string, complete = true): string | undefined {
	const sanitized = sanitizeTerminalText(value);
	const firstLine = sanitized.split(/\r?\n/gu).find((line) => line.trim());
	if (!firstLine) return undefined;

	const explicitHeading = /^(?:#{1,6}\s+.+|(?:\*\*|__|~~).+(?:\*\*|__|~~))\s*$/u.test(firstLine.trim());
	if (explicitHeading) return conciseSummaryCandidate(cleanSummaryText(firstLine));

	const prose = cleanSummaryText(sanitized.replace(/[\r\n]+/gu, " "));
	const completedSentences = [...prose.matchAll(/(?:^|\s)([^.!?。！？]*[.!?。！？]+)(?=\s|$)/gu)]
		.map((match) => match[1]?.trim())
		.filter((sentence): sentence is string => Boolean(sentence));
	for (const sentence of completedSentences.reverse()) {
		if (!ACTION_SUMMARY_PATTERN.test(sentence)) continue;
		const candidate = conciseSummaryCandidate(sentence);
		if (candidate) return candidate;
	}

	return complete ? conciseSummaryCandidate(cleanSummaryText(firstLine)) : undefined;
}

function cleanSummaryText(value: string): string {
	let summary = value
		.trim()
		.replace(/^#{1,6}\s+/u, "")
		.replace(/^>\s*/u, "")
		.replace(/^(?:[-+*]|\d+[.)])\s+/u, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/\*\*([^*]+)\*\*/gu, "$1")
		.replace(/(^|[\s([{])__([^_]+)__(?=$|[\s)\]},.!?:;])/gu, "$1$2")
		.replace(/~~([^~]+)~~/gu, "$1")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/\*([^*]+)\*/gu, "$1")
		.replace(/(^|[\s([{])_([^_]+)_(?=$|[\s)\]},.!?:;])/gu, "$1$2")
		.replace(/\s+/gu, " ")
		.trim();
	for (const marker of ["***", "___", "**", "__", "~~", "*", "_", "`"]) {
		if (summary.startsWith(marker) && summary.endsWith(marker) && summary.length > marker.length * 2) {
			summary = summary.slice(marker.length, -marker.length).trim();
		}
	}
	return summary
		.replace(/^(?:\*{1,3}|_{1,3}|~~|`)+/u, "")
		.replace(/(?:\*{1,3}|_{1,3}|~~|`)+$/u, "")
		.trim();
}

function conciseSummaryCandidate(value: string): string | undefined {
	if (!value || Array.from(value).length > MAX_PROVIDER_SUMMARY_CHARACTERS) return undefined;
	return boundedInline(value, MAX_PROVIDER_SUMMARY_CHARACTERS);
}

function approvalAction(request: PermissionApprovalRequest): string {
	if (request.command) return `Running ${boundedInline(request.command, 512)}`;
	if (request.requestedPath || request.canonicalPath) {
		const verb = request.operation === "write" ? "Writing" : "Reading";
		return `${verb} ${boundedInline(request.requestedPath ?? request.canonicalPath ?? "path", 512)}`;
	}
	if (request.host) return `Connecting to ${boundedInline(request.host, 256)}`;
	return `Calling ${boundedInline(request.toolName ?? request.kind, 256)}`;
}

function boundedInline(value: string, maximumCharacters: number): string {
	const sanitized = sanitizeTerminalText(value)
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = Array.from(sanitized);
	return characters.length <= maximumCharacters
		? sanitized
		: `${characters.slice(0, Math.max(0, maximumCharacters - 1)).join("")}…`;
}
