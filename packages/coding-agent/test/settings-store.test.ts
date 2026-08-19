import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSettingsStore } from "../src/app/file-settings-store.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSettingsStore", () => {
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
