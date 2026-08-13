import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { ScheduledTask, Scheduler } from "@coda/tui";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication, type SettingsStore } from "../src/application.ts";
import type { CompletionWorkspaceEvidenceProvider, WorkspaceEvidenceSnapshot } from "../src/completion/types.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const fixtures: string[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("Coding Agent completion integration", () => {
	it("emits a versioned verified disposition for a read-only Done candidate without running tests", async () => {
		const fixture = await createFixture();
		const faux = fauxProvider({ runtime: testTimeRuntime(1_000) });
		faux.setResponses([fauxAssistantMessage("Done", { timestamp: 1_000 })]);
		const harness = createHarness(fixture, faux, workspaceEvidence([snapshot("same", false, [])]));

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"diagnose the repository",
		]);
		const events = jsonLines(harness.stdout.value);

		expect(exitCode).toBe(0);
		expect(faux.state.callCount).toBe(1);
		expect(events.at(-1)).toMatchObject({
			schemaVersion: 1,
			type: "completion_disposition",
			disposition: "verified",
			modelTermination: "completed",
			evidenceCompleteness: "complete",
			verification: { result: "not_run", hiddenVerifier: "not_evaluated" },
		});
		expect(harness.stderr.value).toBe("");
	});

	it("injects exactly one repair after mutation, then returns unverified while preserving patch and evidence", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspace, "value.ts"), "before\n");
		const faux = fauxProvider({ runtime: testTimeRuntime(1_100) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-value" }),
				{ stopReason: "toolUse", timestamp: 1_100 },
			),
			fauxAssistantMessage("Done", { timestamp: 1_100 }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("run a focused verification after the latest mutation");
				return fauxAssistantMessage("No verification was run.", { timestamp: 1_100 });
			},
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
			]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change value.ts",
		]);
		const events = jsonLines(harness.stdout.value);

		expect(exitCode).toBe(1);
		expect(faux.state.callCount).toBe(3);
		expect(await readFile(join(fixture.workspace, "value.ts"), "utf8")).toBe("after\n");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run_end",
				outcome: "success",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run_evidence",
				paths: expect.objectContaining({ changed: ["value.ts"] }),
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "completion_disposition",
			disposition: "unverified",
			modelTermination: "completed",
			verification: { result: "not_run" },
			repair: { attempts: 1, maxAttempts: 1, exhausted: true },
			workspace: { changedPaths: ["value.ts"] },
		});
		expect(harness.stderr.value).toBe("");
	});

	it("accepts a successful local verification after the latest mutation without extra model calls", async () => {
		const fixture = await createFixture();
		await Promise.all([
			writeFile(join(fixture.workspace, "value.ts"), "before\n"),
			writeFile(
				join(fixture.workspace, "package.json"),
				JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
			),
		]);
		const faux = fauxProvider({ runtime: testTimeRuntime(1_200) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-value" }),
				{ stopReason: "toolUse", timestamp: 1_200 },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "verify-value" }), {
				stopReason: "toolUse",
				timestamp: 1_200,
			}),
			fauxAssistantMessage("Implemented and locally verified.", { timestamp: 1_200 }),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([snapshot("before", false, []), snapshot("after", true, ["value.ts"])]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change and verify value.ts",
		]);
		const disposition = jsonLines(harness.stdout.value).at(-1);

		expect(exitCode).toBe(0);
		expect(faux.state.callCount).toBe(3);
		expect(disposition).toMatchObject({
			type: "completion_disposition",
			disposition: "verified",
			verification: {
				result: "passed",
				scope: "local",
				hiddenVerifier: "not_evaluated",
				afterLatestMutation: true,
			},
		});
	});

	it("keeps the completion gate active when RunControl requests wrap-up after a mutation", async () => {
		const fixture = await createFixture();
		await Promise.all([
			writeFile(join(fixture.workspace, "value.ts"), "before\n"),
			writeFile(
				join(fixture.workspace, "package.json"),
				JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
			),
		]);
		const time = new ControlledTime(1_225);
		const faux = fauxProvider({ runtime: testTimeRuntime(1_225) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-value" }),
				{ stopReason: "toolUse", timestamp: 1_225 },
			),
			async () => {
				await time.runNext();
				return fauxAssistantMessage("Wrapped up at the work deadline.", { timestamp: time.now() });
			},
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("RunControl requested finalization");
				expect(messages).toContain("run a focused verification after the latest mutation");
				return fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "verify-value" }), {
					stopReason: "toolUse",
					timestamp: time.now(),
				});
			},
			fauxAssistantMessage("Wrapped up after post-mutation verification.", { timestamp: 1_325 }),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
			]),
			{ scheduler: time, now: () => time.now() },
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--json-mode",
			"semantic",
			"--run-control-work-ms",
			"100",
			"--run-control-grace-ms",
			"500",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change and verify value.ts before wrapping up",
		]);
		const events = jsonLines(harness.stdout.value);

		expect(exitCode).toBe(0);
		expect(faux.state.callCount).toBe(4);
		expect(events.find((event) => event.type === "run_end")).toMatchObject({
			schemaVersion: 3,
			outcome: "success",
			runControl: { phase: "terminal", reason: "run_ended", trigger: "work_deadline" },
		});
		expect(events.at(-1)).toMatchObject({
			type: "completion_disposition",
			disposition: "verified",
			verification: { result: "passed", afterLatestMutation: true },
			repair: { attempts: 1, maxAttempts: 1, exhausted: false },
		});
		expect(time.pending).toBe(0);
	});

	it("invalidates fake-model verification evidence when a later mutation occurs", async () => {
		const fixture = await createFixture();
		await Promise.all([
			writeFile(join(fixture.workspace, "value.ts"), "before\n"),
			writeFile(
				join(fixture.workspace, "package.json"),
				JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
			),
		]);
		const faux = fauxProvider({ runtime: testTimeRuntime(1_250) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "verify-old" }), {
				stopReason: "toolUse",
				timestamp: 1_250,
			}),
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-later" }),
				{ stopReason: "toolUse", timestamp: 1_250 },
			),
			fauxAssistantMessage("Done after the later edit", { timestamp: 1_250 }),
			fauxAssistantMessage("Still no post-edit verification", { timestamp: 1_250 }),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
			]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"verify, then change value.ts",
		]);
		const disposition = jsonLines(harness.stdout.value).at(-1);

		expect(exitCode).toBe(1);
		expect(faux.state.callCount).toBe(4);
		expect(disposition).toMatchObject({
			type: "completion_disposition",
			disposition: "unverified",
			verification: { result: "not_run", afterLatestMutation: false },
			repair: { attempts: 1, exhausted: true },
		});
	});

	it("keeps a failed verification open as partial and preserves the successful patch", async () => {
		const fixture = await createFixture();
		await Promise.all([
			writeFile(join(fixture.workspace, "value.ts"), "before\n"),
			writeFile(
				join(fixture.workspace, "package.json"),
				JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(7)"' } }),
			),
		]);
		const faux = fauxProvider({ runtime: testTimeRuntime(1_275) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-value" }),
				{ stopReason: "toolUse", timestamp: 1_275 },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "verify-failed" }), {
				stopReason: "toolUse",
				timestamp: 1_275,
			}),
			fauxAssistantMessage("The local test is still failing.", { timestamp: 1_275 }),
			fauxAssistantMessage("Blocked on the same local test failure.", { timestamp: 1_275 }),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
			]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change and verify value.ts",
		]);
		const events = jsonLines(harness.stdout.value);

		expect(exitCode).toBe(1);
		expect(faux.state.callCount).toBe(4);
		expect(await readFile(join(fixture.workspace, "value.ts"), "utf8")).toBe("after\n");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run_evidence",
				paths: expect.objectContaining({ changed: ["value.ts"] }),
				commands: [expect.objectContaining({ command: "npm test", status: "error", exitCode: 7 })],
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "completion_disposition",
			disposition: "partial",
			verification: { result: "failed", afterLatestMutation: true },
			evidence: { openFailureCount: 1 },
			repair: { attempts: 1, exhausted: true },
			workspace: { changedPaths: ["value.ts"] },
		});
	});

	it("re-captures the final patch when a repair mutates and then the model fails", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspace, "value.ts"), "before\n");
		const faux = fauxProvider({ runtime: testTimeRuntime(1_295) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-first" }),
				{ stopReason: "toolUse", timestamp: 1_295 },
			),
			fauxAssistantMessage("Done before verification", { timestamp: 1_295 }),
			fauxAssistantMessage(
				fauxToolCall(
					"write",
					{ path: "second.ts", content: "export const second = true;\n" },
					{ id: "write-repair" },
				),
				{ stopReason: "toolUse", timestamp: 1_295 },
			),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "scripted model failure",
				timestamp: 1_295,
			}),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("first", true, ["value.ts"]),
				snapshot("final", true, ["second.ts", "value.ts"]),
			]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change value.ts",
		]);
		const events = jsonLines(harness.stdout.value);

		expect(exitCode).toBe(1);
		expect(await readFile(join(fixture.workspace, "value.ts"), "utf8")).toBe("after\n");
		expect(await readFile(join(fixture.workspace, "second.ts"), "utf8")).toBe("export const second = true;\n");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run_evidence",
				outcome: "error",
				paths: expect.objectContaining({ changed: expect.arrayContaining(["second.ts", "value.ts"]) }),
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "completion_disposition",
			disposition: "partial",
			modelTermination: "failed",
			workspace: { changedPaths: ["second.ts", "value.ts"] },
			repair: { attempts: 1, maxAttempts: 1 },
		});
		expect(harness.stderr.value).toContain("scripted model failure");
	});

	it("keeps final text on stdout but exits nonzero for an unverified text-mode patch", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspace, "value.ts"), "before\n");
		const faux = fauxProvider({ runtime: testTimeRuntime(1_300) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "value.ts", oldText: "before", newText: "after" }, { id: "edit-value" }),
				{ stopReason: "toolUse", timestamp: 1_300 },
			),
			fauxAssistantMessage("First completion", { timestamp: 1_300 }),
			fauxAssistantMessage("Final unverified completion", { timestamp: 1_300 }),
		]);
		const harness = createHarness(
			fixture,
			faux,
			workspaceEvidence([
				snapshot("before", false, []),
				snapshot("after", true, ["value.ts"]),
				snapshot("after", true, ["value.ts"]),
			]),
		);

		const exitCode = await harness.application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"change value.ts",
		]);

		expect(exitCode).toBe(1);
		expect(harness.stdout.value).toBe("Final unverified completion\n");
		expect(harness.stderr.value).toContain("coda: completion unverified");
		expect(await readFile(join(fixture.workspace, "value.ts"), "utf8")).toBe("after\n");
	});
});

