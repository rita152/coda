import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/runtime public contract", () => {
	it("exports a small construction and control surface without exposing its Agent or controllers", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"CodingMcpRegistry",
			"RuntimeInputQueue",
			"createCodingSkillsSnapshot",
			"isContextOverflowError",
			"isProviderContextOverflow",
			"openAgentRuntime",
			"openCodingAgentRuntime",
		]);
		expect(publicApi).not.toHaveProperty("Agent");
		expect(publicApi).not.toHaveProperty("ContextWindowController");
		expect(publicApi).not.toHaveProperty("ContextOverflowRecovery");
	});

	it("depends only on headless Coda Modules", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies: Record<string, string>;
		};
		expect(manifest.dependencies).toEqual({
			"@coda/agent": "0.1.0",
			"@coda/ai": "0.1.0",
			"@coda/mcp": "0.1.0",
			"@coda/skills": "0.1.0",
		});
	});
});
