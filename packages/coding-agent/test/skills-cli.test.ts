import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@coda/ai";
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

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "coda-skill-cli-"));
	temporary.push(cwd);
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let settingsLoads = 0;
	const application = createCodingAgentApplication({
		models: createModels({ runtime: testTimeRuntime() }),
		settings: {
			load: async () => {
				settingsLoads++;
				return {};
			},
			save: async () => undefined,
		},
		fileSystem: createNodeFileSystem(),
		processRunner: createNodeProcessRunner({ platform: "darwin" }),
		io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
		runtime: {
			cwd,
			homeDirectory: cwd,
			platform: "darwin",
			environment: {},
			clock: { now: () => 0 },
			idGenerator: { generate: (kind) => `${kind}:unused` },
		},
	});
	return { application, cwd, stdout, stderr, settingsLoads: () => settingsLoads };
}

describe("coda skills validate", () => {
	it("strictly validates a directory without loading settings or starting a Session", async () => {
		const value = await fixture();
		const directory = join(value.cwd, "review");
		await mkdir(directory);
		await writeFile(
			join(directory, "SKILL.md"),
			"---\nname: review\ndescription: Review local changes\n---\n\nReview carefully.\n",
		);

		await expect(value.application.run(["skills", "validate", directory])).resolves.toBe(0);
		expect(value.stdout.value).toContain("Valid Agent Skill");
		expect(value.stderr.value).toBe("");
		expect(value.settingsLoads()).toBe(0);
	});

	it("returns nonzero JSON diagnostics for strict nonconformance", async () => {
		const value = await fixture();
		const directory = join(value.cwd, "wrong-directory");
		await mkdir(directory);
		await writeFile(join(directory, "SKILL.md"), "---\nname: other\ndescription: Test\n---\nBody\n");

		await expect(value.application.run(["skills", "validate", directory, "--json"])).resolves.toBe(1);
		const output = JSON.parse(value.stdout.value);
		expect(output).toMatchObject({ schemaVersion: 1, type: "skill_validation", valid: false });
		expect(output.diagnostics.some(({ code }: { code: string }) => code === "name-directory-mismatch")).toBe(true);
		expect(value.settingsLoads()).toBe(0);
	});
});
