import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LifecycleHookEventName } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { inspectHookConfiguration, trustAllHooks } from "../src/hooks/config.ts";
import { CommandLifecycleHookHost } from "../src/hooks/manager.ts";
import type { ConfiguredCommandHook, HookConfigurationSnapshot } from "../src/hooks/types.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../src/host/process-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function result(input: Partial<ProcessRunResult> = {}): ProcessRunResult {
	return {
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
		...input,
	};
}

function handler(
	event: LifecycleHookEventName,
	command: string,
	options: Partial<ConfiguredCommandHook> = {},
): ConfiguredCommandHook {
	return Object.freeze({
		id: `${event}:${command}`,
		event,
		source: "workspace",
		sourcePath: "/workspace/.coda/hooks.json",
		command,
		timeoutMs: 1_000,
		async: false,
		additionalContextLimit: 2_500,
		trustKey: `${event}:${command}`,
		sha256: "a".repeat(64),
		trust: "trusted",
		...options,
	});
}

function configuration(handlers: readonly ConfiguredCommandHook[]): HookConfigurationSnapshot {
	return Object.freeze({ revision: "revision", paths: [], handlers, diagnostics: [] });
}

function host(
	handlers: readonly ConfiguredCommandHook[],
	run: ProcessRunner["run"],
	diagnostic?: (diagnostic: { readonly code: string; readonly message: string }) => void,
): CommandLifecycleHookHost {
	return new CommandLifecycleHookHost({
		configuration: configuration(handlers),
		processRunner: { run },
		shellExecutable: "/bin/sh",
		platform: "darwin",
		environment: {},
		...(diagnostic ? { diagnostic } : {}),
	});
}

const turn = {
	sessionId: "session-1",
	turnId: "turn-1",
	transcriptPath: "/transcript.jsonl",
	cwd: "/workspace",
	model: "model-1",
};

