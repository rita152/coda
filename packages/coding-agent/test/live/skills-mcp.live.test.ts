import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ApplicationOutput } from "../../src/application.ts";
import { createNodeCodingAgentApplication } from "../../src/node-application.ts";

const MODEL = "opencode-go/gpt-5.6-luna";
const SKILL_PROBE = "CODA_SKILL_PROBE_OK";
const MCP_ABSENT = "CODA_MCP_ABSENT";
const MCP_PROBE = "CODA_MCP_PROBE_OK";
const STDIO_FIXTURE = fileURLToPath(new URL("../../../mcp/test/fixtures/stdio-server.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const REPO_SKILLS = join(REPO_ROOT, ".agents", "skills");

const AUTO_SKILL_PROMPT =
	"Please run the secret handshake probe now. A Skill in this workspace exists specifically for that probe. Follow that Skill exactly.";
const MANUAL_SKILL_PROMPT =
	"$secret-handshake Follow the injected Skill exactly. Do not call the skill Tool. Do not add extra commentary.";
const MCP_ABSENT_PROMPT =
	"List every tool name available to you that starts with mcp__. If you have none, reply with exactly CODA_MCP_ABSENT and no other text. Do not call any tools.";
const MCP_MANUAL_PROMPT =
	"$echo Call the admitted MCP echo Tool with the text CODA_MCP_PROBE_OK. Then reply with exactly that echoed text and no other words.";
const ARCHITECTURE_PROMPT = "请你深入分析当前项目的系统架构";

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

describe.sequential("Live Skills and MCP mention flow", () => {
	let apiKey: string;

	beforeAll(() => {
		apiKey = process.env.OPENCODE_API_KEY ?? "";
		if (!apiKey) throw new Error("OPENCODE_API_KEY is required for the opt-in live Skills/MCP suite");
	});

	test("auto-loads a Skill whose description matches the task", async () => {
		const result = await runLive(apiKey, AUTO_SKILL_PROMPT);
		expect(result.stderr, result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.toolNames).toContain("skill");
		expect(result.text).toContain(SKILL_PROBE);
	});

	test("injects a `$` Skill mention without requiring the skill Tool", async () => {
		const result = await runLive(apiKey, MANUAL_SKILL_PROMPT);
		expect(result.stderr, result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.toolNames).not.toContain("skill");
		expect(result.text).toContain(SKILL_PROBE);
	});

	test("keeps MCP Tools out of the Run when the user does not mention them", async () => {
		const result = await runLive(apiKey, MCP_ABSENT_PROMPT);
		expect(result.stderr, result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.toolNames.some((name) => name.startsWith("mcp__"))).toBe(false);
		expect(result.text).toContain(MCP_ABSENT);
		expect(result.text).not.toContain(MCP_PROBE);
	});

	test("admits an MCP Tool only after a `$` mention", async () => {
		const result = await runLive(apiKey, MCP_MANUAL_PROMPT);
		expect(result.stderr, result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.toolNames).toContain("mcp__probe__echo");
		expect(result.text).toContain(MCP_PROBE);
	});

	test("auto-loads codebase-design for a Chinese architecture prompt", async () => {
		const result = await runArchitectureLive(apiKey);
		const detail = JSON.stringify({
			exitCode: result.exitCode,
			stderr: result.stderr,
			skillNames: result.skillNames,
			toolNames: result.toolNames,
			toolCalls: result.toolCalls,
			text: result.text.slice(0, 800),
		});
		expect(result.skillNames, detail).not.toContain("improve-codebase-architecture");
		expect(loadedCodebaseDesign(result), detail).toBe(true);
	});
});

async function runLive(apiKey: string, prompt: string): Promise<LiveResult> {
	return runPrompt(apiKey, prompt, async ({ workspace, home }) => {
		const skillDirectory = join(workspace, ".agents", "skills", "secret-handshake");
		await mkdir(skillDirectory, { recursive: true });
		await writeFile(
			join(skillDirectory, "SKILL.md"),
			[
				"---",
				"name: secret-handshake",
				"description: Use when the user asks to run the secret handshake probe. This Skill exists only to produce the probe token after it is loaded.",
				"---",
				"",
				"# Secret handshake probe",
				"",
				"When this Skill is loaded, reply with exactly:",
				"",
				SKILL_PROBE,
				"",
				"Do not call other Tools. Do not add any other words, punctuation, or markdown.",
				"",
			].join("\n"),
		);
		await mkdir(join(home, ".coda"), { recursive: true });
		await writeFile(
			join(home, ".coda", "settings.json"),
			`${JSON.stringify(
				{
					version: 1,
					mcpServers: [
						{
							id: "probe",
							protocol: "2026-07-28",
							transport: {
								kind: "stdio",
								command: process.execPath,
								args: [STDIO_FIXTURE],
								environment: { CODA_MCP_FIXTURE: "allowed" },
							},
						},
					],
				},
				undefined,
				2,
			)}\n`,
		);
	});
}

async function runArchitectureLive(apiKey: string): Promise<LiveResult> {
	return runPrompt(apiKey, ARCHITECTURE_PROMPT, async ({ workspace }) => {
		const skillsRoot = join(workspace, ".agents", "skills");
		await mkdir(join(workspace, ".agents"), { recursive: true });
		await cp(REPO_SKILLS, skillsRoot, { recursive: true });
		await mkdir(join(workspace, "src"), { recursive: true });
		await writeFile(
			join(workspace, "src", "billing.ts"),
			'export function charge(amount: number): string {\n\treturn "charged " + amount;\n}\n',
		);
		await writeFile(
			join(workspace, "src", "app.ts"),
			'import { charge } from "./billing.ts";\n\nexport function run(): string {\n\treturn charge(10);\n}\n',
		);
	});
}

async function runPrompt(
	apiKey: string,
	prompt: string,
	setup: (paths: { readonly workspace: string; readonly home: string }) => Promise<void>,
	extraArguments: readonly string[] = [],
): Promise<LiveResult> {
	const homeDirectory = await mkdtemp(join(tmpdir(), "coda-live-skills-mcp-home-"));
	const workspace = await mkdtemp(join(tmpdir(), "coda-live-skills-mcp-workspace-"));
	temporaryDirectories.push(homeDirectory, workspace);
	const canonicalWorkspace = await realpath(workspace);
	await setup({ workspace: canonicalWorkspace, home: homeDirectory });
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
	const exitCode = await application.run([
		"--print",
		"--json",
		"--json-mode",
		"semantic",
		"--ask-for-approval",
		"never",
		"--max-turns",
		"8",
		"--model",
		MODEL,
		"--api-key",
		apiKey,
		"--workspace",
		canonicalWorkspace,
		...extraArguments,
		prompt,
	]);
	const events = stdout.value
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const toolCalls = events.flatMap((event) => {
		if (event.type !== "tool_execution_start") return [];
		const invocation = event.invocation;
		if (!invocation || typeof invocation !== "object") return [];
		const tool = invocation as { toolName?: unknown; arguments?: unknown };
		if (typeof tool.toolName !== "string") return [];
		const arguments_ =
			tool.arguments && typeof tool.arguments === "object" && !Array.isArray(tool.arguments)
				? (tool.arguments as Record<string, unknown>)
				: {};
		return [{ name: tool.toolName, arguments: arguments_ }];
	});
	return {
		exitCode,
		stderr: stderr.value,
		text: finalAssistantText(events),
		toolNames: toolCalls.map(({ name }) => name),
		skillNames: toolCalls.flatMap((call) =>
			call.name === "skill" && typeof call.arguments.skill === "string" ? [call.arguments.skill] : [],
		),
		toolCalls,
	};
}

function loadedCodebaseDesign(result: LiveResult): boolean {
	if (result.skillNames.some((name) => name.includes("codebase-design"))) return true;
	return result.toolCalls.some(
		(call) =>
			call.name === "read" &&
			typeof call.arguments.path === "string" &&
			call.arguments.path.includes("codebase-design/SKILL.md"),
	);
}

function finalAssistantText(events: readonly Record<string, unknown>[]): string {
	const attempt = [...events].reverse().find((event) => event.type === "attempt_end");
	const candidate = attempt?.candidate;
	if (!candidate || typeof candidate !== "object") return JSON.stringify(events);
	const message = (candidate as { message?: { content?: unknown } }).message;
	const content = message?.content;
	if (!Array.isArray(content)) return JSON.stringify(events);
	return content
		.flatMap((block) =>
			block && typeof block === "object" && (block as { type?: unknown }).type === "text"
				? [String((block as { text?: unknown }).text ?? "")]
				: [],
		)
		.join("");
}

interface LiveResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly text: string;
	readonly toolNames: readonly string[];
	readonly skillNames: readonly string[];
	readonly toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
}
