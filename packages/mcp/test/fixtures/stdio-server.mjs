import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

void serveStdio(() => {
	const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
	server.registerTool(
		"echo",
		{
			description: "Echo text from the stdio fixture",
			inputSchema: z.object({ text: z.string() }),
		},
		async ({ text }) => ({ content: [{ type: "text", text }] }),
	);
	server.registerTool(
		"environment",
		{ inputSchema: z.object({}) },
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						allowed: process.env.CODA_MCP_FIXTURE,
						ambient: process.env.CODA_MCP_AMBIENT_SECRET,
						home: process.env.HOME,
					}),
				},
			],
		}),
	);
	return server;
});
