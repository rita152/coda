import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystem } from "../src/host/file-system.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { resolveDefaultDeniedReadRoots } from "../src/permissions/sensitive-read-roots.ts";
import { createWorkspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("default denied read roots", () => {
	it("canonicalizes home, XDG, cloud, and multi-file Kubernetes Credential locations without reading contents", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-sensitive-read-roots-"));
		temporaryDirectories.push(fixture);
		const home = join(fixture, "home");
		const workspaceRoot = join(fixture, "workspace");
		const sshTarget = join(fixture, "ssh-target");
		const xdgConfig = join(fixture, "xdg-config");
		const cloudCredentials = join(fixture, "cloud", "credentials.json");
		const kubeOne = join(fixture, "kube", "one");
		const kubeTwo = join(fixture, "kube", "two");
		await Promise.all([
			mkdir(home),
			mkdir(workspaceRoot),
			mkdir(sshTarget),
			mkdir(xdgConfig),
			mkdir(join(fixture, "cloud")),
			mkdir(join(fixture, "kube")),
		]);
		await symlink(sshTarget, join(home, ".ssh"));
		const delegate = createNodeFileSystem();
		const readFile = vi.fn<FileSystem["readFile"]>(delegate.readFile);
		const workspace = await createWorkspace(workspaceRoot, { ...delegate, readFile });
		const canonicalFixture = await realpath(fixture);
		const canonicalHome = join(canonicalFixture, "home");

		const roots = await resolveDefaultDeniedReadRoots(home, workspace, {
			XDG_CONFIG_HOME: xdgConfig,
			GOOGLE_APPLICATION_CREDENTIALS: cloudCredentials,
			KUBECONFIG: `${kubeOne}${delimiter}${kubeTwo}`,
		});

		expect(roots).toEqual(
			expect.arrayContaining([
				await realpath(sshTarget),
				join(canonicalHome, ".aws"),
				join(canonicalHome, ".gnupg"),
				join(canonicalHome, ".kube"),
				join(canonicalHome, "Library", "Keychains"),
				join(canonicalFixture, "xdg-config", "gcloud"),
				join(canonicalFixture, "cloud", "credentials.json"),
				join(canonicalFixture, "kube", "one"),
				join(canonicalFixture, "kube", "two"),
			]),
		);
		expect(Object.isFrozen(roots)).toBe(true);
		expect(readFile).not.toHaveBeenCalled();
	});
});
