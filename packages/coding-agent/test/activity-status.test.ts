import type { AgentEvent, ToolInvocation } from "@coda/agent";
import { stripAnsi } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { ActivityProjection, activitySummaryModeForApi, providerSummary } from "../src/interactive/activity-status.ts";
import { renderActivityStatus, shimmerText } from "../src/interactive/activity-status-presentation.ts";
import { createCodaTheme } from "../src/interactive/theme.ts";

describe("runtime activity projection", () => {
	it("enables native summaries only for Responses-family and Anthropic Messages protocols", () => {
		expect(activitySummaryModeForApi("openai-responses")).toBe("native");
		expect(activitySummaryModeForApi("azure-openai-responses")).toBe("native");
		expect(activitySummaryModeForApi("openai-codex-responses")).toBe("native");
		expect(activitySummaryModeForApi("anthropic-messages")).toBe("native");
		expect(activitySummaryModeForApi("openai-completions")).toBe("fallback");
		expect(activitySummaryModeForApi("custom-protocol")).toBe("fallback");
	});

	it("presents a native Provider summary directly and ignores it in fallback mode", () => {
		const native = new ActivityProjection("native");
		native.accept(runStart(1_000));
		expect(native.status(1_000)?.text).toBe("Working...");
		native.accept(thinking("thinking_start", 2_000));
		native.accept(thinking("thinking_delta", 2_100, "**Proposing concurrent tool status formatting**\n\nDetails"));

		expect(native.status(2_100)).toMatchObject({
			text: "Proposing concurrent tool status formatting",
			motion: "active",
			startedAt: 2_000,
			lastEventAt: 2_100,
		});

		const fallback = new ActivityProjection("fallback");
		fallback.accept(runStart(1_000));
		fallback.accept(thinking("thinking_start", 2_000));
		fallback.accept(thinking("thinking_delta", 2_100, "private compatibility reasoning"));
		expect(fallback.status(2_100)?.text).toBe("Working...");

		fallback.setSummaryMode("native");
		fallback.accept(thinking("thinking_delta", 2_200, "still the active Chat Completions Run"));
		expect(fallback.status(2_200)?.text).toBe("Working...");
		fallback.accept(event({ type: "run_end", outcome: "success", timestamp: 2_300 }));
		fallback.accept(runStart(3_000));
		fallback.accept(thinking("thinking_delta", 3_100, "**Now using Responses**"));
		expect(fallback.status(3_100)?.text).toBe("Now using Responses");

		const preparing = new ActivityProjection("fallback");
		preparing.beginPreparation(4_000);
		preparing.setSummaryMode("native");
		preparing.accept(runStart(4_100));
		preparing.accept(thinking("thinking_delta", 4_200, "Queued Chat Completions reasoning"));
		expect(preparing.status(4_200)?.text).toBe("Working...");
	});

	it("does not expose an unfinished long Thinking paragraph as a short Provider status", () => {
		const projection = new ActivityProjection("native");
		projection.accept(runStart(1_000));
		projection.accept(thinking("thinking_start", 1_100));
		projection.accept(thinking("thinking_delta", 1_200, "The user is asking me to deeply analyze "));
		expect(projection.status(1_200)?.text).toBe("Working...");

		projection.accept(
			thinking(
				"thinking_delta",
				1_300,
				"the current project. Let me first understand the project structure by exploring the workspace.",
			),
		);
		expect(projection.status(1_300)?.text).toBe(
			"Let me first understand the project structure by exploring the workspace.",
		);
	});

	it("keeps the summary stable through Tools while prioritizing actionable waits and retry", () => {
		const projection = new ActivityProjection("native");
		const bash = invocation("tool-bash", "bash", { command: "npm test" });
		const read = invocation("tool-read", "read", { path: "src/app.ts" });
		projection.accept(runStart(1_000));
		projection.accept(thinking("thinking_delta", 1_100, "**Planning tests**"));
		projection.accept(toolEvent("tool_execution_start", bash, 2_000));
		projection.accept(toolEvent("tool_execution_start", read, 2_100));
		expect(projection.status(2_100)?.text).toBe("Planning tests");

		projection.accept(
			event({
				type: "tool_execution_progress",
				turnId: "turn",
				invocation: read,
				progress: { progress: 2, total: 4, message: "Scanning imports" },
				timestamp: 2_200,
			}),
		);
		expect(projection.status(2_200)?.text).toBe("Planning tests");
		projection.setOverride("mcp:tool-read", "Waiting for MCP input — release", true, 2_250);
		expect(projection.status(2_250)).toMatchObject({
			text: "Waiting for MCP input — release",
			motion: "waiting",
		});
		projection.setOverride("mcp:tool-read", "", false, 2_275);

		projection.setAwaitingApproval(
			{
				kind: "command",
				runId: "run" as never,
				turnId: "turn" as never,
				invocationId: bash.id,
				command: "npm test",
				cwd: "/workspace",
				reason: "requires approval",
			},
			2_300,
		);
		expect(projection.status(2_300)).toMatchObject({
			text: "Waiting for approval — Running npm test",
			motion: "waiting",
		});
		projection.setAwaitingApproval(
			{
				kind: "filesystem",
				runId: "run" as never,
				turnId: "turn" as never,
				invocationId: read.id,
				operation: "read",
				requestedPath: "src/app.ts",
				cwd: "/workspace",
				reason: "requires approval",
			},
			2_350,
		);
		expect(projection.status(2_350)?.text).toBe("Waiting for approval — Running npm test");

		projection.setApprovalResult(bash.id, 2_400);
		expect(projection.status(2_400)?.text).toBe("Waiting for approval — Reading src/app.ts");
		projection.setApprovalResult(read.id, 2_450);
		expect(projection.status(2_450)?.text).toBe("Planning tests");
		projection.accept(toolEvent("tool_execution_end", read, 2_500));
		projection.accept(toolEvent("tool_execution_end", bash, 2_600));
		expect(projection.status(2_600)?.text).toBe("Planning tests");

		const fallback = new ActivityProjection("fallback");
		fallback.accept(runStart(2_700));
		fallback.accept(toolEvent("tool_execution_start", bash, 2_800));
		expect(fallback.status(2_800)?.text).toBe("Working...");
		fallback.accept(toolEvent("tool_execution_end", bash, 2_900));
		expect(fallback.status(2_900)?.text).toBe("Working...");

		projection.accept(
			event({
				type: "retry_scheduled",
				turnId: "turn",
				attemptId: "attempt",
				attempt: 2,
				delayMs: 5_000,
				reason: "rate limited",
				timestamp: 3_000,
			}),
		);
		expect(projection.status(4_200)?.text).toBe("Retrying in 4s...");
		expect(projection.status(8_000)?.text).toBe("Retrying...");
		projection.accept(event({ type: "run_end", outcome: "success", timestamp: 8_100 }));
		expect(projection.status(8_100)).toBeUndefined();
	});

	it("covers pre-Run preparation and explicit User Shell execution, then hides while idle", () => {
		const projection = new ActivityProjection();
		projection.beginPreparation(100);
		expect(projection.status(200)?.text).toBe("Working...");
		projection.acceptUserShell(
			{
				id: "shell-1",
				command: "npm run check",
				cwd: "/workspace",
				status: "running",
				output: "",
				truncated: false,
				omittedBytes: 0,
				omittedLines: 0,
				startedAt: 300,
			},
			300,
		);
		expect(projection.status(400)?.text).toBe("Running npm run check");
		projection.acceptUserShell(
			{
				id: "shell-1",
				command: "npm run check",
				cwd: "/workspace",
				status: "success",
				output: "ok",
				truncated: false,
				omittedBytes: 0,
				omittedLines: 0,
				startedAt: 300,
				finishedAt: 500,
				durationMs: 200,
				exitCode: 0,
			},
			500,
		);
		expect(projection.status(500)).toBeUndefined();
	});

	it("sanitizes the first useful summary line without damaging identifier underscores", () => {
		expect(providerSummary("\n**Proposing `openai_responses` formatting**\nmore")).toBe(
			"Proposing openai_responses formatting",
		);
		expect(providerSummary("Calling mcp__server__tool with __bounded__ details")).toBe(
			"Calling mcp__server__tool with bounded details",
		);
		expect(providerSummary("**")).toBeUndefined();
		expect(providerSummary("\x1b[31m# Reviewing changes\x1b[0m\nsecond")).toBe("Reviewing changes");
	});
});

