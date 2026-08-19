import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createNodePinnedFetch, terminalEnvironmentForStartup } from "../src/node-application.ts";

describe("Node Coding Agent Terminal startup", () => {
	it("applies NO_COLOR to one Terminal environment without mutating the process environment snapshot", () => {
		const environment = { TERM: "xterm-256color" } as const;

		const terminalEnvironment = terminalEnvironmentForStartup(environment, true);

		expect(terminalEnvironment).toEqual({ TERM: "xterm-256color", NO_COLOR: "1" });
		expect(terminalEnvironment).not.toBe(environment);
		expect(environment).toEqual({ TERM: "xterm-256color" });
		expect(terminalEnvironmentForStartup(environment, false)).toBe(environment);
	});

	it("connects through a pinned address without resolving the request hostname again", async () => {
		const server = createServer((request, response) => {
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.end(`host=${request.headers.host}`);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address() as AddressInfo;
			const response = await createNodePinnedFetch(globalThis.fetch)(
				`http://does-not-resolve.invalid:${address.port}/pinned`,
				{},
				["127.0.0.1"],
			);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(`host=does-not-resolve.invalid:${address.port}`);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				}),
			);
		}
	});
});
