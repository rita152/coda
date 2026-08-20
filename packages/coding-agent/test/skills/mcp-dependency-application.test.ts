import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import type { McpConnection, McpConnector } from "@coda/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication, type UserSettings } from "../../src/application.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../../src/host/node-process-runner.ts";
import { testTimeRuntime } from "../time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";
	write(chunk: string): void {
		this.value += chunk;
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runExplicitSkill(
	approvalPolicy: "never" | "on-request",
	options: { readonly workspaceEquivalent?: boolean } = {},
) {
	const workspace = await mkdtemp(join(tmpdir(), "coda-skill-mcp-application-workspace-"));
	const homeDirectory = await mkdtemp(join(tmpdir(), "coda-skill-mcp-application-home-"));
	temporaryDirectories.push(workspace, homeDirectory);
	await mkdir(join(workspace, ".git"));
	if (options.workspaceEquivalent) {
		await mkdir(join(workspace, ".coda"));
		await writeFile(
			join(workspace, ".coda", "mcp.json"),
			`${JSON.stringify({
				version: 1,
				servers: [
					{
						id: "workspace-docs",
						transport: { kind: "http", url: "https://docs.example.test/mcp" },
					},
				],
			})}\n`,
		);
	}
	const skillRoot = join(workspace, ".agents", "skills", "review");
	await mkdir(join(skillRoot, "agents"), { recursive: true });
	await writeFile(
		join(skillRoot, "SKILL.md"),
		"---\nname: review\ndescription: Review with external docs\n---\n\nUse the application review workflow.\n",
	);
	await writeFile(
		join(skillRoot, "agents", "openai.yaml"),
		[
			"dependencies:",
			"  tools:",
			"    - type: mcp",
			"      value: docs",
			"      transport: streamable_http",
			"      url: https://docs.example.test/mcp",
			"policy:",
			"  products: [codex]",
			"",
		].join("\n"),
	);
	const runtime = testTimeRuntime(1_500);
	const faux = fauxProvider({ runtime });
	let observed: { readonly content: unknown; readonly toolNames: readonly string[] } | undefined;
	faux.setResponses([
		(context) => {
			observed = {
				content: context.messages.at(-1)?.content,
				toolNames: context.tools?.map(({ name }) => name) ?? [],
			};
			return fauxAssistantMessage("review complete", { timestamp: 1_500 });
		},
	]);
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	let settings: UserSettings = {};
	const save = vi.fn(async (value: UserSettings) => {
		settings = structuredClone(value);
	});
	const connection: McpConnection = {
		info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
		listTools: async () => [
			{
				name: "search",
				description: "Search external docs",
				inputSchema: { type: "object", properties: {} },
			},
		],
		callTool: async () => ({ isError: false, content: [] }),
		close: async () => undefined,
	};
	const connect = vi.fn(async () => connection);
	const connector: McpConnector = { connect };
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let id = 0;
	const application = createCodingAgentApplication({
		models,
		mcpConnector: connector,
		settings: { load: async () => structuredClone(settings), save },
		fileSystem: createNodeFileSystem(),
		processRunner: createNodeProcessRunner({ platform: "darwin" }),
		wrapScript: async () => undefined,
		io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
		runtime: {
			cwd: workspace,
			homeDirectory,
			platform: "darwin",
			environment: {},
			clock: runtime.clock,
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		},
	});

	const exitCode = await application.run([
		"--print",
		"--model",
		`${faux.getModel().provider}/${faux.getModel().id}`,
		"--ask-for-approval",
		approvalPolicy,
		"$review inspect this",
	]);
	return { exitCode, settings, save, connect, observed, stdout: stdout.value, stderr: stderr.value };
}

describe("Skill MCP dependency application composition", () => {
	it("auto-persists and refreshes before preparing the same print input under never + unrestricted", async () => {
		const result = await runExplicitSkill("never");

		expect(result.exitCode).toBe(0);
		expect(result.settings.mcpServers).toEqual([
			{ id: "docs", transport: { kind: "http", url: "https://docs.example.test/mcp" } },
		]);
		expect(result.save).toHaveBeenCalledOnce();
		expect(result.connect).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.observed?.content)).toContain("Use the application review workflow.");
		expect(result.observed?.toolNames).toContain("mcp__docs__search");
		expect(result.stdout).toBe("review complete\n");
		expect(result.stderr).toBe("");
	});

	it("continues without writing or refreshing MCP under headless on-request", async () => {
		const result = await runExplicitSkill("on-request");

		expect(result.exitCode).toBe(0);
		expect(result.settings.mcpServers).toBeUndefined();
		expect(result.save).not.toHaveBeenCalled();
		expect(result.connect).not.toHaveBeenCalled();
		expect(JSON.stringify(result.observed?.content)).toContain("Use the application review workflow.");
		expect(result.observed?.toolNames).not.toContain("mcp__docs__search");
		expect(result.stdout).toBe("review complete\n");
		expect(result.stderr).toContain("[skill-mcp-dependency-not-installed]");
		expect(result.stderr).toContain("review");
		expect(result.stderr).toContain("mcp__streamable_http__https://docs.example.test/mcp");
	});

	it("does not prompt or duplicate an equivalent untrusted Workspace MCP declaration", async () => {
		const result = await runExplicitSkill("never", { workspaceEquivalent: true });

		expect(result.exitCode).toBe(0);
		expect(result.settings.mcpServers).toBeUndefined();
		expect(result.save).not.toHaveBeenCalled();
		expect(result.connect).not.toHaveBeenCalled();
		expect(JSON.stringify(result.observed?.content)).toContain("Use the application review workflow.");
		expect(result.stderr).toContain("Workspace MCP configuration");
		expect(result.stderr).toContain("is untrusted; its Servers were omitted");
	});

	it("does not persist a Plugin Skill dependency already supplied by the same Agent Plugin", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-plugin-skill-mcp-workspace-"));
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-plugin-skill-mcp-home-"));
		temporaryDirectories.push(workspace, homeDirectory);
		await mkdir(join(workspace, ".git"));
		const pluginRoot = join(homeDirectory, ".agents", "plugins", "portable-tools");
		const skillRoot = join(pluginRoot, "skills", "review");
		await mkdir(join(skillRoot, "agents"), { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "portable-tools",
			}),
		);
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					docs: { type: "streamable-http", url: "https://docs.example.test/mcp" },
				},
			}),
		);
		await writeFile(
			join(skillRoot, "SKILL.md"),
			"---\nname: review\ndescription: Review through the portable Plugin\n---\n\nUse Plugin review instructions.\n",
		);
		await writeFile(
			join(skillRoot, "agents", "openai.yaml"),
			[
				"dependencies:",
				"  tools:",
				"    - type: mcp",
				"      value: docs",
				"      transport: streamable_http",
				"      url: https://docs.example.test/mcp",
				"policy:",
				"  products: [codex]",
				"",
			].join("\n"),
		);
		const runtime = testTimeRuntime(1_600);
		const faux = fauxProvider({ runtime });
		let toolNames: readonly string[] = [];
		faux.setResponses([
			(context) => {
				toolNames = context.tools?.map(({ name }) => name) ?? [];
				return fauxAssistantMessage("plugin review complete", { timestamp: 1_600 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		let settings: UserSettings = {};
		const save = vi.fn(async (value: UserSettings) => {
			settings = structuredClone(value);
		});
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{ name: "search", description: "Search docs", inputSchema: { type: "object", properties: {} } },
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const connect = vi.fn(async () => connection);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			mcpConnector: { connect },
			settings: { load: async () => structuredClone(settings), save },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			wrapScript: async () => undefined,
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"$portable-tools:review inspect this",
			]),
		).resolves.toBe(0);
		expect(settings.mcpServers).toBeUndefined();
		expect(save).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledOnce();
		expect(toolNames).toContain("mcp__plugin_portable-tools_docs__search");
		expect(stdout.value).toBe("plugin review complete\n");
		expect(stderr.value).toBe("");
	});

	it("scopes relative stdio dependencies to each Plugin root in the production prompt path", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-plugin-relative-stdio-workspace-"));
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-plugin-relative-stdio-home-"));
		temporaryDirectories.push(workspace, homeDirectory);
		await mkdir(join(workspace, ".git"));
		const writePlugin = async (name: string, contributesMcp: boolean): Promise<string> => {
			const pluginRoot = join(homeDirectory, ".agents", "plugins", name);
			const skillRoot = join(pluginRoot, "skills", "review");
			await mkdir(join(skillRoot, "agents"), { recursive: true });
			await mkdir(join(pluginRoot, "bin"), { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name,
				}),
			);
			if (contributesMcp) {
				await writeFile(
					join(pluginRoot, "mcp.json"),
					JSON.stringify({
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: { local: { type: "stdio", command: "./bin/server" } },
					}),
				);
			}
			await writeFile(join(pluginRoot, "bin", "server"), "#!/bin/sh\n");
			await writeFile(
				join(skillRoot, "SKILL.md"),
				`---\nname: review\ndescription: Review through ${name}\n---\n\nUse ${name} review instructions.\n`,
			);
			await writeFile(
				join(skillRoot, "agents", "openai.yaml"),
				[
					"dependencies:",
					"  tools:",
					"    - type: mcp",
					"      value: local",
					"      transport: stdio",
					"      command: ./bin/server",
					"policy:",
					"  products: [codex]",
					"",
				].join("\n"),
			);
			return pluginRoot;
		};
		const alphaRoot = await writePlugin("alpha-tools", true);
		const betaRoot = await writePlugin("beta-tools", false);
		const alphaCommand = await realpath(join(alphaRoot, "bin", "server"));
		const betaCommand = await realpath(join(betaRoot, "bin", "server"));
		const runtime = testTimeRuntime(1_700);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage("alpha review complete", { timestamp: 1_700 }),
			fauxAssistantMessage("beta review complete", { timestamp: 1_701 }),
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		let settings: UserSettings = {};
		const save = vi.fn(async (value: UserSettings) => {
			settings = structuredClone(value);
		});
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{ name: "search", description: "Search locally", inputSchema: { type: "object", properties: {} } },
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const connect = vi.fn(async (_definition: Parameters<McpConnector["connect"]>[0]) => connection);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			mcpConnector: { connect },
			settings: { load: async () => structuredClone(settings), save },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			wrapScript: async () => undefined,
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--no-session",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"$alpha-tools:review inspect this",
			]),
		).resolves.toBe(0);
		expect(save).not.toHaveBeenCalled();
		expect(settings.mcpServers).toBeUndefined();
		expect(connect.mock.calls[0]?.[0]).toMatchObject({
			id: "plugin_alpha-tools_local",
			transport: { kind: "stdio", command: alphaCommand },
		});

		await expect(
			application.run([
				"--print",
				"--no-session",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"$beta-tools:review inspect this",
			]),
		).resolves.toBe(0);
		expect(save).toHaveBeenCalledOnce();
		expect(settings.mcpServers).toEqual([{ id: "local", transport: { kind: "stdio", command: betaCommand } }]);
		expect(betaCommand).not.toBe(alphaCommand);
		expect(stdout.value).toBe("alpha review complete\nbeta review complete\n");
		expect(stderr.value).toBe("");
	});
});
