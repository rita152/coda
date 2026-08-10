import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/skills public contract", () => {
	it("exports the deep runtime and independent format operations", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"DEFAULT_SKILL_LIMITS",
			"createSkills",
			"parseAgentSkill",
			"validateAgentSkill",
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
		expect(packageJson.dependencies).toEqual({ yaml: "2.9.0" });
	});
});
