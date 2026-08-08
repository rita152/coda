import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

interface CompatibilityManifest {
	version: number;
	subpaths: readonly { path: string; status: string; test: string }[];
}

describe("executable compatibility manifest", () => {
	test("defines exactly the package subpaths that are publicly exported", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		const manifest = JSON.parse(
			await readFile(new URL("../compatibility/manifest.v1.json", import.meta.url), "utf8"),
		) as CompatibilityManifest;

		expect(manifest.version).toBe(1);
		expect(Object.keys(packageJson.exports).sort()).toEqual(manifest.subpaths.map((entry) => entry.path).sort());
		expect(manifest.subpaths.every((entry) => entry.test.length > 0)).toBe(true);
		expect(manifest.subpaths.every((entry) => ["compatible", "deliberate-deviation"].includes(entry.status))).toBe(
			true,
		);
		expect(manifest.subpaths.some((entry) => entry.status === "deliberate-deviation")).toBe(true);
	});
});
