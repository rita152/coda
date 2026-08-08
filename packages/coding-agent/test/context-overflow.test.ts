import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";

import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

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

describe("model-call context preflight", () => {
	it("checks the actual transcript again after a Tool result before the next model call", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-context-overflow-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "large.txt"), "x".repeat(60_000), "utf8");
		const runtime = testTimeRuntime(2_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "bounded", contextWindow: 4_000, maxTokens: 512 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:read-large" }), {
				stopReason: "toolUse",
				timestamp: 2_000,
			}),
			fauxAssistantMessage("must not be requested", { timestamp: 2_000 }),
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(application.run(["--print", "--model", "faux/bounded", "read the large file"])).resolves.toBe(1);
		expect(faux.state.callCount).toBe(1);
		expect(stdout.value).toBe("");
		expect(stderr.value).toContain("Context Overflow");
	});
});
