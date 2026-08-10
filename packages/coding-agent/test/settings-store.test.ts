import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { FileSettingsStore } from "../src/settings/file-settings-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSettingsStore", () => {
	it("atomically stores a versioned non-secret settings file with private permissions", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-settings-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		});

		await expect(store.load()).resolves.toEqual({});
		await store.save({
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			shellEnvironmentAllowlist: ["CODA_PUBLIC_FLAG"],
			ui: { motion: "reduced", colorScheme: "light" },
			permissions: {
				profile: "workspace",
				approvalPolicy: {
					mode: "granular",
					sandboxApproval: true,
					rules: false,
					skillApproval: true,
					requestPermissions: false,
					mcpElicitations: true,
				},
			},
		});

		await expect(store.load()).resolves.toEqual({
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			shellEnvironmentAllowlist: ["CODA_PUBLIC_FLAG"],
			ui: { motion: "reduced", colorScheme: "light" },
			permissions: {
				profile: "workspace",
				approvalPolicy: {
					mode: "granular",
					sandboxApproval: true,
					rules: false,
					skillApproval: true,
					requestPermissions: false,
					mcpElicitations: true,
				},
			},
		});
		const settingsPath = join(homeDirectory, ".coda", "settings.json");
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			version: 1,
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			shellEnvironmentAllowlist: ["CODA_PUBLIC_FLAG"],
			ui: { motion: "reduced", colorScheme: "light" },
			permissions: {
				profile: "workspace",
				approvalPolicy: {
					mode: "granular",
					sandboxApproval: true,
					rules: false,
					skillApproval: true,
					requestPermissions: false,
					mcpElicitations: true,
				},
			},
		});
		expect((await stat(join(homeDirectory, ".coda"))).mode & 0o777).toBe(0o700);
		expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
	});

	it("rejects incomplete granular approval settings instead of guessing defaults", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-invalid-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(
			join(homeDirectory, ".coda", "settings.json"),
			JSON.stringify({
				version: 1,
				permissions: {
					profile: "workspace",
					approvalPolicy: { mode: "granular", sandboxApproval: true },
				},
			}),
		);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow("invalid Approval Policy");
	});

	it.each([
		{ allowBash: true },
		{ allowWorkspaceWrite: true },
		{ permissions: { profile: "workspace", approvalPolicy: "on-request", allowBash: true } },
		{
			permissions: {
				profile: "workspace",
				approvalPolicy: {
					mode: "granular",
					sandboxApproval: true,
					rules: true,
					skillApproval: true,
					requestPermissions: true,
					mcpElicitations: true,
					network: true,
				},
			},
		},
	])("rejects unknown or removed authority settings instead of silently ignoring them", async (legacy) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-legacy-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(join(homeDirectory, ".coda", "settings.json"), JSON.stringify({ version: 1, ...legacy }));
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow(/unknown field|invalid Permissions|invalid Approval Policy/u);
	});
});
