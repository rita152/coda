import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
		});

		await expect(store.load()).resolves.toEqual({
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			shellEnvironmentAllowlist: ["CODA_PUBLIC_FLAG"],
		});
		const settingsPath = join(homeDirectory, ".coda", "settings.json");
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			version: 1,
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			shellEnvironmentAllowlist: ["CODA_PUBLIC_FLAG"],
		});
		expect((await stat(join(homeDirectory, ".coda"))).mode & 0o777).toBe(0o700);
		expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
	});
});
