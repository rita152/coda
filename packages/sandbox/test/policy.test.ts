import { describe, expect, it } from "vitest";
import { compileSandboxPolicy } from "../src/index.ts";

describe("compileSandboxPolicy", () => {
	it("compiles Read Only as full-disk read, no writes, and restricted network", () => {
		const policy = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/workspace", "/explicit-root"],
			temporaryDirectory: "/private/tmp",
		});

		expect(policy).toMatchObject({
			profile: "read-only",
			readAccess: "full-disk",
			deniedReadRoots: [],
			writableRoots: [],
			protectedMetadataRoots: [],
			protectedMetadataNames: [".git", ".agents", ".codex", ".coda"],
			protectedMetadataPaths: [],
			networkAccess: "restricted",
		});
		if (policy.writableRoots === "full-disk") throw new Error("Read Only cannot have full-disk writes");
		workspaceRootsAreFrozen(policy.writableRoots);
	});

	it("rejects non-canonical or relative roots before a process can launch", () => {
		expect(() =>
			compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["relative"],
				temporaryDirectory: "/tmp",
			}),
		).toThrow(/canonical absolute/);
	});

	it("protects project metadata below explicitly configured additional roots", () => {
		const systemTemporaryDirectory = process.platform === "darwin" ? "/private/tmp" : "/tmp";
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/var/tmp",
			additionalWritableRoots: ["/explicit-root"],
		});

		expect(policy.protectedMetadataRoots).toEqual([
			"/workspace",
			systemTemporaryDirectory,
			"/var/tmp",
			"/explicit-root",
		]);
		expect(policy.protectedMetadataPaths).toEqual(
			expect.arrayContaining([
				"/explicit-root/.git",
				"/explicit-root/.agents",
				"/explicit-root/.codex",
				"/explicit-root/.coda",
				`${systemTemporaryDirectory}/.git`,
				"/var/tmp/.git",
			]),
		);
	});
});

function workspaceRootsAreFrozen(roots: readonly string[]): void {
	expect(Object.isFrozen(roots)).toBe(true);
}
