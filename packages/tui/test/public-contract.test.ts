import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";
import { composeWithNodeStreams } from "./public-types.consumer.ts";

describe("@coda/tui public package contract", () => {
	it("exports the complete Milestone 1 runtime surface from the root", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"Component",
			"Editor",
			"FocusError",
			"FullScreenTui",
			"ProcessTerminal",
			"RendererError",
			"Tui",
			"VirtualTerminal",
			"clipAnsi",
			"createMarkdownRenderer",
			"createSystemClock",
			"createSystemScheduler",
			"createTerminalImageSurface",
			"detectTerminalImageCapability",
			"displayWidth",
			"matchesKeybinding",
			"observeInvalidation",
			"sanitizeTerminalText",
			"setComponentFocused",
			"sliceAnsi",
			"stripAnsi",
			"styleAnsi",
			"wrapAnsi",
		]);
		expect(typeof composeWithNodeStreams).toBe("function");
	});

	it("publishes only its root entry and remains a private workspace leaf", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			private: boolean;
			exports: Record<string, unknown>;
			dependencies?: Record<string, string>;
		};

		expect(packageJson.private).toBe(true);
		expect(Object.keys(packageJson.exports)).toEqual(["."]);
		expect(Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith("@coda/"))).toBe(false);
	});
});
