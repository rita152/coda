import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { McpConnection, McpConnector } from "@coda/mcp";
import { afterEach, describe, expect, it } from "vitest";
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

describe("MCP application composition", () => {
	it("keeps Workspace Plugin Skills active while exact trust gates stdio MCP and its data directory", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-plugin-application-"));
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-plugin-home-"));
		temporaryDirectories.push(workspace, homeDirectory);
		const canonicalWorkspace = await realpath(workspace);
		const pluginRoot = join(workspace, ".agents", "plugins", "review-tools");
		await mkdir(join(pluginRoot, "skills", "plugin-review"), { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "review-tools",
			}),
		);
		const canonicalPluginRoot = await realpath(pluginRoot);
		await writeFile(
			join(pluginRoot, "skills", "plugin-review", "SKILL.md"),
			"---\nname: plugin-review\ndescription: Review through the Agent Plugin\n---\n\nUse the Plugin review workflow.\n",
		);
		const pluginRootPlaceholder = "${" + "PLUGIN_ROOT}";
		const pluginDataPlaceholder = "${" + "PLUGIN_DATA}";
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					local: {
						type: "stdio",
						command: "node",
						args: [`${pluginRootPlaceholder}/server.mjs`, `${pluginDataPlaceholder}/cache`],
						env: { PLUGIN_MODE: `${pluginRootPlaceholder}:portable` },
						cwd: pluginRootPlaceholder,
					},
				},
			}),
		);
		const userPluginRoot = join(homeDirectory, ".agents", "plugins", "remote-docs");
		await mkdir(userPluginRoot, { recursive: true });
		await writeFile(
			join(userPluginRoot, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "remote-docs",
			}),
		);
		await writeFile(
			join(userPluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					docs: { type: "streamable-http", url: "https://docs.example.test/mcp" },
				},
			}),
		);
		const runtime = testTimeRuntime(500);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("Review through the Agent Plugin");
				return fauxAssistantMessage("plugin skill available before MCP trust", { timestamp: 500 });
			},
			(context) => {
				expect(context.systemPrompt).toContain("Review through the Agent Plugin");
				return fauxAssistantMessage("plugin MCP trusted", { timestamp: 500 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		let settings: UserSettings = {};
		const definitions: Parameters<McpConnector["connect"]>[0][] = [];
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const connector: McpConnector = {
			connect: async (definition) => {
				definitions.push(definition);
				return connection;
			},
		};
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			mcpConnector: connector,
			settings: {
				load: async () => structuredClone(settings),
				save: async (value) => {
					settings = structuredClone(value);
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory,
				platform: "darwin",
				environment: { PATH: "/usr/bin" },
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;

		await expect(application.run(["--print", "--model", model, "review first"])).resolves.toBe(0);

		expect(definitions).toEqual([
			expect.objectContaining({
				protocol: "auto",
				transport: { kind: "http", url: "https://docs.example.test/mcp" },
			}),
		]);
		await expect(lstat(join(homeDirectory, ".coda", "plugin-data"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(stderr.value).toContain("untrusted");

		stderr.value = "";
		await expect(application.run(["--print", "--model", model, "--trust-project-mcp", "review again"])).resolves.toBe(
			0,
		);

		expect(definitions).toHaveLength(3);
		const stdioDefinition = definitions.find(({ transport }) => transport.kind === "stdio");
		expect(stdioDefinition).toMatchObject({
			id: expect.stringMatching(/^plugin_[a-f0-9]{56}$/u),
			protocol: "auto",
			transport: {
				kind: "stdio",
				command: "node",
				args: [join(canonicalPluginRoot, "server.mjs"), expect.stringMatching(/\/cache$/u)],
				cwd: canonicalPluginRoot,
				environment: expect.objectContaining({
					PATH: "/usr/bin",
					PLUGIN_ROOT: canonicalPluginRoot,
					PLUGIN_MODE: `${canonicalPluginRoot}:portable`,
				}),
			},
		});
		if (stdioDefinition?.transport.kind !== "stdio") throw new Error("expected stdio Plugin definition");
		const dataDirectory = stdioDefinition.transport.environment?.PLUGIN_DATA;
		expect(dataDirectory).toBeTruthy();
		expect((await lstat(dataDirectory!)).mode & 0o777).toBe(0o700);
		expect(settings).toMatchObject({
			workspaceMcpTrust: [
				{
					workspace: canonicalWorkspace,
					path: join(canonicalPluginRoot, "mcp.json"),
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
				},
			],
		});
	});

	it("discovers an MCP Tool, admits it after a `$` mention, and returns its result", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-mcp-application-"));
		temporaryDirectories.push(workspace);
		const runtime = testTimeRuntime(500);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__docs__search", { query: "MCP" }, { id: "provider-mcp-call" }), {
				stopReason: "toolUse",
				timestamp: 500,
			}),
			fauxAssistantMessage("used external docs", { timestamp: 500 }),
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const calls: unknown[] = [];
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "search",
					description: "Search external docs",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			],
			callTool: async (request) => {
				calls.push(request);
				return { isError: false, content: [{ type: "text", text: "external result" }] };
			},
			close: async () => undefined,
		};
		const connector: McpConnector = { connect: async () => connection };
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			mcpConnector: connector,
			settings: {
				load: async () => ({
					mcpServers: [
						{
							id: "docs",
							transport: { kind: "http", url: "https://docs.example.test/mcp" },
						},
					],
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
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
			"Use $search to look up MCP",
		]);
		expect({ exitCode, stderr: stderr.value }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.value).toBe("used external docs\n");
		expect(calls).toEqual([{ name: "search", arguments: { query: "MCP" } }]);
		expect(faux.state.callCount).toBe(2);
	});

	it("does not freeze MCP Tools into a Run without a `$` mention", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-mcp-application-absent-"));
		temporaryDirectories.push(workspace);
		const runtime = testTimeRuntime(500);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			(context) => {
				expect(context.tools?.some(({ name }) => name.startsWith("mcp__"))).toBe(false);
				return fauxAssistantMessage("CODA_MCP_ABSENT", { timestamp: 500 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "search",
					description: "Search external docs",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			],
			callTool: async () => {
				throw new Error("MCP Tool must not run without a $ mention");
			},
			close: async () => undefined,
		};
		const connector: McpConnector = { connect: async () => connection };
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			mcpConnector: connector,
			settings: {
				load: async () => ({
					mcpServers: [
						{
							id: "docs",
							transport: { kind: "http", url: "https://docs.example.test/mcp" },
						},
					],
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
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
			"search docs",
		]);
		expect({ exitCode, stderr: stderr.value }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.value).toBe("CODA_MCP_ABSENT\n");
	});
});
