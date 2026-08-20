import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStore } from "../src/app/file-settings-store.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { UserSettings } from "../src/settings/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSettingsStore", () => {
	it("serializes cross-instance updates without losing unrelated settings", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-settings-update-"));
		temporaryDirectories.push(homeDirectory);
		const fileSystem = createNodeFileSystem();
		const first = new FileSettingsStore({
			fileSystem,
			homeDirectory,
			idGenerator: { generate: () => "first-update" },
		});
		const second = new FileSettingsStore({
			fileSystem,
			homeDirectory,
			idGenerator: { generate: () => "second-update" },
		});

		const [firstResult, secondResult] = await Promise.all([
			first.update((settings) => ({ ...settings, defaultReasoning: "high" })),
			second.update((settings) => ({
				...settings,
				plugins: { "review-tools@workspace-local": { enabled: false } },
			})),
		]);

		expect([firstResult, secondResult]).toContainEqual({
			defaultReasoning: "high",
			plugins: { "review-tools@workspace-local": { enabled: false } },
		});
		await expect(first.load()).resolves.toEqual({
			defaultReasoning: "high",
			plugins: { "review-tools@workspace-local": { enabled: false } },
		});
	});

	it("strictly validates the latest file and mutation before an update can commit", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-settings-strict-update-"));
		temporaryDirectories.push(homeDirectory);
		const settingsPath = join(homeDirectory, ".coda", "settings.json");
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "strict-update" },
		});
		await store.save({ defaultReasoning: "high" });

		await expect(store.update((settings) => ({ ...settings, unknownSetting: true }) as UserSettings)).rejects.toThrow(
			"unknown field",
		);
		await expect(store.load()).resolves.toEqual({ defaultReasoning: "high" });

		await writeFile(settingsPath, "{not-json");
		const mutator = vi.fn((settings: UserSettings) => settings);
		await expect(store.update(mutator)).rejects.toThrow("not valid JSON");
		expect(mutator).not.toHaveBeenCalled();
	});

	it("uses the private temporary inode as the final file without a fallible post-rename chmod", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-settings-commit-point-"));
		temporaryDirectories.push(homeDirectory);
		const settingsPath = join(homeDirectory, ".coda", "settings.json");
		const base = createNodeFileSystem();
		let finalModeAttempts = 0;
		const store = new FileSettingsStore({
			fileSystem: {
				...base,
				setMode: async (path, mode) => {
					if (path === settingsPath) {
						finalModeAttempts++;
						throw new Error("final chmod unavailable after rename");
					}
					await base.setMode(path, mode);
				},
			},
			homeDirectory,
			idGenerator: { generate: () => "commit-point" },
		});

		await expect(
			store.save({ plugins: { "review-tools@workspace-local": { enabled: false } } }),
		).resolves.toBeUndefined();
		await expect(store.load()).resolves.toEqual({
			plugins: { "review-tools@workspace-local": { enabled: false } },
		});
		expect(finalModeAttempts).toBe(0);
		expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
	});

	it("round-trips Plugin enablement by canonical source-aware identity", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-plugin-settings-"));
		temporaryDirectories.push(homeDirectory);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "plugin-settings" },
		});

		await store.save({
			plugins: {
				"review-tools@workspace-local": { enabled: false },
				"lint-tools@user-local": { enabled: true },
			},
		});

		const loaded = await store.load();
		expect(loaded.plugins).toEqual({
			"lint-tools@user-local": { enabled: true },
			"review-tools@workspace-local": { enabled: false },
		});
		expect(Object.keys(loaded.plugins ?? {})).toEqual(["lint-tools@user-local", "review-tools@workspace-local"]);
		expect(JSON.parse(await readFile(join(homeDirectory, ".coda", "settings.json"), "utf8"))).toEqual({
			version: 1,
			plugins: {
				"lint-tools@user-local": { enabled: true },
				"review-tools@workspace-local": { enabled: false },
			},
		});
	});

	it.each([
		{ plugins: [] },
		{ plugins: { "InvalidName@workspace-local": { enabled: false } } },
		{ plugins: { "review-tools@workspace.local": { enabled: false } } },
		{ plugins: { "review-tools@workspace-local": {} } },
		{ plugins: { "review-tools@workspace-local": { enabled: "false" } } },
		{ plugins: { "review-tools@workspace-local": { enabled: false, path: "/tmp/plugin" } } },
	])("rejects invalid Plugin identities and enablement entries", async (settings) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-invalid-plugin-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(join(homeDirectory, ".coda", "settings.json"), JSON.stringify({ version: 1, ...settings }));
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow("invalid Plugin settings");
	});

	it("round-trips multiple Workspace MCP trust sources for one workspace by canonical path", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-mcp-trust-settings-"));
		temporaryDirectories.push(homeDirectory);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "mcp-trust-settings" },
		});
		const records = [
			{
				workspace: "/workspace",
				path: "/workspace/.agents/plugins/zeta/mcp.json",
				sha256: "b".repeat(64),
			},
			{
				workspace: "/workspace",
				path: "/workspace/.coda/mcp.json",
				sha256: "a".repeat(64),
			},
		];

		await store.save({ workspaceMcpTrust: records });

		await expect(store.load()).resolves.toEqual({ workspaceMcpTrust: records });
		await expect(
			store.save({
				workspaceMcpTrust: [records[0]!, { ...records[0]!, sha256: "c".repeat(64) }],
			}),
		).rejects.toThrow("duplicate Workspace MCP Trust");
	});

	it("atomically stores a versioned non-secret settings file with private mode bits", async () => {
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
			customProviders: [
				{
					id: "custom-acme",
					name: "Acme",
					apiProtocol: "openai.responses",
					baseUrl: "https://api.acme.test/v1",
					discovery: "ready",
					models: [{ id: "acme-one", name: "Acme One" }],
				},
			],
			mcpServers: [
				{
					id: "docs",
					oauth: { callbackPort: 3118 },
					transport: {
						kind: "http",
						url: "https://docs.example.test/mcp",
						bearerTokenEnvironment: "DOCS_TOKEN",
					},
				},
			],
			workspaceMcpTrust: [
				{
					workspace: "/workspace",
					path: "/workspace/.coda/mcp.json",
					sha256: "d".repeat(64),
				},
			],
			hookTrust: [{ key: "workspace-stop-hook", sha256: "e".repeat(64) }],
			permission: {
				approvalPolicy: "untrusted",
				enabled: true,
				remembered: [
					{
						key: 'bash\0{"command":"npm test"}',
						decision: "allow",
						scope: "workspace",
						workspace: "/workspace",
					},
				],
			},
			sandbox: {
				mode: "workspace-write",
				enabled: true,
				allowedDomains: ["registry.npmjs.org"],
				deniedDomains: ["evil.test"],
			},
			ui: { motion: "reduced", colorScheme: "light" },
		});

		await expect(store.load()).resolves.toEqual({
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			customProviders: [
				{
					id: "custom-acme",
					name: "Acme",
					apiProtocol: "openai.responses",
					baseUrl: "https://api.acme.test/v1",
					discovery: "ready",
					models: [{ id: "acme-one", name: "Acme One" }],
				},
			],
			mcpServers: [
				{
					id: "docs",
					oauth: { callbackPort: 3118 },
					transport: {
						kind: "http",
						url: "https://docs.example.test/mcp",
						bearerTokenEnvironment: "DOCS_TOKEN",
					},
				},
			],
			workspaceMcpTrust: [
				{
					workspace: "/workspace",
					path: "/workspace/.coda/mcp.json",
					sha256: "d".repeat(64),
				},
			],
			hookTrust: [{ key: "workspace-stop-hook", sha256: "e".repeat(64) }],
			permission: {
				approvalPolicy: "untrusted",
				enabled: true,
				remembered: [
					{
						key: 'bash\0{"command":"npm test"}',
						decision: "allow",
						scope: "workspace",
						workspace: "/workspace",
					},
				],
			},
			sandbox: {
				mode: "workspace-write",
				enabled: true,
				allowedDomains: ["registry.npmjs.org"],
				deniedDomains: ["evil.test"],
			},
			ui: { motion: "reduced", colorScheme: "light" },
		});
		const settingsPath = join(homeDirectory, ".coda", "settings.json");
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			version: 1,
			defaultModel: { provider: "opencode-go", id: "kimi-k2.6" },
			defaultReasoning: "high",
			customProviders: [
				{
					id: "custom-acme",
					name: "Acme",
					apiProtocol: "openai.responses",
					baseUrl: "https://api.acme.test/v1",
					discovery: "ready",
					models: [{ id: "acme-one", name: "Acme One" }],
				},
			],
			mcpServers: [
				{
					id: "docs",
					oauth: { callbackPort: 3118 },
					transport: {
						kind: "http",
						url: "https://docs.example.test/mcp",
						bearerTokenEnvironment: "DOCS_TOKEN",
					},
				},
			],
			workspaceMcpTrust: [
				{
					workspace: "/workspace",
					path: "/workspace/.coda/mcp.json",
					sha256: "d".repeat(64),
				},
			],
			hookTrust: [{ key: "workspace-stop-hook", sha256: "e".repeat(64) }],
			permission: {
				approvalPolicy: "untrusted",
				enabled: true,
				remembered: [
					{
						key: 'bash\0{"command":"npm test"}',
						decision: "allow",
						scope: "workspace",
						workspace: "/workspace",
					},
				],
			},
			sandbox: {
				mode: "workspace-write",
				enabled: true,
				allowedDomains: ["registry.npmjs.org"],
				deniedDomains: ["evil.test"],
			},
			ui: { motion: "reduced", colorScheme: "light" },
		});
		expect((await stat(join(homeDirectory, ".coda"))).mode & 0o777).toBe(0o700);
		expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
	});

	it("round-trips strict non-secret Web settings", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-web-settings-"));
		temporaryDirectories.push(homeDirectory);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "web-settings" },
		});
		const web = {
			search: {
				providers: ["brave", "tavily", "searxng", "duckduckgo"] as const,
				timeoutMs: 8_000,
				maxResults: 10,
				maxCharacters: 24_000,
				searxngEndpoint: "https://search.example.test/api/",
			},
			cache: { ttlMs: 120_000, maxEntries: 64, maxBytes: 4 * 1024 * 1024 },
			fetch: { timeoutMs: 15_000, maxBytes: 8_000_000, maxCharacters: 100_000 },
		};

		await store.save({ web });

		await expect(store.load()).resolves.toEqual({ web });
		const serialized = await readFile(join(homeDirectory, ".coda", "settings.json"), "utf8");
		expect(JSON.parse(serialized)).toEqual({ version: 1, web });
		expect(serialized).not.toMatch(/apiKey|token|credential/iu);
	});

	it.each([
		{ web: { search: { providers: ["unknown"] } } },
		{ web: { search: { providers: ["tavily", "tavily"] } } },
		{ web: { search: { timeoutMs: 0 } } },
		{ web: { search: { searxngEndpoint: "https://user:secret@search.example.test" } } },
		{ web: { cache: { maxEntries: 0 } } },
		{ web: { cache: { maxBytes: 64 * 1024 * 1024 + 1 } } },
		{ web: { fetch: { maxBytes: 50 * 1024 * 1024 + 1 } } },
		{ web: { apiKey: "must-not-be-serialized" } },
	])("rejects invalid or secret-bearing Web settings", async (settings) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-invalid-web-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(join(homeDirectory, ".coda", "settings.json"), JSON.stringify({ version: 1, ...settings }));
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow("invalid Web settings");
	});

	it.each([
		{ sandbox: { allowedDomains: ["*"] } },
		{ sandbox: { allowedDomains: ["*.com"] } },
		{ sandbox: { allowedDomains: ["https://example.test"] } },
		{ sandbox: { allowedDomains: ["example.test:0"] } },
		{ sandbox: { allowedDomains: ["2001:db8::1"] } },
		{ sandbox: { deniedDomains: ["*:0"] } },
	])("rejects Process Confinement domain patterns with ambiguous or overbroad authority", async (settings) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-invalid-domain-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(join(homeDirectory, ".coda", "settings.json"), JSON.stringify({ version: 1, ...settings }));
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow("invalid Process Confinement settings");
	});

	it("round-trips source-labelled Custom Provider metadata without serializing Credentials", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-model-metadata-settings-"));
		temporaryDirectories.push(homeDirectory);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "metadata" },
		});
		const customProviders = [
			{
				id: "custom-acme",
				name: "Acme",
				apiProtocol: "openai.responses" as const,
				baseUrl: "https://api.acme.test/v1",
				discovery: "ready" as const,
				models: [
					{
						id: "acme-one",
						name: "Acme One",
						contextWindow: { source: "provider" as const, value: 128_000 },
						maxTokens: { source: "user" as const, value: 16_384 },
						reasoning: { source: "provider" as const, value: true },
						input: { source: "user" as const, value: ["text", "image"] as const },
						price: {
							source: "user" as const,
							value: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
						},
						stale: true,
					},
				],
			},
		];

		await store.save({ customProviders });

		await expect(store.load()).resolves.toEqual({ customProviders });
		const serialized = await readFile(join(homeDirectory, ".coda", "settings.json"), "utf8");
		expect(JSON.parse(serialized)).toEqual({ version: 1, customProviders });
		expect(serialized).not.toContain("apiKey");
	});

	it.each([
		{
			label: "non-positive context window",
			metadata: { contextWindow: { source: "user", value: 0 } },
		},
		{
			label: "output greater than context",
			metadata: {
				contextWindow: { source: "user", value: 8_192 },
				maxTokens: { source: "user", value: 16_384 },
			},
		},
		{
			label: "serialized fallback source",
			metadata: { reasoning: { source: "compatibility", value: false } },
		},
	])("rejects invalid Custom Provider Model bounds and sources: $label", async ({ metadata }) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-invalid-model-metadata-settings-"));
		temporaryDirectories.push(homeDirectory);
		await mkdir(join(homeDirectory, ".coda"));
		await writeFile(
			join(homeDirectory, ".coda", "settings.json"),
			JSON.stringify({
				version: 1,
				customProviders: [
					{
						id: "custom-acme",
						name: "Acme",
						apiProtocol: "openai.responses",
						baseUrl: "https://api.acme.test/v1",
						discovery: "ready",
						models: [{ id: "invalid", name: "Invalid", ...metadata }],
					},
				],
			}),
		);
		const store = new FileSettingsStore({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			idGenerator: { generate: () => "unused" },
		});

		await expect(store.load()).rejects.toThrow("invalid custom Provider models");
	});

	it.each([{ unknownSetting: true }, { obsoleteModelSetting: "fixture" }])(
		"rejects unknown settings instead of silently ignoring them",
		async (unknown) => {
			const homeDirectory = await mkdtemp(join(tmpdir(), "coda-legacy-settings-"));
			temporaryDirectories.push(homeDirectory);
			await mkdir(join(homeDirectory, ".coda"));
			await writeFile(join(homeDirectory, ".coda", "settings.json"), JSON.stringify({ version: 1, ...unknown }));
			const store = new FileSettingsStore({
				fileSystem: createNodeFileSystem(),
				homeDirectory,
				idGenerator: { generate: () => "unused" },
			});

			await expect(store.load()).rejects.toThrow("unknown field");
		},
	);
});
