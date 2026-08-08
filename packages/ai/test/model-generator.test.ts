import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execute = promisify(execFile);

async function serve(body: string): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.setHeader("etag", '"fixture-etag"');
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not bind a port");
	return {
		url: `http://127.0.0.1:${address.port}/api.json`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

async function runGenerator(sourceUrl: string, outputDirectory: string) {
	return execute(
		join(process.cwd(), "../../node_modules/.bin/tsx"),
		[
			"scripts/update-opencode-go-models.ts",
			"--source-url",
			sourceUrl,
			"--output-dir",
			outputDirectory,
			"--fetched-at",
			"2026-08-08T00:00:00.000Z",
		],
		{ cwd: process.cwd() },
	);
}

describe("models:update", () => {
	test("downloads, corrects, validates, and atomically publishes a stable snapshot", async () => {
		const fixture = await readFile(new URL("./fixtures/models-dev-opencode-go.json", import.meta.url), "utf8");
		const server = await serve(fixture);
		const root = await mkdtemp(join(tmpdir(), "coda-models-update-"));
		const outputDirectory = join(root, "data");
		try {
			const result = await runGenerator(server.url, outputDirectory);
			const catalog = JSON.parse(await readFile(join(outputDirectory, "opencode-go.json"), "utf8")) as Record<
				string,
				Record<string, { api: string; compat?: Record<string, unknown> }>
			>;
			const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")) as Record<
				string,
				unknown
			>;

			expect(Object.keys(catalog)).toEqual(["anthropic-messages", "openai-completions", "openai-responses"]);
			expect(catalog["anthropic-messages"]?.["minimax-m3"]?.api).toBe("anthropic-messages");
			expect(catalog["openai-completions"]?.["minimax-m2.7"]?.api).toBe("openai-completions");
			expect(catalog["openai-completions"]?.["qwen3.6-plus"]?.compat).toMatchObject({
				thinkingFormat: "qwen",
			});
			expect(catalog["openai-completions"]?.["kimi-k2.6"]?.compat).toMatchObject({
				thinkingFormat: "deepseek",
				supportsReasoningEffort: false,
			});
			expect(catalog["openai-responses"]?.["gpt-5.6-luna"]?.api).toBe("openai-responses");
			expect(manifest).toMatchObject({
				etag: '"fixture-etag"',
				fetchedAt: "2026-08-08T00:00:00.000Z",
				generatorVersion: 1,
				recordCount: 6,
				sourceRecordCount: 6,
			});
			expect(result.stdout).toContain("added: 6");
			expect(await readFile(join(outputDirectory, "opencode-go.changes.md"), "utf8")).toContain("Added (6)");
		} finally {
			await server.close();
		}
	});

	test("leaves the previous directory untouched when routing validation fails", async () => {
		const invalid = JSON.stringify({
			"opencode-go": {
				models: {
					unknown: {
						id: "unknown",
						name: "Unknown",
						tool_call: true,
						provider: { npm: "@ai-sdk/unknown-wire" },
						limit: { context: 1, output: 1 },
						modalities: { input: ["text"], output: ["text"] },
					},
				},
			},
		});
		const server = await serve(invalid);
		const root = await mkdtemp(join(tmpdir(), "coda-models-failure-"));
		const outputDirectory = join(root, "data");
		const oldCatalog = `${JSON.stringify({
			"anthropic-messages": {},
			"openai-completions": {},
			"openai-responses": {},
		})}\n`;
		await mkdir(outputDirectory);
		await Promise.all([
			writeFile(join(outputDirectory, "opencode-go.json"), oldCatalog, "utf8"),
			writeFile(join(outputDirectory, "manifest.json"), '{"old":true}\n', "utf8"),
			writeFile(join(outputDirectory, "opencode-go.changes.md"), "old changes\n", "utf8"),
		]);
		try {
			await expect(runGenerator(server.url, outputDirectory)).rejects.toMatchObject({
				stderr: expect.stringContaining("Unknown OpenCode Go wire implementation"),
			});
			expect(await readFile(join(outputDirectory, "opencode-go.json"), "utf8")).toBe(oldCatalog);
			expect(await readFile(join(outputDirectory, "manifest.json"), "utf8")).toBe('{"old":true}\n');
			expect(await readFile(join(outputDirectory, "opencode-go.changes.md"), "utf8")).toBe("old changes\n");
		} finally {
			await server.close();
		}
	});

	test("rejects malformed models.dev records before publishing any directory", async () => {
		const malformed = JSON.stringify({
			"opencode-go": {
				models: {
					broken: {
						tool_call: true,
						provider: { npm: "@ai-sdk/openai" },
						limit: { context: "not-a-number", output: 100 },
					},
				},
			},
		});
		const server = await serve(malformed);
		const root = await mkdtemp(join(tmpdir(), "coda-models-schema-"));
		const outputDirectory = join(root, "data");
		try {
			await expect(runGenerator(server.url, outputDirectory)).rejects.toMatchObject({
				stderr: expect.stringContaining("schema validation failed"),
			});
			await expect(access(outputDirectory)).rejects.toThrow();
		} finally {
			await server.close();
		}
	});
});
