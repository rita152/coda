import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSystem } from "../../src/host/file-system.ts";
import {
	inspectMcpConfiguration,
	parseMcpServerConfigurations,
	type WorkspaceMcpTrustRecord,
} from "../../src/mcp/config.ts";

function fileSystemWith(files: Readonly<Record<string, string>>): FileSystem {
	return {
		readFile: async (path) => {
			const value = files[path];
			if (value === undefined) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
			return new TextEncoder().encode(value);
		},
		realpath: async (path) => path,
		stat: async () => {
			throw new Error("not implemented");
		},
		lstat: async () => {
			throw new Error("not implemented");
		},
		readDirectory: async () => [],
		makeDirectory: async () => undefined,
		open: async () => {
			throw new Error("not implemented");
		},
		rename: async () => undefined,
		removeFile: async () => undefined,
		removeDirectory: async () => undefined,
		removeTree: async () => undefined,
		setMode: async () => undefined,
	};
}

describe("MCP configuration", () => {
	it("keeps an exact Workspace configuration inert until its hash is trusted", async () => {
		const workspace = "/workspace";
		const path = join(workspace, ".coda", "mcp.json");
		const content = JSON.stringify({
			version: 1,
			servers: [
				{
					id: "workspace-tools",
					transport: { kind: "stdio", command: "node", args: ["server.mjs"] },
				},
			],
		});
		const sha256 = createHash("sha256").update(content).digest("hex");
		const fileSystem = fileSystemWith({ [path]: content });
		const userServers = parseMcpServerConfigurations(
			[
				{
					id: "remote-docs",
					transport: {
						kind: "http",
						url: "https://docs.example.test/mcp",
						bearerTokenEnvironment: "DOCS_TOKEN",
					},
				},
			],
			"User MCP configuration",
		);

		const untrusted = await inspectMcpConfiguration({
			workspace,
			fileSystem,
			userServers,
			workspaceTrust: [],
			environment: { DOCS_TOKEN: "secret-token" },
		});

		expect(untrusted.workspace).toEqual({
			path,
			sha256,
			trust: "untrusted",
			serverCount: 1,
			servers: expect.any(Array),
		});
		expect(untrusted.definitions.map(({ id }) => id)).toEqual(["remote-docs"]);
		expect(untrusted.definitions[0]).toMatchObject({
			protocol: "auto",
			transport: { kind: "http", url: "https://docs.example.test/mcp" },
		});
		if (untrusted.definitions[0]?.transport.kind !== "http") throw new Error("expected HTTP definition");
		await expect(untrusted.definitions[0].transport.bearerToken?.()).resolves.toBe("secret-token");

		const trust: WorkspaceMcpTrustRecord = { workspace, path, sha256 };
		const trusted = await inspectMcpConfiguration({
			workspace,
			fileSystem,
			userServers,
			workspaceTrust: [trust],
			environment: { DOCS_TOKEN: "secret-token" },
		});

		expect(trusted.workspace?.trust).toBe("trusted");
		expect(trusted.definitions.map(({ id }) => id)).toEqual(["remote-docs", "workspace-tools"]);
		expect(trusted.definitions[1]).toEqual({
			id: "workspace-tools",
			protocol: "2026-07-28",
			transport: {
				kind: "stdio",
				command: "node",
				args: ["server.mjs"],
				cwd: workspace,
			},
		});
	});

	it("rejects unknown fields, ambient authorization headers, and duplicate cross-scope identities", async () => {
		expect(() =>
			parseMcpServerConfigurations(
				[{ id: "bad", transport: { kind: "http", url: "https://example.test/mcp" }, surprise: true }],
				"MCP configuration",
			),
		).toThrow("unknown field");
		expect(() =>
			parseMcpServerConfigurations(
				[
					{
						id: "bad",
						transport: {
							kind: "http",
							url: "https://example.test/mcp",
							headers: { Authorization: "Bearer plaintext" },
						},
					},
				],
				"MCP configuration",
			),
		).toThrow("bearerTokenEnvironment");
		expect(() =>
			parseMcpServerConfigurations(
				[
					{
						id: "bad",
						transport: {
							kind: "http",
							url: "https://example.test/mcp",
							headers: { "MCP-Protocol-Version": "spoofed" },
						},
					},
				],
				"MCP configuration",
			),
		).toThrow("must not override MCP protocol headers");
		expect(() =>
			parseMcpServerConfigurations(
				[
					{
						id: "bad",
						transport: { kind: "stdio", command: "/bin/echo", environment: { "BAD=NAME": "x" } },
					},
				],
				"MCP configuration",
			),
		).toThrow("invalid environment variable name");

		const workspace = "/workspace";
		const path = join(workspace, ".coda", "mcp.json");
		const content = JSON.stringify({
			version: 1,
			servers: [
				{
					id: "same",
					transport: { kind: "http", url: "https://workspace.example.test/mcp" },
				},
			],
		});
		const sha256 = createHash("sha256").update(content).digest("hex");
		await expect(
			inspectMcpConfiguration({
				workspace,
				fileSystem: fileSystemWith({ [path]: content }),
				userServers: parseMcpServerConfigurations(
					[{ id: "same", transport: { kind: "http", url: "https://user.example.test/mcp" } }],
					"User MCP configuration",
				),
				workspaceTrust: [{ workspace, path, sha256 }],
				environment: {},
			}),
		).rejects.toThrow('Duplicate MCP Server id "same" across User and Workspace configuration');
	});

	it.each([
		" https://example.test/mcp",
		"https:example.test/mcp",
		"https:\\example.test\\mcp",
		"https://@example.test/mcp",
		"https://example.test/mcp#",
	])("rejects a non-literal absolute MCP HTTP URL (%s)", (url) => {
		expect(() =>
			parseMcpServerConfigurations([{ id: "bad-url", transport: { kind: "http", url } }], "MCP configuration"),
		).toThrow("absolute http(s) URL without credentials or a fragment");
	});
});
