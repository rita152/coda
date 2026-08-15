import { describe, expect, it } from "vitest";
import { type MainTimelineBlock, spaceMainTimelineBlocks } from "../src/ui/timeline-presentation.ts";

describe("main Timeline presentation rhythm", () => {
	it("adds one row at semantic type changes while keeping equal types compact", () => {
		const spaced = spaceMainTimelineBlocks([
			block("user", "user", "question"),
			block("thinking-1", "thinking", "first thought"),
			block("thinking-2", "thinking", "second thought"),
			block("explored", "exploration", "Explored"),
			block("tool", "tool", "Ran tests"),
			block("commentary", "assistant_commentary", "Checking the result"),
			block("final", "assistant_final", "Done"),
			block("shell", "user_shell", "You ran pwd"),
			block("error", "error", "Error: failed"),
			block("notice", "notice", "Updated"),
		]);

		expect(spaced.map(({ lines }) => lines.join("\n"))).toEqual([
			"question",
			"",
			"first thought",
			"second thought",
			"",
			"Explored",
			"",
			"Ran tests",
			"",
			"Checking the result",
			"",
			"Done",
			"",
			"You ran pwd",
			"",
			"Error: failed",
			"",
			"Updated",
		]);
	});

	it("ignores empty streaming blocks when deciding adjacency", () => {
		const spaced = spaceMainTimelineBlocks([
			block("thinking", "thinking", "thinking"),
			block("empty", "assistant", ""),
			block("thinking-again", "thinking", "more thinking"),
		]);

		expect(spaced.map(({ id }) => id)).toEqual(["thinking", "empty", "thinking-again"]);
	});
});

function block(id: string, contentType: MainTimelineBlock["contentType"], ...lines: string[]): MainTimelineBlock {
	return { id, contentType, lines };
}
