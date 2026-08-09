// Portions derived from Pi:
// /packages/tui/test/truncate-to-width.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// /packages/tui/test/wrap-ansi.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";
import { clipAnsi, displayWidth, sliceAnsi, stripAnsi, styleAnsi, wrapAnsi } from "../src/index.ts";

describe("ANSI cell geometry", () => {
	it("measures graphemes while ignoring terminal control sequences", () => {
		expect(displayWidth("\x1b[31mCoda 网络🙂e\u0301\x1b[0m")).toBe(12);
		expect(displayWidth("\x1b]133;A\x07hello\x1b]133;B\x1b\\")).toBe(5);
		expect(displayWidth("a\tb")).toBe(5);
		expect(displayWidth("🇨🇳")).toBe(2);
	});

	it("clips only at grapheme boundaries and closes active styling", () => {
		const clipped = clipAnsi("\x1b[31mhello界\x1b[0m", 6);
		expect(stripAnsi(clipped)).toBe("hello");
		expect(displayWidth(clipped)).toBeLessThanOrEqual(6);
		expect(clipped.endsWith("\x1b[0m")).toBe(true);

		const withEllipsis = clipAnsi("\x1b[31mhello界\x1b[0m", 6, { ellipsis: "…" });
		expect(stripAnsi(withEllipsis)).toBe("hello…");
		expect(displayWidth(withEllipsis)).toBe(6);
	});

	it("extracts a visible cell range without cutting a wide grapheme", () => {
		const input = "\x1b[36ma界bc\x1b[0m";
		const sliced = sliceAnsi(input, 1, 3);

		expect(stripAnsi(sliced)).toBe("界b");
		expect(displayWidth(sliced)).toBe(3);
		expect(sliced.startsWith("\x1b[36m")).toBe(true);
	});
});

describe("wrapAnsi", () => {
	it("hard-wraps styled Unicode text and reapplies style on continuation lines", () => {
		const lines = wrapAnsi("\x1b[31mab网络cd\x1b[0m", 5);

		expect(lines.map(stripAnsi)).toEqual(["ab网", "络cd"]);
		expect(lines.every((line) => displayWidth(line) <= 5)).toBe(true);
		expect(lines[0]?.endsWith("\x1b[0m")).toBe(true);
		expect(lines[1]?.startsWith("\x1b[31m")).toBe(true);
	});

	it("preserves explicit line breaks and never splits an emoji grapheme", () => {
		const lines = wrapAnsi("one\r\ntwo🙂three", 5);

		expect(lines.map(stripAnsi)).toEqual(["one", "two🙂", "three"]);
		expect(lines.every((line) => displayWidth(line) <= 5)).toBe(true);
	});

	it("rejects invalid widths instead of risking a non-terminating wrap", () => {
		expect(() => wrapAnsi("text", 0)).toThrow(RangeError);
		expect(() => clipAnsi("text", -1)).toThrow(RangeError);
	});
});

describe("styleAnsi", () => {
	it("restores a parent style after a nested style resets", () => {
		const nested = styleAnsi("2", `before ${styleAnsi("1", "bold")} after`);

		expect(nested).toBe("\x1b[2mbefore \x1b[1mbold\x1b[0m\x1b[2m after\x1b[0m");
	});
});