describe("CommandLifecycleHookHost", () => {
	it("uses Codex matcher aliases and blocking exit-code semantics", async () => {
		const requests: ProcessRunRequest[] = [];
		const hooks = host(
			[
				handler("PreToolUse", "deny", { matcher: "Bash" }),
				handler("PreToolUse", "wrong", { matcher: "Edit" }),
				handler("Stop", "continue"),
			],
			async (request) => {
				requests.push(request);
				const command = request.args.at(-1);
				if (command === "deny") return result({ exitCode: 2, stderr: "blocked by policy" });
				if (command === "continue") return result({ exitCode: 2, stderr: "check the result once more" });
				return result();
			},
		);
		await hooks.sessionStart({ ...turn, source: "startup" });

		const pre = await hooks.preToolUse({
			...turn,
			toolName: "Bash",
			matcherAliases: ["bash"],
			toolUseId: "tool-1",
			toolInput: { command: "pwd" },
		});
		const stop = await hooks.stop({ ...turn, stopHookActive: false, lastAssistantMessage: "done" });

		expect(pre).toMatchObject({ continue: false, reason: "blocked by policy" });
		expect(stop).toEqual({ continue: true, continuation: "check the result once more" });
		expect(requests.map((request) => request.args.at(-1))).toEqual(["deny", "continue"]);
		expect(JSON.parse(String(requests[0]?.stdin))).toMatchObject({
			hook_event_name: "PreToolUse",
			turn_id: "turn-1",
			tool_name: "Bash",
			tool_input: { command: "pwd" },
			permission_mode: "bypassPermissions",
		});
	});

	it("runs matching handlers concurrently and applies the last completed updatedInput", async () => {
		const hooks = host([handler("PreToolUse", "slow"), handler("PreToolUse", "fast")], async (request) => {
			const command = request.args.at(-1);
			await new Promise((resolve) => setTimeout(resolve, command === "slow" ? 20 : 1));
			return result({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
						updatedInput: { command },
					},
				}),
			});
		});
		await hooks.sessionStart({ ...turn, source: "startup" });

		const outcome = await hooks.preToolUse({
			...turn,
			toolName: "Bash",
			toolUseId: "tool-2",
			toolInput: { command: "original" },
		});

		expect(outcome).toMatchObject({ continue: true, updatedInput: { command: "slow" } });
	});

	it("queues SessionStart and UserPromptSubmit context exactly once", async () => {
		const hooks = host(
			[handler("SessionStart", "session"), handler("UserPromptSubmit", "prompt")],
			async (request) =>
				request.args.at(-1) === "session"
					? result({ stdout: "session context" })
					: result({
							stdout: JSON.stringify({
								hookSpecificOutput: {
									hookEventName: "UserPromptSubmit",
									additionalContext: "prompt context",
								},
							}),
						}),
		);

		await hooks.sessionStart({ ...turn, source: "startup" });
		await hooks.userPromptSubmit({ ...turn, prompt: "hello" });

		expect(hooks.takeAdditionalContext(turn.sessionId)).toEqual(["session context", "prompt context"]);
		expect(hooks.takeAdditionalContext(turn.sessionId)).toEqual([]);
	});

	it("stops one turn for SessionStart continue:false and preserves the transcript across compact starts", async () => {
		const inputs: Record<string, unknown>[] = [];
		const hooks = host([handler("SessionStart", "start"), handler("UserPromptSubmit", "prompt")], async (request) => {
			const input = JSON.parse(String(request.stdin)) as Record<string, unknown>;
			inputs.push(input);
			return input.hook_event_name === "SessionStart" && input.source === "startup"
				? result({
						stdout: JSON.stringify({
							continue: false,
							stopReason: "pause once",
							hookSpecificOutput: {
								hookEventName: "SessionStart",
								additionalContext: "remember later",
							},
						}),
					})
				: result();
		});

		expect(await hooks.sessionStart({ ...turn, source: "startup" })).toEqual({
			continue: false,
			reason: "pause once",
		});
		expect(hooks.takeAdditionalContext(turn.sessionId)).toEqual(["remember later"]);
		expect(await hooks.userPromptSubmit({ ...turn, prompt: "first" })).toEqual({
			continue: false,
			reason: "pause once",
		});
		expect(await hooks.userPromptSubmit({ ...turn, prompt: "second" })).toMatchObject({ continue: true });
		await hooks.sessionStart({
			sessionId: turn.sessionId,
			cwd: turn.cwd,
			model: turn.model,
			source: "compact",
		});

		expect(inputs.filter(({ hook_event_name }) => hook_event_name === "UserPromptSubmit")).toHaveLength(1);
		expect(inputs.at(-1)).toMatchObject({
			hook_event_name: "SessionStart",
			source: "compact",
			transcript_path: turn.transcriptPath,
		});
	});

	it("ignores Stop and UserPromptSubmit matchers and fails open for incomplete block decisions", async () => {
		const diagnostics: string[] = [];
		const hooks = host(
			[
				handler("UserPromptSubmit", "prompt", { matcher: "Never" }),
				handler("PreToolUse", "ask"),
				handler("Stop", "stop", { matcher: "Never" }),
			],
			async (request) => {
				switch (request.args.at(-1)) {
					case "ask":
						return result({
							stdout: JSON.stringify({
								hookSpecificOutput: {
									hookEventName: "PreToolUse",
									permissionDecision: "ask",
								},
							}),
						});
					default:
						return result({ stdout: JSON.stringify({ decision: "block" }) });
				}
			},
			({ message }) => diagnostics.push(message),
		);
		await hooks.sessionStart({ ...turn, source: "startup" });

		expect(await hooks.userPromptSubmit({ ...turn, prompt: "hello" })).toMatchObject({ continue: true });
		expect(
			await hooks.preToolUse({
				...turn,
				toolName: "Bash",
				toolUseId: "tool-ask",
				toolInput: { command: "pwd" },
			}),
		).toMatchObject({ continue: true, permissionAsk: true });
		expect(await hooks.stop({ ...turn, stopHookActive: false })).toEqual({ continue: true });
		expect(diagnostics).toEqual([
			"UserPromptSubmit hook returned decision:block without a non-empty reason",
			"Stop hook returned decision:block without a non-empty reason",
		]);
	});

	it("spills oversized additional context and exposes a bounded preview", async () => {
		const complete = "complete hook context ".repeat(20);
		const hooks = host([handler("UserPromptSubmit", "context", { additionalContextLimit: 1 })], async () =>
			result({ stdout: complete }),
		);
		await hooks.sessionStart({ ...turn, source: "startup" });

		await hooks.userPromptSubmit({ ...turn, prompt: "hello" });
		const [preview] = hooks.takeAdditionalContext(turn.sessionId);
		const outputPath = /Full hook output saved to: (.+)/u.exec(preview ?? "")?.[1];
		expect(outputPath).toBeDefined();
		temporaryDirectories.push(dirname(outputPath!));
		expect(await readFile(outputPath!, "utf8")).toBe(complete.trim());
		expect(preview).not.toContain(complete.trim());
	});

	it("dispatches SubagentStart with parent session_id and executionMode matcher", async () => {
		const requests: ProcessRunRequest[] = [];
		const hooks = host(
			[
				handler("SubagentStart", "start-write", { matcher: "write" }),
				handler("SubagentStart", "start-read", { matcher: "read_only" }),
			],
			async (request) => {
				requests.push(request);
				return result({
					stdout: JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "SubagentStart",
							additionalContext: "child guidance",
						},
					}),
				});
			},
		);
		await hooks.subagentStart({
			sessionId: "session-parent",
			childSessionId: "session-child",
			cwd: "/workspace",
			model: "model-1",
			agentId: "alpha",
			agentType: "write",
		});
		expect(requests).toHaveLength(1);
		expect(JSON.parse(String(requests[0]?.stdin))).toMatchObject({
			session_id: "session-parent",
			hook_event_name: "SubagentStart",
			agent_id: "alpha",
			agent_type: "write",
			model: "model-1",
		});
		expect(hooks.takeAdditionalContext("session-child")).toEqual(["child guidance"]);
	});

	it("ignores SubagentStart continue:false and matches SubagentStop to Stop algebra", async () => {
		const startHooks = host([handler("SubagentStart", "start")], async () =>
			result({ stdout: JSON.stringify({ continue: false, stopReason: "should not block start" }) }),
		);
		await expect(
			startHooks.subagentStart({
				sessionId: "session-parent",
				childSessionId: "session-child",
				cwd: "/workspace",
				model: "model-1",
				agentId: "alpha",
				agentType: "write",
			}),
		).resolves.toEqual({ continue: true, additionalContext: [] });

		const stopRequests: ProcessRunRequest[] = [];
		const stopHooks = host([handler("SubagentStop", "stop", { matcher: "write" })], async (request) => {
			stopRequests.push(request);
			return result({
				stdout: JSON.stringify({ decision: "block", reason: "look again" }),
			});
		});
		await expect(
			stopHooks.subagentStop({
				sessionId: "session-parent",
				childSessionId: "session-child",
				cwd: "/workspace",
				model: "model-1",
				agentId: "alpha",
				agentType: "write",
				stopHookActive: false,
				lastAssistantMessage: "alpha done",
				agentTranscriptPath: "/child.jsonl",
			}),
		).resolves.toEqual({ continue: true, continuation: "look again" });
		expect(JSON.parse(String(stopRequests[0]?.stdin))).toMatchObject({
			session_id: "session-parent",
			hook_event_name: "SubagentStop",
			agent_id: "alpha",
			agent_type: "write",
			agent_transcript_path: "/child.jsonl",
			stop_hook_active: false,
			last_assistant_message: "alpha done",
		});
	});

	it("queues background handlers after eight active commands instead of dropping them", async () => {
		let active = 0;
		let maximumActive = 0;
		let calls = 0;
		const releases: Array<() => void> = [];
		const hooks = host(
			Array.from({ length: 9 }, (_, index) => handler("PostToolUse", `async-${index}`, { async: true })),
			() => {
				calls += 1;
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				return new Promise((resolve) => {
					releases.push(() => {
						active -= 1;
						resolve(result());
					});
				});
			},
		);
		await hooks.sessionStart({ ...turn, source: "startup" });

		await hooks.postToolUse({
			...turn,
			toolName: "Bash",
			toolUseId: "tool-async",
			toolInput: { command: "pwd" },
			toolResponse: { content: "ok" },
		});
		expect(calls).toBe(8);
		expect(maximumActive).toBe(8);
		releases.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(9);
		for (const release of releases.splice(0)) release();
		await hooks.close();
	});
});

