import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { McpConnection, McpConnector } from "@coda/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../../src/application.ts";
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
	it("discovers an MCP Tool, freezes it into the Run, and returns its result", async () => {
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
			"search docs",
		]);
		expect({ exitCode, stderr: stderr.value }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.value).toBe("used external docs\n");
		expect(calls).toEqual([{ name: "search", arguments: { query: "MCP" } }]);
		expect(faux.state.callCount).toBe(2);
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
