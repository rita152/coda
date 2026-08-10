import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutableIdentityResolver } from "../src/host/executable-identity.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("executable identity resolver", () => {
	it("resolves a PATH command through symlinks and captures replacement-sensitive stat identity", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-executable-"));
		temporaryDirectories.push(fixture);
		const bin = join(fixture, "bin");
		const target = join(fixture, "npm-real");
		await mkdir(bin);
		await writeFile(target, "#!/bin/sh\nexit 0\n");
		await chmod(target, 0o755);
		await symlink(target, join(bin, "npm"));
		const resolver = createExecutableIdentityResolver({
			fileSystem: createNodeFileSystem(),
			path: bin,
			platform: "darwin",
		});

		const identity = await resolver({ executable: "npm", cwd: fixture });

		expect(identity).toMatchObject({
			path: await realpath(target),
			device: expect.stringMatching(/^\d+$/u),
			inode: expect.stringMatching(/^\d+$/u),
			size: 17,
		});
		expect(identity?.modifiedAt).toEqual(expect.any(Number));
	});

	it("fails closed for non-executable files and commands outside the supplied PATH", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-executable-"));
		temporaryDirectories.push(fixture);
		const bin = join(fixture, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "npm"), "not executable\n");
		const resolver = createExecutableIdentityResolver({
			fileSystem: createNodeFileSystem(),
			path: bin,
			platform: "darwin",
		});

		await expect(resolver({ executable: "npm", cwd: fixture })).resolves.toBeUndefined();
		await expect(resolver({ executable: "git", cwd: fixture })).resolves.toBeUndefined();
	});

	it("resolves relative and empty PATH entries from the command working directory", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-executable-"));
		temporaryDirectories.push(fixture);
		const bin = join(fixture, "bin");
		await mkdir(bin);
		for (const path of [join(bin, "npm"), join(fixture, "git")]) {
			await writeFile(path, "#!/bin/sh\nexit 0\n");
			await chmod(path, 0o755);
		}
		const resolver = createExecutableIdentityResolver({
			fileSystem: createNodeFileSystem(),
			path: "bin:",
			platform: "darwin",
		});

		await expect(resolver({ executable: "npm", cwd: fixture })).resolves.toMatchObject({
			path: await realpath(join(bin, "npm")),
		});
		await expect(resolver({ executable: "git", cwd: fixture })).resolves.toMatchObject({
			path: await realpath(join(fixture, "git")),
		});
	});
});