interface Fixture {
	readonly root: string;
	readonly workspace: string;
	readonly home: string;
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "coda-completion-"));
	fixtures.push(root);
	const workspace = join(root, "workspace");
	const home = join(root, "home");
	await Promise.all([mkdir(workspace), mkdir(home)]);
	return { root, workspace, home };
}

function createHarness(
	fixture: Fixture,
	faux: ReturnType<typeof fauxProvider>,
	completionWorkspaceEvidence: CompletionWorkspaceEvidenceProvider,
	options: {
		readonly settings?: SettingsStore;
		readonly scheduler?: Scheduler;
		readonly now?: () => number;
	} = {},
) {
	const models = createModels({ runtime: testTimeRuntime(1_000) });
	models.setProvider(faux.provider);
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let id = 0;
	const settings: SettingsStore = options.settings ?? {
		load: async () => ({}),
		save: async () => undefined,
	};
	return {
		stdout,
		stderr,
		application: createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			completionWorkspaceEvidence,
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: fixture.workspace,
				homeDirectory: fixture.home,
				platform: "darwin",
				environment: { PATH: process.env.PATH, SHELL: "/bin/sh", TMPDIR: tmpdir() },
				clock: { now: options.now ?? (() => 1_000) },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				...(options.scheduler ? { scheduler: options.scheduler } : {}),
			},
		}),
	};
}

