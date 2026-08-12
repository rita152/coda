import { describe, expect, it } from "vitest";
import { compileSandboxPolicy, createReadAccessPolicy, type ReadAccessPolicy } from "../src/index.ts";

function restrictedPolicy(): ReadAccessPolicy {
	return createReadAccessPolicy(
		compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: ["/home/user/project"],
			temporaryDirectory: "/tmp",
			additionalReadableRoots: ["/shared/input"],
			deniedReadRoots: ["/home/user/project/.ssh"],
		}),
	);
}

describe("ReadAccessPolicy", () => {
	it("allows Workspace and explicit roots while denying external and sensitive paths", () => {
		const policy = restrictedPolicy();

		expect(policy.evaluate("/home/user/project/src/index.ts")).toEqual({
			decision: "allow",
			source: "readable-root",
		});
		expect(policy.evaluate("/shared/input/data.json")).toEqual({
			decision: "allow",
			source: "approved-root",
		});
		expect(policy.evaluate("/home/user/notes.txt")).toEqual({
			decision: "deny",
			reason: "outside-readable-roots",
		});
		expect(policy.evaluate("/home/user/project/.ssh/id_ed25519")).toEqual({
			decision: "deny",
			reason: "denied-read-root",
		});
	});

	it("reopens only the reviewed subtree and keeps the wrapped process policy identical", () => {
		const reviewed = restrictedPolicy().withApprovedRoots(["/home/user/project/.ssh/config"]);

		expect(reviewed.evaluate("/home/user/project/.ssh/config")).toMatchObject({ decision: "allow" });
		expect(reviewed.evaluate("/home/user/project/.ssh/id_ed25519")).toEqual({
			decision: "deny",
			reason: "denied-read-root",
		});
		expect(reviewed.sandboxPolicy.approvedReadRoots).toContain("/home/user/project/.ssh/config");
	});

	it("does not let a broad reviewed parent reopen a protected descendant", () => {
		const reviewed = restrictedPolicy().withApprovedRoots(["/home/user"]);

		expect(reviewed.evaluate("/home/user/notes.txt")).toEqual({
			decision: "allow",
			source: "approved-root",
		});
		expect(reviewed.evaluate("/home/user/project/.ssh/id_ed25519")).toEqual({
			decision: "deny",
			reason: "denied-read-root",
		});
	});

	it("fails closed for non-canonical paths", () => {
		expect(restrictedPolicy().evaluate("/home/user/project/../notes.txt")).toEqual({
			decision: "deny",
			reason: "invalid-path",
		});
	});

	it("lets Full Access bypass every root decision", () => {
		const policy = createReadAccessPolicy(
			compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
		);

		expect(policy.evaluate("/home/user/.ssh/id_ed25519")).toEqual({
			decision: "allow",
			source: "full-access",
		});
	});
});
