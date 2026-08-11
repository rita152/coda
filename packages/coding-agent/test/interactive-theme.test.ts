import { describe, expect, it } from "vitest";
import { createCodaTheme } from "../src/interactive/theme.ts";

describe("Coda interactive Theme", () => {
	it("maps approval surfaces independently for light, dark, unknown, and NO_COLOR terminals", () => {
		const dark = createCodaTheme(3, "dark");
		const light = createCodaTheme(3, "light");
		const unknown = createCodaTheme(3, "unknown");

		expect(dark.appearance).toBe("dark");
		expect(dark.surfaceFilled).toBe(true);
		expect(dark.styleOnSurface("panel", "normal", "Approve")).toBe(
			"\x1b[38;2;220;223;228;48;2;66;70;78mApprove\x1b[0m",
		);
		expect(light.styleOnSurface("selection", "accent", "Approve")).toBe(
			"\x1b[1;38;2;0;95;135;48;2;245;245;245mApprove\x1b[0m",
		);
		expect(unknown.surfaceFilled).toBe(false);
		expect(unknown.styleOnSurface("panel", "normal", "Approve")).toBe("Approve");
		expect(createCodaTheme(0, "dark").styleOnSurface("panel", "accent", "Approve")).toBe("Approve");
	});

	it("uses deterministic filled-surface fallbacks for 256-color and 16-color terminals", () => {
		expect(createCodaTheme(2, "dark").styleOnSurface("panel", "normal", "Approve")).toBe(
			"\x1b[38;5;254;48;5;238mApprove\x1b[0m",
		);
		expect(createCodaTheme(1, "light").styleOnSurface("selection", "accent", "Approve")).toBe(
			"\x1b[1;36;107mApprove\x1b[0m",
		);
	});

	it("resolves the editor border from Reasoning without leaking that policy into the TUI Editor", () => {
		const theme = createCodaTheme(3);

		expect(theme.styleEditorBorder("max", true, "─")).toBe("\x1b[38;2;255;95;255m─\x1b[0m");
		expect(theme.styleEditorBorder("low", true, "─")).toBe("\x1b[38;2;95;135;175m─\x1b[0m");
		expect(theme.styleEditorBorder("max", false, "─")).toBe("\x1b[2m─\x1b[0m");
		expect(createCodaTheme(2).styleEditorBorder("max", true, "─")).toBe("\x1b[38;5;207m─\x1b[0m");
		expect(createCodaTheme(1).styleEditorBorder("max", true, "─")).toBe("\x1b[95m─\x1b[0m");
		expect(createCodaTheme(0).styleEditorBorder("max", true, "─")).toBe("─");
	});

	it("provides Codex-aligned strong text and full visible Thinking styles", () => {
		const theme = createCodaTheme(1);

		expect(theme.style("strong", "Ran")).toBe("\x1b[1mRan\x1b[0m");
		expect(theme.style("thinking", "reasoning")).toBe("\x1b[2;3mreasoning\x1b[0m");
		expect(createCodaTheme(0).style("thinking", "reasoning")).toBe("reasoning");
	});
});
