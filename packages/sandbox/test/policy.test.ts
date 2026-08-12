import { describe, expect, it } from "vitest";
import { compileSandboxPolicy } from "../src/index.ts";

describe("compileSandboxPolicy", () => {
	it("compiles Read Only with root-scoped reads, no writes, and restricted network", () => {
		const policy = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/workspace", "/explicit-root"],
			temporaryDirectory: "/private/tmp",
			deniedReadRoots: ["/workspace/.ssh"],
		});

		expect(policy).toMatchObject({
			profile: "read-only",
			readAccess: "root-scoped",
			readableRoots: ["/workspace", "/explicit-root"],
			approvedReadRoots: [],
			deniedReadRoots: ["/workspace/.ssh"],
			writableRoots: [],
			protectedMetadataRoots: [],
			protectedMetadataNames: [".git", ".agents", ".codex", ".coda"],
			protectedMetadataPaths: [],
			networkAccess: "restricted",
		});
		if (policy.writableRoots === "full-disk") throw new Error("Read Only cannot have full-disk writes");
		workspaceRootsAreFrozen(policy.writableRoots);
	});

	it("treats explicit read and write roots as reviewed read authority", () => {
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/var/tmp",
			additionalReadableRoots: ["/shared/input"],
			additionalWritableRoots: ["/shared/output"],
		});

		expect(policy.approvedReadRoots).toEqual(["/shared/input", "/shared/output"]);
		expect(policy.readableRoots).toEqual(expect.arrayContaining(["/workspace", "/var/tmp"]));
	});

	it("keeps Full Access as an explicit full-disk bypass", () => {
		const policy = compileSandboxPolicy({
			profile: "full-access",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/tmp",
			deniedReadRoots: ["/home/user/.ssh"],
		});

		expect(policy).toMatchObject({
			readAccess: "full-disk",
			readableRoots: [],
			approvedReadRoots: [],
			deniedReadRoots: [],
			writableRoots: "full-disk",
		});
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
