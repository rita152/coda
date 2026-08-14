import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/runtime public contract", () => {
	it("exports only the two deep construction Modules without exposing private Worker Runtime capabilities", () => {
		expect(Object.keys(publicApi).sort()).toEqual(["createRunCapabilityHost", "openCodingAgent"]);
		expect(publicApi).not.toHaveProperty("Agent");
		expect(publicApi).not.toHaveProperty("ContextWindowController");
		expect(publicApi).not.toHaveProperty("ContextOverflowRecovery");
		expect(publicApi).not.toHaveProperty("RuntimeInputQueue");
		expect(publicApi).not.toHaveProperty("openAgentRuntime");
		expect(publicApi).not.toHaveProperty("openCodingAgentRuntime");
	});

	it("depends only on headless Coda Modules", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies: Record<string, string>;
		};
		expect(manifest.dependencies).toEqual({
			"@coda/agent": "0.1.0",
			"@coda/ai": "0.1.0",
		});
	});
});