describe("runtime activity presentation", () => {
	it("renders a Codex-style truecolor shimmer while keeping timing readable", () => {
		const theme = createCodaTheme(3, "dark");
		const status = {
			text: "Proposing concurrent tool status formatting",
			motion: "active" as const,
			startedAt: 0,
			lastEventAt: 1_000,
		};
		const first = renderActivityStatus(status, { width: 80, now: 4_400, theme, motion: "full" });
		const second = renderActivityStatus(status, { width: 80, now: 4_432, theme, motion: "full" });

		expect(first).toContain("\x1b[1;38;2;");
		expect(first).not.toBe(second);
		expect(stripAnsi(first)).toBe("Proposing concurrent tool status formatting · 4s · updated 3s ago");
		expect(stripAnsi(second)).toBe("Proposing concurrent tool status formatting · 4s · updated 3s ago");
	});

	it("uses DIM/normal/BOLD at low color and stays static for reduced motion or user waits", () => {
		const low = createCodaTheme(1, "dark");
		const shimmer = shimmerText("Working...", 1_000, low);
		// biome-ignore lint/complexity/useRegexLiterals: a literal is rejected because it contains ESC.
		expect(shimmer).toMatch(new RegExp("\\x1b\\[(?:1|2)m", "u"));
		expect(stripAnsi(shimmer)).toBe("Working...");

		const active = { text: "Working...", motion: "active" as const, startedAt: 0, lastEventAt: 0 };
		const reducedA = renderActivityStatus(active, { width: 40, now: 100, theme: low, motion: "reduced" });
		const reducedB = renderActivityStatus(active, { width: 40, now: 200, theme: low, motion: "reduced" });
		expect(reducedA).toBe(reducedB);

		const waiting = { ...active, text: "Waiting for approval", motion: "waiting" as const };
		const waitingA = renderActivityStatus(waiting, { width: 40, now: 100, theme: low, motion: "full" });
		const waitingB = renderActivityStatus(waiting, { width: 40, now: 200, theme: low, motion: "full" });
		expect(waitingA).toBe(waitingB);
	});

	it("clips one-line status output to the available terminal width", () => {
		const rendered = renderActivityStatus(
			{ text: "A very long status that cannot fit", motion: "active", startedAt: 0, lastEventAt: 0 },
			{ width: 16, now: 0, theme: createCodaTheme(0), motion: "full" },
		);
		expect(stripAnsi(rendered)).toBe("A very long sta…");
	});
});

