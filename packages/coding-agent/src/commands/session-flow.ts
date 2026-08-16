import { EMPTY_SESSION_TITLE } from "../session/session-summary.ts";
import type { SessionSummary } from "../session/types.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export interface SessionCommandEntry {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly status: "current" | "needs attention" | "running" | "idle";
}

export interface SessionCommandFlowOptions {
	readonly sessions: readonly SessionCommandEntry[];
	readonly onSelect: (sessionId: string) => Promise<void> | void;
}

export function createSessionCommandFlow(options: SessionCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "session",
		title: "Switch session",
		filterable: true,
		presentation: "sessions",
		emptyMessage: "No sessions yet",
		items: Object.freeze(
			options.sessions.map((session) =>
				Object.freeze({
					id: session.id,
					label: session.label,
					description: session.description,
					status: session.status,
					onSelect: (navigation: CommandFlowNavigation) => finish(options.onSelect(session.id), navigation),
				}),
			),
		),
	});
}

export function sessionCommandEntryFromSummary(
	summary: SessionSummary,
	now: number,
): Omit<SessionCommandEntry, "status"> {
	const details = [
		formatSessionAge(summary.updatedAt, now),
		summary.model ? `${summary.model.provider}/${summary.model.id}` : undefined,
		summary.model?.api ? sessionApiProtocolLabel(summary.model.api) : undefined,
		`${summary.promptCount} ${summary.promptCount === 1 ? "prompt" : "prompts"}`,
		summary.title === EMPTY_SESSION_TITLE ? shortSessionId(summary.descriptor.id) : undefined,
	].filter(isPresent);
	return Object.freeze({
		id: summary.descriptor.id,
		label: summary.title,
		description: details.join(" · "),
	});
}

export function sessionApiProtocolLabel(api: string): string {
	switch (api) {
		case "openai-completions":
			return "OpenAI Chat Completions";
		case "openai-responses":
			return "OpenAI Responses";
		case "anthropic-messages":
			return "Anthropic Messages";
		default:
			return api;
	}
}

export function formatSessionAge(timestamp: number, now: number): string {
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
	if (elapsedSeconds < 5) return "now";
	if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	if (elapsedDays < 30) return `${elapsedDays}d ago`;
	return new Date(timestamp).toISOString().slice(0, 10);
}

function finish(result: Promise<void> | void, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}

function shortSessionId(id: string): string {
	const characters = Array.from(id);
	return characters.length <= 8 ? id : `…${characters.slice(-8).join("")}`;
}

function isPresent(value: string | undefined): value is string {
	return value !== undefined;
}
