import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication, type UserSettings } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { stableCompletionWorkspaceEvidence } from "./completion-test-helpers.ts";
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

describe("Lifecycle Hook application integration", () => {
	it("fires Session, prompt, Tool, and Stop hooks on their real runtime boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-hook-app-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		const hookDirectory = join(workspace, ".coda");
		const logPath = join(root, "events.ndjson");
		const scriptPath = join(root, "record-hook.cjs");
		await Promise.all([mkdir(join(home, ".coda"), { recursive: true }), mkdir(hookDirectory, { recursive: true })]);
		await writeFile(
			scriptPath,
			"const fs=require('node:fs');let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(value);fs.appendFileSync(process.argv[2],value+'\\n');if(input.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'printf rewritten'}}}));if(input.hook_event_name==='PostToolUse')process.stdout.write(JSON.stringify({continue:false,reason:'post-hook replacement'}));});",
		);
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} ${JSON.stringify(logPath)}`;
		const eventNames = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
		await writeFile(
			join(hookDirectory, "hooks.json"),
			JSON.stringify({
				hooks: Object.fromEntries(eventNames.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])),
			}),
		);

		const faux = fauxProvider({ runtime: testTimeRuntime(1_000) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf original" }, { id: "hook-tool" }), {
				stopReason: "toolUse",
				timestamp: 1_000,
			}),
			(context) => {
				const latest = context.messages.at(-1);
				expect(latest, JSON.stringify(latest)).toMatchObject({
					role: "toolResult",
					toolCallId: "hook-tool",
					content: [{ type: "text", text: "post-hook replacement" }],
				});
				return fauxAssistantMessage("hooks complete", { timestamp: 1_000 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(1_000) });
		models.setProvider(faux.provider);
		let persistedSettings: UserSettings = {};
		let identity = 0;
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => persistedSettings,
				save: async (settings) => {
					persistedSettings = settings;
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			completionWorkspaceEvidence: stableCompletionWorkspaceEvidence(1_000),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: home,
				platform: process.platform,
				environment: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/sh" },
				clock: { now: () => 1_000 },
				idGenerator: { generate: (kind) => `${kind}:${++identity}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--trust-hooks",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"exercise hooks",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("hooks complete\n");
		expect(persistedSettings.hookTrust).toHaveLength(eventNames.length);
		const events = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events.map((event) => event.hook_event_name)).toEqual(eventNames);
		expect(events[0]).toMatchObject({ source: "startup", permission_mode: "bypassPermissions" });
		expect(events[1]).toMatchObject({ prompt: "exercise hooks" });
		expect(events[2]).toMatchObject({ tool_name: "Bash", tool_input: { command: "printf original" } });
		expect(events[3]).toMatchObject({ tool_name: "Bash", tool_input: { command: "printf rewritten" } });
		expect(events[4]).toMatchObject({ stop_hook_active: false, last_assistant_message: "hooks complete" });
		expect(events[5]).toMatchObject({ reason: "other" });
	});

	it("turns a blocking Stop hook into one automatic continuation in the same Run", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-stop-hook-app-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		const hookDirectory = join(workspace, ".coda");
		const logPath = join(root, "stop-events.ndjson");
		const scriptPath = join(root, "stop-hook.cjs");
		await Promise.all([mkdir(join(home, ".coda"), { recursive: true }), mkdir(hookDirectory, { recursive: true })]);
		await writeFile(
			scriptPath,
			"const fs=require('node:fs');let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>{let count=0;try{count=fs.readFileSync(process.argv[2],'utf8').trim().split('\\n').filter(Boolean).length}catch{}fs.appendFileSync(process.argv[2],value+'\\n');if(count===0)process.stdout.write(JSON.stringify({decision:'block',reason:'continue once'}));});",
		);
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} ${JSON.stringify(logPath)}`;
		await writeFile(
			join(hookDirectory, "hooks.json"),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }),
		);

		const faux = fauxProvider({ runtime: testTimeRuntime(1_100) });
		faux.setResponses([
			fauxAssistantMessage("draft", { timestamp: 1_100 }),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "continue once" });
				return fauxAssistantMessage("final", { timestamp: 1_100 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(1_100) });
		models.setProvider(faux.provider);
		let persistedSettings: UserSettings = {};
		let identity = 0;
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => persistedSettings,
				save: async (settings) => {
					persistedSettings = settings;
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			completionWorkspaceEvidence: stableCompletionWorkspaceEvidence(1_100),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: home,
				platform: process.platform,
				environment: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/sh" },
				clock: { now: () => 1_100 },
				idGenerator: { generate: (kind) => `${kind}:${++identity}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--trust-hooks",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"finish carefully",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("final\n");
		const events = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toMatchObject([
			{ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "draft" },
			{ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "final" },
		]);
	});
});
