import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSandboxPolicy, PROTECTED_METADATA_NAMES } from "../src/index.ts";
import { buildMacosSeatbeltPolicy } from "../src/macos-seatbelt.ts";

describe("macOS Seatbelt policy", () => {
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
});
