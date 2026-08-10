#!/usr/bin/env node

import { createMcpHost, createSdkMcpConnector } from "../../dist/index.js";

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv[2];

if (!scenario || !serverUrl) {
	throw new Error("Usage: MCP_CONFORMANCE_SCENARIO=<scenario> client.mjs <server-url>");
}

const mockedDiscoverScenarios = new Set([
	"http-standard-headers",
	"http-custom-headers",
	"http-invalid-tool-headers",
	"sep-2322-client-request-state",
]);

function withLocalDiscoverResponse(input, init) {
	if (typeof init?.body === "string") {
		try {
			const message = JSON.parse(init.body);
			if (message.method === "server/discover") {
				return Promise.resolve(
					Response.json({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: { listChanged: true } },
							_meta: {
								"io.modelcontextprotocol/serverInfo": {
									name: "coda-conformance-fixture",
									version: "1.0.0",
								},
							},
						},
					}),
				);
			}
		} catch {
			// Forward non-JSON requests to the conformance referee.
		}
	}
	return fetch(input, init);
}

const connector = createSdkMcpConnector({
	client: { name: "coda-conformance-client", version: "0.1.0" },
	...(mockedDiscoverScenarios.has(scenario) ? { fetch: withLocalDiscoverResponse } : {}),
});

const definition = {
	id: "conformance",
	protocol: "auto",
	transport: { kind: "http", url: serverUrl },
};

async function connectOnly() {
	const connection = await connector.connect(definition);
	await connection.close();
}

async function withConnection(operation) {
	const connection = await connector.connect(definition);
	try {
		await operation(connection);
	} finally {
		await connection.close();
	}
}

async function withHost(operation) {
	const host = createMcpHost({ connector });
	try {
		const snapshot = await host.reload([definition]);
		const server = snapshot.servers[0];
		if (!server || server.status !== "ready") {
			throw new Error(server?.error ?? "Conformance Server did not become ready");
		}
		await operation(host, snapshot);
	} finally {
		await host.close();
	}
}

function contextToolCalls() {
	const raw = process.env.MCP_CONFORMANCE_CONTEXT;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	return Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
}

switch (scenario) {
	case "request-metadata":
		await connectOnly();
		break;
	case "tools_call":
		await withHost(async (host, snapshot) => {
			const tool = snapshot.tools.find(({ remoteName }) => remoteName === "add_numbers");
			if (tool) await host.callTool({ toolId: tool.id, arguments: { a: 5, b: 3 } });
		});
		break;
	case "sep-2322-client-request-state":
		await withHost(async (host, snapshot) => {
			for (const name of [
				"test_mrtr_echo_state",
				"test_mrtr_no_state",
				"test_mrtr_unrelated",
				"test_mrtr_no_result_type",
			]) {
				const tool = snapshot.tools.find(({ remoteName }) => remoteName === name);
				if (!tool) throw new Error(`Missing conformance Tool: ${name}`);
				await host
					.callTool({
						toolId: tool.id,
						arguments: {},
						elicit: async () => ({ action: "accept", content: { confirmed: true } }),
					})
					.catch((error) => {
						if (name !== "test_mrtr_no_result_type") throw error;
					});
			}
		});
		break;
	case "http-custom-headers":
		await withConnection(async (connection) => {
			await connection.listTools();
			for (const call of contextToolCalls()) {
				await connection.callTool({ name: call.name, arguments: call.arguments ?? {} });
			}
		});
		break;
	case "http-invalid-tool-headers":
		await withHost(async (host, snapshot) => {
			for (const tool of snapshot.tools) {
				await host.callTool({ toolId: tool.id, arguments: { region: "us-west1" } }).catch(() => undefined);
			}
		});
		break;
	case "http-standard-headers":
		await withHost(async (host, snapshot) => {
			const tool = snapshot.tools[0];
			if (tool) await host.callTool({ toolId: tool.id, arguments: {} });
		});
		break;
	case "json-schema-ref-no-deref":
		await withHost(async () => undefined);
		break;
	default:
		throw new Error(`Unsupported Coda conformance scenario: ${scenario}`);
}
