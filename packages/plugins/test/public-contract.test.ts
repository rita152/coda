import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/plugins public contract", () => {
	it("exports only the portable Agent Plugins loader contract", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"AGENT_PLUGIN_MCP_SCHEMA",
			"AGENT_PLUGIN_SCHEMA",
			"DEFAULT_PLUGIN_LIMITS",
			"createPlugins",
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
		expect(packageJson.dependencies).toEqual({ "@coda/mcp": "0.1.0", "@coda/skills": "0.1.0" });
	});
});
