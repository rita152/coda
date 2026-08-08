import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication, type UserSettings } from "../src/application.ts";
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

describe("Project Trust", () => {
	it("fails closed on an untrusted root AGENTS.md and loads only the explicitly trusted hash", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-project-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "AGENTS.md"), "Use project-specific checks.\n", "utf8");
		const faux = fauxProvider({ runtime: testTimeRuntime(1_000) });
		faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("BEGIN TRUSTED PROJECT INSTRUCTIONS");
				expect(context.systemPrompt).toContain("Use project-specific checks.");
				return fauxAssistantMessage("Trusted instructions loaded.", { timestamp: 1_000 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(1_000) });
		models.setProvider(faux.provider);
		let savedSettings: UserSettings | undefined;
		const settings = {
			load: async () => savedSettings ?? {},
			save: async (value: UserSettings) => {
				savedSettings = structuredClone(value);
			},
		};
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 1_000 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});
		const modelArgument = `${faux.getModel().provider}/${faux.getModel().id}`;

		await expect(application.run(["--print", "--model", modelArgument, "inspect project"])).resolves.toBe(1);
		expect(stderr.value).toContain("AGENTS.md is untrusted");
		expect(faux.state.callCount).toBe(0);

		stderr.value = "";
		await expect(
			application.run(["--print", "--trust-project", "--model", modelArgument, "inspect project"]),
		).resolves.toBe(0);
		expect(stdout.value).toBe("Trusted instructions loaded.\n");
		expect(savedSettings?.projectTrust).toEqual([
			expect.objectContaining({
				path: expect.stringMatching(/\/AGENTS\.md$/),
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		]);
	});
});
