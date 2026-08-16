import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createWorkspace } from "../src/host/workspace.ts";
import { createWorkspaceFileSearch } from "../src/host/workspace-file-search.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Workspace file search", () => {
	it("returns ranked relative files and omits dependency and Coda metadata directories", async () => {
		const root = await temporaryDirectory("coda-file-search-");
		await mkdir(join(root, "src", "components"), { recursive: true });
		await mkdir(join(root, "docs"));
		await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
		await mkdir(join(root, ".git"));
		await mkdir(join(root, ".coda"));
		await writeFile(join(root, "src", "main.ts"), "export {};\n", "utf8");
		await writeFile(join(root, "src", "components", "MainView.tsx"), "export {};\n", "utf8");
		await writeFile(join(root, "docs", "main.md"), "# Main\n", "utf8");
		await writeFile(join(root, "node_modules", "dependency", "main.js"), "", "utf8");
		await writeFile(join(root, ".git", "config"), "", "utf8");
		await writeFile(join(root, ".coda", "state.json"), "{}", "utf8");

		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const search = createWorkspaceFileSearch(workspace, fileSystem);
		const session = search.startSession();

		const matches = await session("main");
		expect(matches.slice(0, 3)).toEqual(["src/main.ts", "docs/main.md", "src/components/MainView.tsx"]);
		expect(matches).not.toContain("node_modules/dependency/main.js");
		expect(await session("config")).toEqual([]);
		expect(await session("state")).toEqual([]);
	});

	it("does not follow a symbolic link outside the current Workspace", async () => {
		const root = await temporaryDirectory("coda-file-search-root-");
		const outside = await temporaryDirectory("coda-file-search-outside-");
		await writeFile(join(root, "inside.ts"), "", "utf8");
		await writeFile(join(outside, "secret.ts"), "", "utf8");
		await symlink(outside, join(root, "outside"));

		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const search = createWorkspaceFileSearch(workspace, fileSystem);
		const session = search.startSession();

		expect(await session("inside")).toEqual(["inside.ts"]);
		expect(await session("secret")).toEqual([]);
	});

	it("refreshes the file index for each mention session", async () => {
		const root = await temporaryDirectory("coda-file-search-refresh-");
		await writeFile(join(root, "existing.ts"), "", "utf8");

		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const search = createWorkspaceFileSearch(workspace, fileSystem);
		const firstSession = search.startSession();

		expect(await firstSession("existing")).toEqual(["existing.ts"]);
		await rename(join(root, "existing.ts"), join(root, "renamed.ts"));
		await writeFile(join(root, "later.ts"), "", "utf8");
		expect(await firstSession("later")).toEqual([]);
		expect(await firstSession("renamed")).toEqual([]);

		const secondSession = search.startSession();
		expect(await secondSession("renamed")).toEqual(["renamed.ts"]);
		expect(await secondSession("existing")).toEqual([]);
		expect(await secondSession("later")).toEqual(["later.ts"]);

		await rm(join(root, "later.ts"));
		expect(await search.startSession()("later")).toEqual([]);
	});
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(path);
	return path;
}
