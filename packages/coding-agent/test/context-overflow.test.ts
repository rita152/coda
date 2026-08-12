import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
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
	it("chunks an oversized Tool result through Auto-Compaction before the next model call", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-context-overflow-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "large.txt"), `oversized-tool-result:${"x".repeat(60_000)}`, "utf8");
		const runtime = testTimeRuntime(2_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "bounded", contextWindow: 8_000, maxTokens: 512 }],
		});
		const summarizeOrContinue = (context: Context) => {
			const serialized = JSON.stringify(context.messages);
			if (serialized.includes("Create a durable conversation checkpoint")) {
				return fauxAssistantMessage(validSummary(), { timestamp: 2_000 });
			}
			expect(serialized).toContain("<conversation-checkpoint");
			expect(serialized).not.toContain("oversized-tool-result:");
			return fauxAssistantMessage("continued after chunked compaction", { timestamp: 2_000 });
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:read-large" }), {
				stopReason: "toolUse",
				timestamp: 2_000,
			}),
			...Array.from({ length: 64 }, () => summarizeOrContinue),
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

		await expect(application.run(["--print", "--model", "faux/bounded", "read the large file"])).resolves.toBe(0);
		expect(faux.state.callCount).toBeGreaterThan(3);
		expect(stdout.value).toBe("continued after chunked compaction\n");
		expect(stderr.value).toBe("");
	});
});

function validSummary(): string {
	return [
		"## Objective",
		"- Continue reading the file.",
		"## Constraints",
		"- Preserve state.",
		"## Decisions",
		"- The oversized result was reduced in stages.",
		"## Completed",
		"- Read large.txt.",
		"## Current State",
		"- Ready.",
		"## Next Steps",
		"- Continue.",
		"## Relevant Files and Commands",
		"- large.txt",
		"## Errors and Open Questions",
		"- None.",
	].join("\n");
}