describe("Hook configuration discovery", () => {
	it("merges User and Workspace JSON, defers unsupported runtime events, and binds trust to exact hashes", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-hooks-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		await Promise.all([
			mkdir(join(home, ".coda"), { recursive: true }),
			mkdir(join(workspace, ".coda"), { recursive: true }),
		]);
		await writeFile(
			join(home, ".coda", "hooks.json"),
			JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-start" }] }] } }),
		);
		await writeFile(
			join(workspace, ".coda", "hooks.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "Bash|Edit", hooks: [{ type: "command", command: "guard" }] }],
					Stop: [
						{
							matcher: "(",
							hooks: [{ type: "command", command: "stop", additionalContextLimit: 42 }],
						},
					],
					PermissionRequest: [{ hooks: [{ type: "command", command: "deferred" }] }],
					SubagentStart: [{ hooks: [{ type: "command", command: "subagent-start" }] }],
					SubagentStop: [{ hooks: [{ type: "command", command: "subagent-stop" }] }],
					SubagentEnd: [{ hooks: [{ type: "command", command: "dead-alias" }] }],
				},
			}),
		);
		const fileSystem = createNodeFileSystem();
		const discovered = await inspectHookConfiguration({ workspace, homeDirectory: home, fileSystem, trust: [] });

		expect(discovered.handlers.map(({ event, command, trust }) => ({ event, command, trust }))).toEqual([
			{ event: "SessionStart", command: "user-start", trust: "untrusted" },
			{ event: "PreToolUse", command: "guard", trust: "untrusted" },
			{ event: "Stop", command: "stop", trust: "untrusted" },
			{ event: "SubagentStart", command: "subagent-start", trust: "untrusted" },
			{ event: "SubagentStop", command: "subagent-stop", trust: "untrusted" },
		]);
		expect(discovered.diagnostics.filter(({ code }) => code === "hooks.event-deferred")).toHaveLength(1);
		expect(discovered.diagnostics).toContainEqual(
			expect.objectContaining({ code: "hooks.unknown-event", message: expect.stringContaining("SubagentEnd") }),
		);
		expect(discovered.diagnostics).toContainEqual(
			expect.objectContaining({ code: "hooks.additional-context-limit-ignored" }),
		);

		const settings = trustAllHooks({}, discovered);
		const trusted = await inspectHookConfiguration({
			workspace,
			homeDirectory: home,
			fileSystem,
			trust: settings.hookTrust ?? [],
		});
		expect(trusted.handlers.every(({ trust }) => trust === "trusted")).toBe(true);
	});

	it("accepts a metadata-only hooks file", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-hooks-metadata-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		await Promise.all([
			mkdir(join(home, ".coda"), { recursive: true }),
			mkdir(join(workspace, ".coda"), { recursive: true }),
		]);
		await writeFile(join(home, ".coda", "hooks.json"), JSON.stringify({ description: "No handlers yet" }));

		const discovered = await inspectHookConfiguration({
			workspace,
			homeDirectory: home,
			fileSystem: createNodeFileSystem(),
			trust: [],
		});

		expect(discovered.handlers).toEqual([]);
		expect(discovered.diagnostics).toEqual([]);
	});
});
