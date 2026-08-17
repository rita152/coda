import type { MessageId } from "@coda/agent";
import { displayWidth, stripAnsi } from "@coda/tui";
import { describe, expect, it } from "vitest";
import type { TimelineToolEntry, TimelineToolState } from "../src/ui/semantic-timeline.ts";
import { createCodaTheme } from "../src/ui/theme.ts";
import { renderExplorationGroup, renderToolInvocation } from "../src/ui/tool-presentation.ts";

describe("Tool Invocation presentation", () => {
	it.each([
		["read", { path: "src/a.ts" }, "Read src/a.ts"],
		["grep", { pattern: "TODO", path: "src" }, "Searched “TODO” in src"],
		["find", { pattern: "*.ts", path: "." }, "Explored *.ts in ."],
		["ls", { path: "src" }, "Explored src"],
		[
			"patch",
			{
				patch: "*** Begin Patch\n*** Add File: one.txt\n+one\n*** Delete File: two.txt\n*** End Patch",
			},
			"Patched 2 files",
		],
		["edit", { path: "src/a.ts", oldText: "a", newText: "b" }, "Edited src/a.ts"],
		["write", { path: "new.ts", content: "hello" }, "Wrote new.ts"],
		["bash", { command: "npm test" }, "Ran npm test"],
		["custom", { value: 1 }, "Called custom"],
	])("formats %s with dedicated action language", (toolName, arguments_, expected) => {
		const lines = renderToolInvocation(toolEntry(toolName, arguments_), {
			width: 80,
			now: 2_000,
			transcript: false,
			theme: createCodaTheme(0),
		});
		expect(stripAnsi(lines[0] ?? "")).toContain(expected);
	});

	it("uses a compact tree, keeps a five-row head/tail preview, and strips hostile controls", () => {
		const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
		const entry = toolEntry(
			"bash",
			{ command: "printf '\\e[2J'" },
			"success",
			output.replace("line 5", "\x1b[2Jline 5"),
		);
		const lines = renderToolInvocation(entry, {
			width: 50,
			now: 2_000,
			transcript: false,
			theme: createCodaTheme(0),
		});
		const plain = lines.map(stripAnsi);

		expect(plain[0]).toBe("• Ran printf '\\e[2J'");
		expect(plain.slice(1)).toEqual([
			"  └ line 1",
			"    line 2",
			"    … +6 lines (ctrl + t to view transcript)",
			"    line 9",
			"    line 10",
		]);
		expect(lines.join("")).not.toContain("\x1b[2J");
		expect(lines.every((line) => displayWidth(line) <= 50)).toBe(true);
	});

	it("shows complete normalized output in Transcript View", () => {
		const entry = toolEntry("bash", { command: "seq 1 8" }, "success", "1\n2\n3\n4\n5\n6\n7\n8");
		const lines = renderToolInvocation(entry, {
			width: 30,
			now: 2_000,
			transcript: true,
			theme: createCodaTheme(0),
		});
		const plain = lines.map(stripAnsi).join("\n");

		expect(plain).toContain("✓ Ran seq 1 8");
		expect(plain).toContain("    8");
		expect(plain).not.toContain("+3 lines");
	});

	it("renders failures, duration, and process metadata without relying on color", () => {
		const entry = toolEntry("bash", { command: "exit 2" }, "failed", "(no output)", {
			exitCode: 2,
			signal: null,
			timedOut: false,
			truncated: false,
		});
		const timed = { ...entry, startedAt: 100, endedAt: 1_650 } satisfies TimelineToolEntry;
		const lines = renderToolInvocation(timed, {
			width: 60,
			now: 2_000,
			transcript: false,
			theme: createCodaTheme(0),
		});
		const plain = lines.map(stripAnsi).join("\n");

		expect(plain).toContain("Ran exit 2 — failed (1.6s)");
		expect(plain).toContain("exit 2");
		expect(lines.join("")).not.toContain("\x1b[");
	});

	it("renders bounded live Tool progress", () => {
		const entry: TimelineToolEntry = {
			...toolEntry("mcp__docs__index", {}, "running", ""),
			result: undefined,
			endedAt: undefined,
			progress: { progress: 3, total: 10, message: "Indexing\u001b[2J docs" },
		};
		const lines = renderToolInvocation(entry, {
			width: 80,
			now: 2_000,
			transcript: false,
			theme: createCodaTheme(0),
		});
		const plain = lines.map(stripAnsi).join("\n");

		expect(plain).toContain("Progress: Indexing docs • 30% (3/10)");
		expect(lines.join("")).not.toContain("\u001b[2J");
	});

	it("normalizes multiline edits into an actual prefixed diff", () => {
		const entry = toolEntry(
			"edit",
			{ path: "a.ts", oldText: "old one\nold two", newText: "new one\nnew two" },
			"success",
			"Edited a.ts",
		);
		const plain = renderToolInvocation(entry, {
			width: 60,
			now: 0,
			transcript: true,
			theme: createCodaTheme(0),
		})
			.map(stripAnsi)
			.join("\n");

		expect(plain).toContain("-old one");
		expect(plain).toContain("-old two");
		expect(plain).toContain("+new one");
		expect(plain).toContain("+new two");
	});

	it("shows per-file atomicity and partial application for patch failures", () => {
		const patch = `*** Begin Patch
*** Update File: one.txt
-one
+ONE
*** Update File: two.txt
-two
+TWO\u001b[2J
*** End Patch`;
		const entry = toolEntry("patch", { patch }, "failed", "partial", {
			attemptedPaths: ["one.txt", "two.txt"],
			committedPaths: ["one.txt"],
			notAppliedPaths: ["two.txt"],
			atomicity: "per-file",
		});
		const rendered = renderToolInvocation(entry, {
			width: 80,
			now: 2_000,
			transcript: true,
			theme: createCodaTheme(0),
		});
		const plain = rendered.map(stripAnsi).join("\n");

		expect(plain).toContain("Patched 2 files — failed");
		expect(plain).toContain("1/2 files committed • per-file atomic • partial application");
		expect(plain).toContain("*** Update File: one.txt");
		expect(rendered.join("")).not.toContain("\u001b[2J");
	});

	it("groups consecutive read-only exploration while retaining child state", () => {
		const read = { ...toolEntry("read", { path: "a.ts" }), turnId: "turn-1" };
		const grep = {
			...toolEntry("grep", { pattern: "TODO", path: "src" }, "failed"),
			turnId: "turn-1",
		};
		const rendered = renderExplorationGroup([read, grep], {
			width: 60,
			now: 1_000,
			transcript: false,
			theme: createCodaTheme(0),
		}).map(stripAnsi);

		expect(rendered).toEqual(["• Explored", "  └ Read a.ts", "    Search TODO in src — failed"]);
	});

	it("matches Codex emphasis for action headers, command text, gutters, and output", () => {
		const lines = renderToolInvocation(toolEntry("bash", { command: "npm test" }, "success", "passed"), {
			width: 60,
			now: 1_000,
			transcript: false,
			theme: createCodaTheme(1),
		});

		expect(lines[0]).toContain("\x1b[1mRan\x1b[0m");
		expect(lines[0]).toContain("\x1b[36mnpm test\x1b[0m");
		expect(lines[0]).toContain("\x1b[1;32m•\x1b[0m");
		expect(lines[1]).toContain("\x1b[2m  └ \x1b[0m");
		expect(lines[1]).toContain("\x1b[2mpassed\x1b[0m");
	});

	it("shows the Codex no-output affordance for a completed command in the main Timeline", () => {
		const lines = renderToolInvocation(toolEntry("bash", { command: "true" }, "success", ""), {
			width: 40,
			now: 1_000,
			transcript: false,
			theme: createCodaTheme(0),
		}).map(stripAnsi);

		expect(lines).toEqual(["• Ran true", "  └ (no output)"]);
	});

	it("synthesizes Tool Result image filenames and warns when the Provider only sends placeholders", () => {
		const base = toolEntry("bash", { command: "capture" });
		const entry: TimelineToolEntry = {
			...base,
			result: {
				...base.result!,
				message: {
					...base.result!.message,
					content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				},
			},
		};
		const placeholder = renderToolInvocation(entry, {
			width: 100,
			now: 1_000,
			transcript: false,
			theme: createCodaTheme(0),
			toolResultImagesSupported: false,
		})
			.map(stripAnsi)
			.join("\n");
		expect(placeholder).toContain("[bash-image-1.png]");
		expect(placeholder).toContain("text placeholder");

		const supported = renderToolInvocation(entry, {
			width: 100,
			now: 1_000,
			transcript: false,
			theme: createCodaTheme(0),
			toolResultImagesSupported: true,
		})
			.map(stripAnsi)
			.join("\n");
		expect(supported).toContain("[bash-image-1.png]");
		expect(supported).not.toContain("text placeholder");
	});
});

function toolEntry(
	toolName: string,
	arguments_: Record<string, unknown>,
	state: TimelineToolState = "success",
	content = "result",
	details?: unknown,
): TimelineToolEntry {
	return {
		kind: "tool",
		id: `tool:${toolName}`,
		invocation: {
			id: `invocation:${toolName}`,
			resultMessageId: `result:${toolName}`,
			providerToolCallId: `provider:${toolName}`,
			toolName,
			arguments: arguments_,
			sourceIndex: 0,
		},
		state,
		startedAt: 0,
		endedAt: 500,
		result: {
			id: `result:${toolName}` as MessageId,
			message: {
				role: "toolResult",
				toolCallId: `provider:${toolName}`,
				toolName,
				content: [{ type: "text", text: content }],
				details,
				timestamp: 500,
			},
		},
	};
}
