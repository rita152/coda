import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSandboxPolicy, PROTECTED_METADATA_NAMES } from "../src/index.ts";
import { buildMacosSeatbeltPolicy } from "../src/macos-seatbelt.ts";

describe("macOS Seatbelt policy", () => {
	it("allows only configured roots, masks denied roots, and reopens reviewed descendants", () => {
		const base = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/Users/user/project"],
			temporaryDirectory: "/private/tmp",
			deniedReadRoots: ["/Users/user/project/.ssh"],
		});
		const policy = Object.freeze({
			...base,
			approvedReadRoots: Object.freeze(["/Users/user/project/.ssh/config"]),
		});

		const generated = buildMacosSeatbeltPolicy(policy, { runtimeReadPathCount: 1 });

		expect(generated).toContain('param "READABLE_ROOT_0"');
		expect(generated).toContain('param "DENIED_ROOT_0"');
		expect(generated).toContain('param "APPROVED_READ_ROOT_0"');
		expect(generated).toContain('param "RUNTIME_READ_PATH_0"');
		expect(generated).not.toContain("(allow file-read*)");
	});

	it("lets a narrower reviewed root reopen only its protected ancestor", () => {
		const root = "/workspace";
		const protectedRoot = join(root, ".git");
		const reviewedRoot = join(protectedRoot, "reviewed");
		const base = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [root],
			temporaryDirectory: "/var/tmp/coda",
		});
		if (base.writableRoots === "full-disk") throw new Error("Workspace must have restricted writes");
		const policy = Object.freeze({
			...base,
			writableRoots: Object.freeze([...base.writableRoots, reviewedRoot]),
			protectedMetadataRoots: Object.freeze([...base.protectedMetadataRoots, reviewedRoot]),
			protectedMetadataPaths: Object.freeze([
				...base.protectedMetadataPaths,
				...PROTECTED_METADATA_NAMES.map((name) => join(reviewedRoot, name)),
			]),
		});
		const outerIndex = policy.writableRoots.indexOf(root);
		const reviewedIndex = policy.writableRoots.indexOf(reviewedRoot);
		const protectedIndex = policy.protectedMetadataPaths.indexOf(protectedRoot);

		const lines = buildMacosSeatbeltPolicy(policy).split("\n");
		const outerRule = lines.find((line) => line.includes(`WRITABLE_ROOT_${outerIndex}`));
		const reviewedRule = lines.find((line) => line.includes(`WRITABLE_ROOT_${reviewedIndex}`));

		expect(outerRule).toContain(`PROTECTED_PATH_${protectedIndex}`);
		expect(reviewedRule).not.toContain(`PROTECTED_PATH_${protectedIndex}`);
	});

	it("keeps a protected descendant excluded from a broad reviewed parent", () => {
		const base = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/private/tmp",
			additionalReadableRoots: ["/Users/user"],
			deniedReadRoots: ["/Users/user/.ssh"],
		});

		const generated = buildMacosSeatbeltPolicy(base);

		expect(generated).toContain(
			'(require-all (require-any (literal (param "APPROVED_READ_ROOT_0")) (subpath (param "APPROVED_READ_ROOT_0"))) (require-not (literal (param "DENIED_ROOT_0"))) (require-not (subpath (param "DENIED_ROOT_0"))))',
		);
	});

	it("grants only metadata reads on canonical ancestors of admitted roots", () => {
		const policy = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/Users/user/project"],
			temporaryDirectory: "/private/tmp",
		});
		const generated = buildMacosSeatbeltPolicy(policy, { readAncestorPathCount: 2 });

		expect(generated).toContain("(allow file-read-metadata");
		expect(generated).toContain('literal (param "READ_ANCESTOR_0")');
		expect(generated).toContain('literal (param "READ_ANCESTOR_1")');
		expect(generated).not.toContain('(allow file-read* (literal (param "READ_ANCESTOR_0")))');
	});
});
