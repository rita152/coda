import { describe, expect, it } from "vitest";
import { createCodaTheme } from "../src/interactive/theme.ts";

describe("Coda interactive Theme", () => {
	it("resolves the editor border from Reasoning without leaking that policy into the TUI Editor", () => {
		const theme = createCodaTheme(3);

		expect(theme.styleEditorBorder("max", true, "─")).toBe("\x1b[38;2;255;95;255m─\x1b[0m");
		expect(theme.styleEditorBorder("low", true, "─")).toBe("\x1b[38;2;95;135;175m─\x1b[0m");
		expect(theme.styleEditorBorder("max", false, "─")).toBe("\x1b[2m─\x1b[0m");
		expect(createCodaTheme(2).styleEditorBorder("max", true, "─")).toBe("\x1b[38;5;207m─\x1b[0m");
		expect(createCodaTheme(1).styleEditorBorder("max", true, "─")).toBe("\x1b[95m─\x1b[0m");
		expect(createCodaTheme(0).styleEditorBorder("max", true, "─")).toBe("─");
	});
});
