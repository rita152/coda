import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("@coda/permission public contract", () => {
	it("exports the policy seam", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"APPROVAL_POLICIES",
			"FILESYSTEM_ACCESS",
			"NEVER_PROMPT_REASON",
			"WRITE_REJECTED_OUTSIDE_PROJECT_REASON",
			"WRITE_REJECTED_READ_ONLY_REASON",
			"commandPermissionKey",
			"commandPermissionPrompt",
			"createCommandPermissionPolicy",
			"isDangerousCommand",
			"isKnownSafeCommand",
			"requestsSandboxOverride",
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
		expect(packageJson.dependencies).toBeUndefined();
	});
});
