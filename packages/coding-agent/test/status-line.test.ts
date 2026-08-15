import { displayWidth, stripAnsi } from "@coda/tui";
import { describe, expect, it } from "vitest";
import {
	formatStatusLineCost,
	formatStatusLineTokens,
	renderStatusLine,
	type StatusLineSnapshot,
} from "../src/ui/status-line.ts";
import { createCodaTheme } from "../src/ui/theme.ts";

const snapshot: StatusLineSnapshot = {
	workspacePath: "/Users/zp/Desktop/coda",
	homePath: "/Users/zp",
	git: { branch: "main", dirty: true },
	modelSupportsReasoning: true,
	context: { usedTokens: 128_000, windowTokens: 1_000_000, estimated: false },
	cost: { usd: 1.23 },
};

describe("status line presentation", () => {
	it("renders the confirmed label-free two-row contract", () => {
		const lines = renderStatusLine(
			snapshot,
			{
				modelLabel: "opencode-go/deepseek-v4-flash",
				reasoning: "max",
			},
			80,
			createCodaTheme(0),
		);

		expect(lines[0]).toBe("~/Desktop/coda (main*)");
		expect(lines[1]).toMatch(/^\$1\.23 · 128k\/1m +opencode-go\/deepseek-v4-flash\(max\)$/u);
		expect(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
	});

	it("drops cost, parent path, and provider before higher-priority content", () => {
		const lines = renderStatusLine(
			snapshot,
			{
				modelLabel: "opencode-go/deepseek-v4-flash",
				reasoning: "max",
			},
			40,
			createCodaTheme(0),
		);

		expect(lines[0]).toBe("~/Desktop/coda (main*)");
		expect(lines[1]).toMatch(/^128k\/1m +deepseek-v4-flash\(max\)$/u);
		expect(lines.join("\n")).not.toContain("$1.23");
		expect(lines.join("\n")).not.toContain("opencode-go/");
	});

	it("distinguishes reasoning off from a model without reasoning", () => {
		const reasoningOff = renderStatusLine(
			snapshot,
			{ modelLabel: "provider/model", reasoning: "off" },
			80,
			createCodaTheme(0),
		);
		const unsupported = renderStatusLine(
			{ ...snapshot, modelSupportsReasoning: false },
			{ modelLabel: "provider/model", reasoning: "off" },
			80,
			createCodaTheme(0),
		);

		expect(reasoningOff[1]).toContain("provider/model(off)");
		expect(unsupported[1]).toMatch(/provider\/model$/u);
		expect(unsupported[1]).not.toContain("(off)");
	});

	it("marks estimates and preserves detached Git state without global ellipses", () => {
		const lines = renderStatusLine(
			{
				...snapshot,
				workspacePath: "/Users/zp/a/very/long/workspace/coda",
				git: { detachedHead: "a1b2c3d99", dirty: false },
				context: { ...snapshot.context, estimated: true },
			},
			{ modelLabel: "provider/model", reasoning: "high" },
			32,
			createCodaTheme(0),
		);

		expect(lines.join("\n")).toContain("(@a1b2c3d)");
		expect(lines[1]).toContain("~128k/1m");
		expect(lines.join("\n")).not.toMatch(/….*…/u);
	});

	it("uses semantic colors while retaining the same no-color text", () => {
		const colored = renderStatusLine(
			{
				...snapshot,
				context: { usedTokens: 960_000, windowTokens: 1_000_000, estimated: false },
			},
			{
				modelLabel: "opencode-go/deepseek-v4-flash",
				reasoning: "max",
			},
			100,
			createCodaTheme(1),
		);
		const plain = renderStatusLine(
			{
				...snapshot,
				context: { usedTokens: 960_000, windowTokens: 1_000_000, estimated: false },
			},
			{
				modelLabel: "opencode-go/deepseek-v4-flash",
				reasoning: "max",
			},
			100,
			createCodaTheme(0),
		);

		expect(colored.join("\n")).toContain("\x1b[33m*\x1b[0m");
		expect(colored.join("\n")).toContain("\x1b[1;31m960k/1m\x1b[0m");
		expect(colored.join("\n")).toContain("\x1b[36mopencode-go/deepseek-v4-flash(max)\x1b[0m");
		expect(colored.map(stripAnsi)).toEqual(plain);
	});
});

describe("status line number formatting", () => {
	it("uses compact token units", () => {
		expect(formatStatusLineTokens(999)).toBe("999");
		expect(formatStatusLineTokens(1_280)).toBe("1.3k");
		expect(formatStatusLineTokens(128_000)).toBe("128k");
		expect(formatStatusLineTokens(1_000_000)).toBe("1m");
	});

	it("uses adaptive cost precision and subscription notation", () => {
		expect(formatStatusLineCost({ usd: 0 })).toBe("$0.00");
		expect(formatStatusLineCost({ usd: 0.0034 })).toBe("$0.003");
		expect(formatStatusLineCost({ usd: 1.234 })).toBe("$1.23");
		expect(formatStatusLineCost({ subscription: true })).toBe("sub");
	});
});
