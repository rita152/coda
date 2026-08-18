import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createCommandPermissionPolicy } from "@coda/permission";
import type { LifecycleHookHost, LifecycleHookTurnContext } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { PermissionLifecycleHookHost } from "../src/hooks/permission-host.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { stableCompletionWorkspaceEvidence } from "./completion-test-helpers.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const turn: LifecycleHookTurnContext = {
	sessionId: "session-1",
	turnId: "turn-1",
	cwd: "/workspace",
	model: "model-1",
};

function inner(pre: Awaited<ReturnType<LifecycleHookHost["preToolUse"]>>): LifecycleHookHost {
	return {
		sessionStart: async () => ({ continue: true }),
		sessionEnd: async () => undefined,
		userPromptSubmit: async () => ({ continue: true }),
		preToolUse: async () => pre,
		postToolUse: async () => ({ continue: true }),
		preCompact: async () => ({ continue: true }),
		postCompact: async () => ({ continue: true }),
		stop: async () => ({ continue: true }),
		subagentStart: async () => ({ continue: true }),
		subagentStop: async () => ({ continue: true }),
		takeAdditionalContext: () => [],
		close: async () => undefined,
	};
}

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

describe("PermissionLifecycleHookHost", () => {
	it("asks before Bash and can deny or remember an allow", async () => {
		const policy = createCommandPermissionPolicy({ approvalPolicy: "untrusted" });
		const denied = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy,
			ask: async () => ({ action: "deny", reason: "not this command" }),
		});
		await expect(
			denied.preToolUse({
				...turn,
				toolName: "bash",
				toolUseId: "1",
				toolInput: { command: "rm -rf /" },
			}),
		).resolves.toEqual({ continue: false, reason: "not this command" });

		const remembered = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy,
			ask: async () => ({ action: "allow", remember: "session" }),
		});
		const request = {
			...turn,
			toolName: "bash",
			toolUseId: "2",
			toolInput: { command: "npm test" },
		};
		await expect(remembered.preToolUse(request)).resolves.toEqual({ continue: true });
		await expect(remembered.preToolUse(request)).resolves.toEqual({ continue: true });
	});

	it("denies an ask when no interactive ask port is available", async () => {
		const host = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy: createCommandPermissionPolicy({ approvalPolicy: "untrusted" }),
		});
		await expect(
			host.preToolUse({
				...turn,
				toolName: "bash",
				toolUseId: "headless",
				toolInput: { command: "npm test" },
			}),
		).resolves.toEqual({
			continue: false,
			reason: "Command Permission requires an interactive Session",
		});
	});

	it("asks for Codex require_escalated sandbox_permissions under on-request", async () => {
		const host = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy: createCommandPermissionPolicy({
				approvalPolicy: "on-request",
				filesystemAccess: "restricted",
			}),
			ask: async () => ({ action: "deny", reason: "stay confined" }),
		});
		await expect(
			host.preToolUse({
				...turn,
				toolName: "bash",
				toolUseId: "escalate",
				toolInput: { command: "curl example.test", sandbox_permissions: "require_escalated" },
			}),
		).resolves.toEqual({ continue: false, reason: "stay confined" });
	});

	it("denies require_escalated when approval is never", async () => {
		const host = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy: createCommandPermissionPolicy({
				approvalPolicy: "never",
				filesystemAccess: "restricted",
			}),
		});
		await expect(
			host.preToolUse({
				...turn,
				toolName: "bash",
				toolUseId: "print-escalate",
				toolInput: { command: "curl example.test", sandbox_permissions: "require_escalated" },
			}),
		).resolves.toEqual({
			continue: false,
			reason:
				"approval policy is Never; reject command — you should not ask for escalated permissions if the approval policy is Never",
		});
	});

	it("rejects with_additional_permissions when additional_permissions are missing", async () => {
		const host = new PermissionLifecycleHookHost({
			inner: inner({ continue: true }),
			policy: createCommandPermissionPolicy({
				approvalPolicy: "on-request",
				filesystemAccess: "restricted",
			}),
			ask: async () => ({ action: "allow" }),
		});
		await expect(
			host.preToolUse({
				...turn,
				toolName: "bash",
				toolUseId: "widen",
				toolInput: { command: "curl example.test", sandbox_permissions: "with_additional_permissions" },
			}),
		).resolves.toEqual({
			continue: false,
			reason:
				"missing `additional_permissions`; provide at least one of `network` or `file_system` when using `with_additional_permissions`",
		});
	});

	it("resolves a hook permissionAsk through the ask port", async () => {
		const host = new PermissionLifecycleHookHost({
			inner: inner({ continue: true, permissionAsk: true, reason: "hook asked" }),
			policy: createCommandPermissionPolicy({ approvalPolicy: "untrusted" }),
			ask: async (request) => {
				expect(request.prompt).toBe("hook asked");
				return { action: "allow" };
			},
		});
		await expect(
			host.preToolUse({
				...turn,
				toolName: "Bash",
				toolUseId: "3",
				toolInput: { command: "pwd" },
			}),
		).resolves.toEqual({ continue: true, reason: "hook asked" });
	});
});

