import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/sandbox public contract", () => {
	it("exports the confinement seam", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"ProcessConfinementError",
			"SANDBOX_MODES",
			"createAnthropicSandboxEngine",
			"denyWriteForSandboxMode",
			"filesystemAccessForSandboxMode",
			"isSandboxMode",
			"openProcessConfinement",
			"processConfinementActive",
			"resolvedConfinementConfig",
			"writableRootsForSandboxMode",
		]);
	});

	it("is a private leaf package with one root entry", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			private: boolean;
			exports: Record<string, unknown>;
			dependencies?: Record<string, string>;
		};
		expect(packageJson.private).toBe(true);
		expect(Object.keys(packageJson.exports)).toEqual(["."]);
		expect(packageJson.dependencies).toEqual({ "@anthropic-ai/sandbox-runtime": "0.0.73" });
	});
});
