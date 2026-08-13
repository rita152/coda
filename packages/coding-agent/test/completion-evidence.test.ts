import type { AgentEvent } from "@coda/agent";
import { describe, expect, it } from "vitest";
import { CompletionActivityProjection, classifyShellCommand } from "../src/completion/completion-evidence.ts";

describe("CompletionActivityProjection", () => {
	it("recognizes a terminal candidate structurally without consuming its text", () => {
		const projection = new CompletionActivityProjection();
		projection.accept(runStart(1));
		projection.accept(
			event(2, {
				type: "message_end",
				turnId: "turn:done",
				attemptId: "attempt:done",
				message: {
					id: "message:done",
					message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
				},
			}),
		);
		projection.accept(event(3, { type: "turn_end", turnId: "turn:done", outcome: "success" }));

		expect(projection.snapshot("run:test").terminalCandidate).toEqual({
			messageId: "message:done",
			turnId: "turn:done",
			sequence: 2,
		});
	});

	it("does not maintain a second Tool reducer", () => {
		const projection = new CompletionActivityProjection();
		projection.accept(runStart(1));
		projection.accept(event(2, { type: "tool_execution_start" }));
		expect(projection.snapshot("run:test")).toEqual({});
	});
});

describe("completion Shell command classification", () => {
	it.each(["npm test", "npm run check --workspace=@coda/coding-agent", "pytest -q", "git diff --check"])(
		"classifies %s as local verification",
		(command) => {
			expect(classifyShellCommand(command)).toBe("verification");
		},
	);

	it.each(["git status --short", "rg TODO src", "cat package.json"])("classifies %s as read-only", (command) => {
		expect(classifyShellCommand(command)).toBe("read_only");
	});

	it.each(["npm test | tail -20", "sed -i s/old/new/ src/value.ts", "node scripts/update.js"])(
		"does not treat ambiguous or piped command %s as verification",
		(command) => {
			expect(classifyShellCommand(command)).toBe("potential_mutation");
		},
	);
});

function runStart(sequence: number): AgentEvent {
	return event(sequence, {
		type: "run_start",
		source: "prompt",
		inputMessage: { id: "message:user", message: { role: "user", content: "prompt", timestamp: 0 } },
	});
}

function event(sequence: number, payload: Record<string, unknown>): AgentEvent {
	return { runId: "run:test", sequence, timestamp: sequence, ...payload } as unknown as AgentEvent;
}
