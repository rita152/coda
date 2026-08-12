import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileSandboxPolicy, PROTECTED_METADATA_NAMES } from "../src/index.ts";
import { prepareLinuxBubblewrap, resolveLinuxBubblewrap } from "../src/linux-bubblewrap.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Linux bubblewrap preparation", () => {
	it("layers writable roots over a read-only disk and reapplies protected metadata last", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-linux-policy-"));
		temporaryDirectories.push(fixture);
		const root = await realpath(fixture);
		await mkdir(join(root, ".git"));
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [root],
			temporaryDirectory: await realpath(tmpdir()),
		});

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/sh", "-c", "true"], root, policy, {
			isolateNetwork: true,
			helper: ["/opt/coda/coda-linux-sandbox-helper"],
		});

		expect(prepared.args).toContain("--unshare-net");
		expect(flagPairs(prepared.args, "--bind")).toContainEqual([root, root]);
		expect(flagPairs(prepared.args, "--ro-bind")).toContainEqual([join(root, ".git"), join(root, ".git")]);
		expect(prepared.args.slice(-5)).toEqual(["/opt/coda/coda-linux-sandbox-helper", "--", "/bin/sh", "-c", "true"]);
		await prepared.cleanup();
		await expect(lstat(join(root, ".git"))).resolves.toBeDefined();
		for (const name of [".agents", ".codex", ".coda"]) {
			await expect(lstat(join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("reopens a more specific reviewed write root after masking its protected ancestor", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-linux-write-precedence-"));
		temporaryDirectories.push(fixture);
		const root = await realpath(fixture);
		const protectedRoot = join(root, ".git");
		const reviewedRoot = join(protectedRoot, "reviewed");
		await mkdir(reviewedRoot, { recursive: true });
		const base = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [root],
			temporaryDirectory: await realpath(tmpdir()),
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

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], root, policy, {
			isolateNetwork: true,
		});

		const outerBind = mountIndex(prepared.args, "--bind", root);
		const outerMask = mountIndex(prepared.args, "--ro-bind", protectedRoot, outerBind + 1);
		const reviewedBind = mountIndex(prepared.args, "--bind", reviewedRoot);
		expect(outerBind).toBeLessThan(outerMask);
		expect(outerMask).toBeLessThan(reviewedBind);
		await prepared.cleanup();
	});

	it("masks denied roots after broader readable and writable mounts", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-linux-deny-read-"));
		temporaryDirectories.push(root);
		const secret = join(root, "secret.txt");
		await writeFile(secret, "classified");
		const canonicalRoot = await realpath(root);
		const canonicalSecret = await realpath(secret);
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalRoot],
			temporaryDirectory: "/tmp",
			deniedReadRoots: [canonicalSecret],
		});

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], canonicalRoot, policy, {
			isolateNetwork: false,
		});

		expect(prepared.args).toContain("--tmpfs");
		const deniedMount = flagPairs(prepared.args, "--ro-bind").find(([, target]) => target === canonicalSecret);
		expect(deniedMount).toBeDefined();
		const maskSource = deniedMount![0];
		expect((await lstat(maskSource)).mode & 0o777).toBe(0);
		await prepared.cleanup();
		await expect(access(maskSource)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(secret)).resolves.toBeUndefined();
	});

	it("reopens only a reviewed descendant after masking its denied ancestor", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-linux-reviewed-read-"));
		temporaryDirectories.push(root);
		const sensitive = join(root, ".ssh");
		const reviewed = join(sensitive, "config");
		await mkdir(sensitive);
		await writeFile(reviewed, "Host example");
		const canonicalRoot = await realpath(root);
		const canonicalSensitive = await realpath(sensitive);
		const canonicalReviewed = await realpath(reviewed);
		const policy = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: [canonicalRoot],
			temporaryDirectory: "/tmp",
			additionalReadableRoots: [canonicalReviewed],
			deniedReadRoots: [canonicalSensitive],
		});

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], canonicalRoot, policy, {
			isolateNetwork: true,
		});

		const deniedMount = flagPairs(prepared.args, "--ro-bind").find(([, target]) => target === canonicalSensitive);
		expect(deniedMount).toBeDefined();
		const deniedIndex = mountTargetIndex(prepared.args, "--ro-bind", canonicalSensitive);
		const reviewedIndex = mountIndex(prepared.args, "--ro-bind", canonicalReviewed, deniedIndex + 1);
		expect(deniedIndex).toBeLessThan(reviewedIndex);
		expect((await lstat(deniedMount![0])).mode & 0o777).toBe(0o111);
		expect((await lstat(join(deniedMount![0], "config"))).mode & 0o777).toBe(0);
		await prepared.cleanup();
	});

	it("mounts a broad reviewed parent before masking its protected descendant", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-linux-broad-reviewed-read-"));
		temporaryDirectories.push(fixture);
		const home = join(fixture, "home");
		const sensitive = join(home, ".ssh");
		await mkdir(sensitive, { recursive: true });
		const canonicalHome = await realpath(home);
		const canonicalSensitive = await realpath(sensitive);
		const policy = compileSandboxPolicy({
			profile: "read-only",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/tmp",
			additionalReadableRoots: [canonicalHome],
			deniedReadRoots: [canonicalSensitive],
		});

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], "/workspace", policy, {
			isolateNetwork: true,
		});

		const parentIndex = mountIndex(prepared.args, "--ro-bind", canonicalHome);
		const deniedIndex = mountTargetIndex(prepared.args, "--ro-bind", canonicalSensitive);
		expect(parentIndex).toBeLessThan(deniedIndex);
		await prepared.cleanup();
	});

	it("fails closed on a protected path reached through a replaceable writable symlink", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-linux-protected-symlink-"));
		temporaryDirectories.push(fixture);
		const root = await realpath(fixture);
		const target = join(root, "metadata-target");
		await mkdir(target);
		await symlink(target, join(root, ".git"));
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [root],
			temporaryDirectory: await realpath(tmpdir()),
		});

		await expect(
			prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], root, policy, {
				isolateNetwork: true,
			}),
		).rejects.toThrow(/replaceable writable symlink/iu);
	});

	it("removes earlier synthetic masks when a later protected path fails closed", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-linux-protected-cleanup-"));
		temporaryDirectories.push(fixture);
		const root = await realpath(fixture);
		const target = join(root, "metadata-target");
		await mkdir(target);
		await symlink(target, join(root, ".agents"));
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [root],
			temporaryDirectory: await realpath(tmpdir()),
		});

		await expect(
			prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], root, policy, {
				isolateNetwork: true,
			}),
		).rejects.toThrow(/replaceable writable symlink/iu);
		await expect(access(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("synthesizes and safely removes the first missing denied path component", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-linux-missing-deny-"));
		temporaryDirectories.push(root);
		const canonicalRoot = await realpath(root);
		const missingParent = join(canonicalRoot, "future");
		const denied = join(missingParent, "secret.txt");
		const base = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalRoot],
			temporaryDirectory: "/tmp",
		});
		const policy = Object.freeze({ ...base, deniedReadRoots: Object.freeze([denied]) });

		const prepared = await prepareLinuxBubblewrap("/usr/bin/bwrap", ["/bin/true"], canonicalRoot, policy, {
			isolateNetwork: false,
		});

		expect(flagPairs(prepared.args, "--ro-bind").some(([, target]) => target === missingParent)).toBe(true);
		await expect(lstat(missingParent)).resolves.toBeDefined();
		await prepared.cleanup();
		await expect(access(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("accepts only a checksum-verified bundled fallback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-bundled-bwrap-"));
		temporaryDirectories.push(directory);
		const bundled = join(directory, "bwrap");
		const contents = "#!/bin/sh\nexit 0\n";
		await writeFile(bundled, contents);
		await chmod(bundled, 0o755);
		const digest = createHash("sha256").update(contents).digest("hex");
		const canonicalBundled = await realpath(bundled);

		await expect(
			resolveLinuxBubblewrap({
				cwd: directory,
				path: "/definitely/not/a/search/path",
				bundledPath: bundled,
				bundledSha256: digest,
				probe: async (candidate) => candidate === canonicalBundled,
			}),
		).resolves.toBe(canonicalBundled);
		await expect(
			resolveLinuxBubblewrap({
				cwd: directory,
				path: "/definitely/not/a/search/path",
				bundledPath: bundled,
				bundledSha256: "0".repeat(64),
				probe: async (candidate) => candidate === canonicalBundled,
			}),
		).rejects.toThrow(/digest mismatch/);
	});

	it("loads the generated adjacent checksum when resolving the default-style bundled fallback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-adjacent-bwrap-"));
		temporaryDirectories.push(directory);
		const bundled = join(directory, "bwrap");
		const contents = "#!/bin/sh\nexit 0\n";
		await writeFile(bundled, contents);
		await writeFile(`${bundled}.sha256`, `${createHash("sha256").update(contents).digest("hex")}\n`);
		await chmod(bundled, 0o755);
		const canonicalBundled = await realpath(bundled);

		await expect(
			resolveLinuxBubblewrap({
				cwd: directory,
				path: "/definitely/not/a/search/path",
				bundledPath: bundled,
				probe: async (candidate) => candidate === canonicalBundled,
			}),
		).resolves.toBe(canonicalBundled);

		const replacement = "#!/bin/sh\nexit 42\n";
		await writeFile(bundled, replacement);
		await writeFile(`${bundled}.sha256`, `${createHash("sha256").update(replacement).digest("hex")}\n`);
		await chmod(bundled, 0o755);
		await expect(
			resolveLinuxBubblewrap({
				cwd: directory,
				path: "/definitely/not/a/search/path",
				bundledPath: bundled,
				probe: async (candidate) => candidate === canonicalBundled,
			}),
		).rejects.toThrow(/digest mismatch/);
	});
});

function flagPairs(args: readonly string[], flag: string): readonly (readonly [string, string])[] {
	const pairs: [string, string][] = [];
	for (let index = 0; index < args.length - 2; index++) {
		if (args[index] === flag) pairs.push([args[index + 1]!, args[index + 2]!]);
	}
	return pairs;
}

function mountIndex(args: readonly string[], flag: string, path: string, from = 0): number {
	for (let index = from; index < args.length - 2; index++) {
		if (args[index] === flag && args[index + 1] === path && args[index + 2] === path) return index;
	}
	throw new Error(`Missing ${flag} mount for ${path}`);
}

function mountTargetIndex(args: readonly string[], flag: string, target: string, from = 0): number {
	for (let index = from; index < args.length - 2; index++) {
		if (args[index] === flag && args[index + 2] === target) return index;
	}
	throw new Error(`Missing ${flag} target mount for ${target}`);
}