describe("Command Permission application integration", () => {
	it("denies Bash when the ask port rejects the Tool Invocation", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-permission-app-"));
		temporaryDirectories.push(root);
		const faux = fauxProvider({ runtime: testTimeRuntime(1_000) });
		let toolResult: unknown;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf secret" }, { id: "denied-bash" }), {
				stopReason: "toolUse",
				timestamp: 1_000,
			}),
			(context) => {
				toolResult = context.messages.at(-1);
				return fauxAssistantMessage("denied", { timestamp: 1_000 });
			},
			fauxAssistantMessage("denied", { timestamp: 1_000 }),
		]);
		const models = createModels({ runtime: testTimeRuntime(1_000) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let identity = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			commandPermissionAsk: async () => ({ action: "deny", reason: "blocked in test" }),
			completionWorkspaceEvidence: stableCompletionWorkspaceEvidence(1_000),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: root,
				homeDirectory: root,
				platform: process.platform,
				environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh" },
				clock: { now: () => 1_000 },
				idGenerator: { generate: (kind) => `${kind}:${++identity}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--ask-for-approval",
			"untrusted",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"run bash",
		]);
		expect(toolResult).toMatchObject({
			role: "toolResult",
			toolCallId: "denied-bash",
			content: [{ type: "text", text: "blocked in test" }],
		});
		expect(exitCode, stderr.value).toBe(1);
		expect(stderr.value).toContain("completion partial");
	});
});

describe("InteractiveCommandPermissionHandler", () => {
	it("queues a second child ask instead of denying it", async () => {
		const { Component, createSystemScheduler, Tui, VirtualTerminal } = await import("@coda/tui");
		const { InteractiveCommandPermissionHandler } = await import("../src/ui/command-permission.ts");
		class Root extends Component {
			render(): string[] {
				return ["chat"];
			}
		}
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const tui = new Tui({
			terminal,
			root: new Root(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const handler = new InteractiveCommandPermissionHandler();
		handler.bind(tui, terminal);
		await tui.start();
		const first = handler.request({
			toolName: "bash",
			toolInput: { command: "npm test" },
			sessionId: "session:child-a",
			workspace: "/workspace",
			prompt: "Allow child A?",
		});
		const second = handler.request({
			toolName: "bash",
			toolInput: { command: "npm lint" },
			sessionId: "session:child-b",
			workspace: "/workspace",
			prompt: "Allow child B?",
		});
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(first).resolves.toEqual({ action: "allow" });
		await terminal.emit({
			type: "key",
			key: "escape",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(second).resolves.toEqual({
			action: "deny",
			reason: "User denied this Tool Invocation",
		});
		handler.unbind();
		await tui.stop();
	});
});
