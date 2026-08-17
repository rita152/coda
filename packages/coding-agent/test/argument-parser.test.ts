import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArguments } from "../src/app/argument-parsing.ts";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class BufferOutput implements ApplicationOutput {
	readonly isTTY: boolean;
	value = "";

	constructor(isTTY: boolean) {
		this.isTTY = isTTY;
	}

	write(chunk: string): void {
		this.value += chunk;
	}
}

describe("application argument parsing", () => {
	it("accepts print aliases and projects parsed prompt, reasoning, and output-token flags", async () => {
		const fixture = await setup({ stdinTTY: true, stdoutTTY: false });
		let observedPrompt: unknown;
		let observedReasoning: unknown;
		let observedMaxTokens: unknown;
		fixture.faux.setResponses([
			(context, options) => {
				observedPrompt = context.messages.at(-1)?.content;
				observedReasoning = options.reasoning;
				observedMaxTokens = options.maxTokens;
				return fauxAssistantMessage("parsed", { timestamp: 100 });
			},
		]);

		await expect(
			fixture.application.run([
				"--no-tui",
				"--model",
				fixture.model,
				"--reasoning",
				"off",
				"--max-output-tokens",
				"128",
				"hello",
				"world",
			]),
		).resolves.toBe(0);
		expect(observedPrompt).toBe("hello world");
		expect(observedReasoning).toBeUndefined();
		expect(observedMaxTokens).toBe(128);
		expect(fixture.stdout.value).toBe("parsed\n");
		expect(fixture.stderr.value).toBe("");
	});

	it("preserves exact flag-conflict diagnostics", async () => {
		const fixture = await setup({ stdinTTY: true, stdoutTTY: true });
		const cases: ReadonlyArray<readonly [readonly string[], string]> = [
			[["--print", "--interactive"], "--print and --interactive cannot be combined"],
			[["--json", "--interactive"], "--json cannot be used with --interactive"],
			[["--json-mode", "semantic"], "--json-mode requires --json"],
			[["--include-media-data"], "--include-media-data requires --json"],
			[["--no-run-budget", "--max-turns", "2"], "--no-run-budget and --max-turns cannot be combined"],
			[
				["--run-control-work-ms", "10"],
				"--run-control-work-ms and --run-control-grace-ms must be configured together",
			],
			[
				["--run-control-stationary-turns", "2"],
				"--run-control-stationary-turns requires RunControl work and grace deadlines",
			],
			[["--session", "--no-session"], "--no-session cannot be combined with --session or --resume"],
			[["--no-session", "--resume", "session:1"], "--resume cannot be combined with --no-session"],
			[["--sandbox", "--no-sandbox"], "--sandbox and --no-sandbox cannot be combined"],
			[["--no-permission", "--strict-permissions"], "--no-permission and --strict-permissions cannot be combined"],
			[
				["--ask-for-approval", "untrusted", "--no-permission"],
				"--ask-for-approval and --no-permission cannot be combined",
			],
			[
				["--sandbox", "read-only", "--yolo"],
				"--sandbox cannot be combined with --dangerously-bypass-approvals-and-sandbox",
			],
		];

		for (const [args, message] of cases) {
			fixture.stderr.value = "";
			await expect(fixture.application.run(args)).resolves.toBe(1);
			expect(fixture.stderr.value).toBe(`coda: ${message}\n`);
		}
	});

	it("infers interactive mode only when both input and output are terminals", async () => {
		const interactive = await setup({ stdinTTY: true, stdoutTTY: true });
		await expect(interactive.application.run([])).resolves.toBe(1);
		expect(interactive.stderr.value).toBe("coda: Interactive mode requires an injected Terminal factory\n");
		expect(interactive.readAll).not.toHaveBeenCalled();

		const print = await setup({ stdinTTY: true, stdoutTTY: false });
		await expect(print.application.run(["automatic print"])).resolves.toBe(0);
		expect(print.stdout.value).toBe("parsed\n");
		expect(print.stderr.value).toBe("");
		expect(print.readAll).not.toHaveBeenCalled();
	});

	it("reads and trims stdin exactly once for an inferred print Run with no prompt arguments", async () => {
		const fixture = await setup({ stdinTTY: false, stdoutTTY: true, stdinText: "  piped prompt\n" });
		let observedPrompt: unknown;
		fixture.faux.setResponses([
			(context) => {
				observedPrompt = context.messages.at(-1)?.content;
				return fauxAssistantMessage("from stdin", { timestamp: 100 });
			},
		]);

		await expect(fixture.application.run([])).resolves.toBe(0);
		expect(fixture.readAll).toHaveBeenCalledTimes(1);
		expect(observedPrompt).toBe("piped prompt");
		expect(fixture.stdout.value).toBe("from stdin\n");
	});
});

async function setup(options: { stdinTTY: boolean; stdoutTTY: boolean; stdinText?: string }) {
	const root = await mkdtemp(join(tmpdir(), "coda-argument-parser-"));
	temporaryDirectories.push(root);
	const runtime = testTimeRuntime(100);
	const faux = fauxProvider({ runtime });
	faux.setResponses([fauxAssistantMessage("parsed", { timestamp: 100 })]);
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	const stdout = new BufferOutput(options.stdoutTTY);
	const stderr = new BufferOutput(false);
	const readAll = vi.fn(async () => options.stdinText ?? "");
	let id = 0;
	const model = `${faux.getModel().provider}/${faux.getModel().id}`;
	const application = createCodingAgentApplication({
		models,
		settings: {
			load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
			save: async () => undefined,
		},
		fileSystem: createNodeFileSystem(),
		processRunner: createNodeProcessRunner({ platform: "darwin" }),
		io: { stdin: { isTTY: options.stdinTTY, readAll }, stdout, stderr },
		runtime: {
			cwd: root,
			homeDirectory: root,
			platform: "darwin",
			environment: {},
			clock: runtime.clock,
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		},
	});
	return { application, faux, model, stdout, stderr, readAll };
}

describe("approval and sandbox flags", () => {
	const io = {
		stdin: { isTTY: true, readAll: async () => "" },
		stdout: { isTTY: true, write: () => undefined },
		stderr: { isTTY: true, write: () => undefined },
	};

	it("parses Codex approval and sandbox modes, including bare --sandbox as workspace-write", async () => {
		await expect(
			parseArguments(["--ask-for-approval", "untrusted", "--sandbox", "read-only"], io),
		).resolves.toMatchObject({
			approvalPolicy: "untrusted",
			sandboxMode: "read-only",
		});
		await expect(parseArguments(["-a", "never", "-s"], io)).resolves.toMatchObject({
			approvalPolicy: "never",
			sandboxMode: "workspace-write",
		});
		await expect(parseArguments(["--yolo"], io)).resolves.toMatchObject({
			bypassApprovalsAndSandbox: true,
		});
	});
});