function runStart(timestamp: number): AgentEvent {
	return event({
		type: "run_start",
		source: "prompt",
		inputMessage: { id: "user", message: { role: "user", content: "go", timestamp } },
		timestamp,
	});
}

function thinking(type: "thinking_start" | "thinking_delta", timestamp: number, delta?: string): AgentEvent {
	return event({
		type: "message_update",
		turnId: "turn",
		attemptId: "attempt",
		messageId: "message",
		delta: type === "thinking_start" ? { type, contentIndex: 0 } : { type, contentIndex: 0, delta: delta ?? "" },
		timestamp,
	});
}

function invocation(id: string, toolName: string, arguments_: Record<string, unknown>): ToolInvocation {
	return {
		id: id as never,
		resultMessageId: `result-${id}` as never,
		providerToolCallId: `provider-${id}`,
		toolName,
		arguments: arguments_,
		sourceIndex: 0,
	};
}

function toolEvent(
	type: "tool_execution_start" | "tool_execution_end",
	tool: ToolInvocation,
	timestamp: number,
): AgentEvent {
	return event({
		type,
		turnId: "turn",
		invocation: tool,
		...(type === "tool_execution_end"
			? {
					settlement: "returned",
					outcome: "success",
					result: { id: tool.resultMessageId, message: { role: "toolResult", content: [] } },
				}
			: {}),
		timestamp,
	});
}

function event(payload: Record<string, unknown>): AgentEvent {
	return { runId: "run", sequence: 1, timestamp: 0, ...payload } as unknown as AgentEvent;
}