function workspaceEvidence(snapshots: readonly WorkspaceEvidenceSnapshot[]): CompletionWorkspaceEvidenceProvider {
	let index = 0;
	return {
		capture: async () => structuredClone(snapshots[Math.min(index++, snapshots.length - 1)]!),
	};
}

function snapshot(fingerprint: string, dirty: boolean, changedPaths: readonly string[]): WorkspaceEvidenceSnapshot {
	return {
		schemaVersion: 1,
		status: "complete",
		capturedAt: 1_000,
		dirty,
		changedPaths,
		omittedChangedPaths: 0,
		statusSha256: `${fingerprint}:status`,
		diffSha256: `${fingerprint}:diff`,
		untrackedSha256: `${fingerprint}:untracked`,
		fingerprint,
		diagnostics: [],
	};
}

function jsonLines(output: string): Record<string, unknown>[] {
	return output
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

interface ControlledTask extends ScheduledTask {
	readonly dueAt: number;
	readonly run: () => void | Promise<void>;
	cancelled: boolean;
	ran: boolean;
}

class ControlledTime implements Scheduler {
	#now: number;
	readonly #tasks: ControlledTask[] = [];

	constructor(now: number) {
		this.#now = now;
	}

	now(): number {
		return this.#now;
	}

	schedule(delayMs: number, run: () => void | Promise<void>): ScheduledTask {
		const task: ControlledTask = {
			dueAt: this.#now + delayMs,
			run,
			cancelled: false,
			ran: false,
			cancel() {
				this.cancelled = true;
			},
		};
		this.#tasks.push(task);
		return task;
	}

	get pending(): number {
		return this.#tasks.filter((task) => !task.cancelled && !task.ran).length;
	}

	async runNext(): Promise<void> {
		const task = this.#tasks
			.filter((candidate) => !candidate.cancelled && !candidate.ran)
			.sort((left, right) => left.dueAt - right.dueAt)[0];
		if (!task) throw new Error("No scheduled task is pending");
		this.#now = task.dueAt;
		task.ran = true;
		await task.run();
	}
}
