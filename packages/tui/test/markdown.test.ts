import { describe, expect, it } from "vitest";
import { createMarkdownRenderer, displayWidth, sanitizeTerminalText, stripAnsi } from "../src/index.ts";

describe("sanitizeTerminalText", () => {
	it("removes terminal controls while retaining printable text, tabs, and newlines", () => {
		const unsafe =
			"safe\x1b[2Jafter\x1b]0;owned\x07title\x07 bell\x1b[31mred\x1b[0m\n\tCJK中文\u009b2Jtail\x1b]unfinished";
		const safe = sanitizeTerminalText(unsafe);

		expect(safe).toBe("safeaftertitle bellred\n\tCJK中文tail");
		expect(safe).not.toContain("\x1b");
		expect(safe).not.toContain("\x07");
	});
});

describe("MarkdownRenderer", () => {
	it("renders CommonMark and GFM structures into bounded physical lines", () => {
		const renderer = createMarkdownRenderer({ colorLevel: 0 });
		const source = [
			"# Heading",
			"",
			"- **bold** and *emphasis*",
			"- [x] done",
			"",
			"> quoted",
			"",
			"~~deleted~~ and <b>literal</b>",
		].join("\n");
		const lines = renderer.render(source, { width: 30, phase: "complete" });
		const plain = lines.map(stripAnsi);

		expect(plain.join("\n")).toContain("Heading");
		expect(plain.join("\n")).toContain("- bold and emphasis");
		expect(plain.join("\n")).toContain("- [x] done");
		expect(plain.join("\n")).toContain("│ quoted");
		expect(plain.join("\n")).toContain("deleted and <b>literal</b>");
		expect(lines.every((line) => !line.includes("\n") && displayWidth(line) <= 30)).toBe(true);
		expect(lines.join("")).not.toContain("\x1b[");
	});

	it("soft-wraps fenced code with a continuation gutter and retains its language", () => {
		const renderer = createMarkdownRenderer({ colorLevel: 0 });
		const lines = renderer.render("```ts\nconst value = aVeryLongExpression();\n```", {
			width: 18,
			phase: "complete",
		});
		const plain = lines.map(stripAnsi);

		expect(plain[0]).toContain("ts");
		expect(plain.some((line) => line.startsWith("│ "))).toBe(true);
		expect(plain.some((line) => line.startsWith("│ ↳ "))).toBe(true);
		expect(lines.every((line) => displayWidth(line) <= 18)).toBe(true);
	});

	it("aligns tables when they fit and degrades them to stacked fields when narrow", () => {
		const source = "| Name | Value |\n| --- | ---: |\n| alpha | 42 |";
		const renderer = createMarkdownRenderer({ colorLevel: 0 });
		const wide = renderer.render(source, { width: 40, phase: "complete" }).map(stripAnsi);
		const narrow = renderer.render(source, { width: 11, phase: "complete" }).map(stripAnsi);

		expect(wide).toContain("Name   Value");
		expect(wide).toContain("alpha     42");
		expect(narrow).toContain("Name: alpha");
		expect(narrow).toContain("Value: 42");
	});

	it("emits only safe hyperlinks and renders Markdown images as text", () => {
		const renderer = createMarkdownRenderer({ colorLevel: 1 });
		const lines = renderer.render(
			"[safe](https://example.com) [unsafe](javascript:alert(1)) ![cat](https://example.com/cat.png)",
			{ width: 100, phase: "complete" },
		);
		const output = lines.join("\n");

		expect(output).toContain("\x1b]8;;https://example.com\x1b\\safe\x1b]8;;\x1b\\");
		expect(output).not.toContain("javascript:alert(1)\x1b\\");
		expect(stripAnsi(output)).toContain("[cat] (https://example.com/cat.png)");
	});

	it("tolerates incomplete streaming syntax and caches complete documents by source and width", () => {
		const renderer = createMarkdownRenderer({ colorLevel: 0 });
		expect(() => renderer.render("```ts\nconst x = **", { width: 20, phase: "streaming" })).not.toThrow();

		const source = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n");
		const first = renderer.render(source, { width: 80, phase: "complete" });
		const second = renderer.render(source, { width: 80, phase: "complete" });
		expect(second).toBe(first);
		expect(first).toHaveLength(10_000);
	});
});
