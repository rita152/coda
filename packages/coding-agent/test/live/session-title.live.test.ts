import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ApplicationOutput } from "../../src/application.ts";
import { createNodeCodingAgentApplication } from "../../src/node-application.ts";
import { EMPTY_SESSION_TITLE } from "../../src/session/session-summary.ts";

const representatives = [
	["anthropic-messages", "minimax-m3"],
	["openai-completions", "hy3"],
	["openai-completions", "deepseek-v4-flash"],
	["openai-responses", "gpt-5.6-luna"],
] as const;

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

describe.sequential("Live Session Title generation", () => {
	let apiKey: string;

	beforeAll(() => {
		apiKey = process.env.OPENCODE_API_KEY ?? "";
		if (!apiKey) throw new Error("OPENCODE_API_KEY is required for the opt-in live Session Title suite");
	});

	test.each(representatives)("names a Session through %s", async (_api, modelId) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-live-title-home-"));
		const workspace = await mkdtemp(join(tmpdir(), "coda-live-title-workspace-"));
		temporaryDirectories.push(homeDirectory, workspace);
		const canonicalWorkspace = await realpath(workspace);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createNodeCodingAgentApplication({
			cwd: canonicalWorkspace,
			homeDirectory,
			environment: { ...process.env, OPENCODE_API_KEY: apiKey },
			io: {
				stdin: { isTTY: false, readAll: async () => "" },
				stdout,
				stderr,
			},
		});
		const prompt =
			"Implement a bilingual /session picker that shows a short generated title instead of repeating the first user prompt. After you understand the task, reply with exactly the word ok and do not call any tools.";

		const exitCode = await application.run([
			"--print",
			"--session",
			"--max-turns",
			"2",
			"--model",
			`opencode-go/${modelId}`,
			"--api-key",
			apiKey,
			"--workspace",
			canonicalWorkspace,
			prompt,
		]);
		expect(stderr.value, stderr.value).toBe("");
		expect(exitCode).toBe(0);

		stdout.value = "";
		await expect(application.run(["sessions", "--workspace", canonicalWorkspace])).resolves.toBe(0);
		const [line] = stdout.value.trimEnd().split("\n");
		expect(line).toBeDefined();
		const [title, sessionId] = line!.split("\t");
		expect(title).toBeDefined();
		expect(sessionId).toBeDefined();
		expect(title).not.toBe(prompt);
		expect(title).not.toBe(EMPTY_SESSION_TITLE);
		expect(title!.toLowerCase()).not.toBe("ok");
		expect(title!.length).toBeGreaterThan(0);
		expect(Array.from(title!).length).toBeLessThanOrEqual(80);
		console.log(`${_api} / ${modelId} session title: ${title}`);

		const sessionDirectory = join(homeDirectory, ".coda", "sessions", workspaceId);
		const journals = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
		expect(journals).toContain(`${sessionId}.jsonl`);
		const journal = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), "utf8");
		expect(journal).toContain('"type":"session_title_set"');
		expect(journal).toContain(JSON.stringify(title));
	});
});
