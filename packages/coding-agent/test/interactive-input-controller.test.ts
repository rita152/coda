import { Agent, type IdGenerator, type IdKind, type QueueItemId } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveInputController } from "../src/interactive/input-controller.ts";
import type { Session } from "../src/session/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("InteractiveInputController", () => {
	it("accepts a prompt before its Agent operation completes and durably enqueues Follow-ups", async () => {
		let releaseModel!: () => void;
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: 100 })]);
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator,
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async ({ context, signal }) => {
				await modelGate;
				return faux.streamSimple(faux.getModel(), context, { signal, runtime });
			},
			autoDrainFollowUps: false,
		});
		const record = vi.fn(async (_change: Parameters<Session["record"]>[0]) => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: testSession(record),
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
			allocateId: sequenceIds(),
		});

		await expect(controller.submit("start", [])).resolves.toMatchObject({ kind: "prompt", text: "start" });
		expect(agent.state.status).toBe("running");
		const followUp = await controller.followUp("later", []);
		const followUpId = typeof followUp === "string" ? followUp : followUp.queueItemId;
		expect(record).toHaveBeenCalledWith({
			type: "follow_up_enqueued",
			item: { id: followUpId, content: "later" },
		});
		expect(record.mock.calls.map(([change]) => change.type)).toEqual([
			"composer_submission_recorded",
			"composer_submission_recorded",
			"follow_up_enqueued",
		]);

		releaseModel();
		await controller.waitForIdle();
	});

	it("appends a new submission after restored Follow-ups and explicitly resumes the FIFO queue", async () => {
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			fauxAssistantMessage("restored done", { timestamp: 100 }),
			fauxAssistantMessage("new done", { timestamp: 101 }),
		]);
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator,
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			seed: {
				version: 1,
				messages: [],
				pendingFollowUps: [{ id: "queue:restored" as QueueItemId, content: "restored" }],
			},
			autoDrainFollowUps: false,
		});
		const record = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: testSession(record),
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
			allocateId: sequenceIds(),
		});

		await controller.submit("new", []);
		await controller.waitForIdle();

		expect(record).toHaveBeenCalledWith({
			type: "follow_up_enqueued",
			item: expect.objectContaining({ content: "new" }),
		});
		expect(
			agent.state.messages.filter(({ message }) => message.role === "user").map(({ message }) => message.content),
		).toEqual(["restored", "new"]);
		expect(agent.state.pendingFollowUps).toEqual([]);
	});

	it("appends to and resumes a Shell-only queue after an Agent failure", async () => {
		let releaseModel!: () => void;
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		let modelStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			modelStarted = resolve;
		});
		let id = 0;
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			fauxAssistantMessage("partial", {
				stopReason: "error",
				errorMessage: "provider unavailable",
				timestamp: 100,
			}),
			fauxAssistantMessage("recovered", { timestamp: 101 }),
		]);
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async ({ context, signal }) => {
				modelStarted();
				await modelGate;
				return faux.streamSimple(faux.getModel(), context, { signal, runtime });
			},
			autoDrainFollowUps: false,
		});
		let shellRunning = false;
		const runShell = vi.fn(async () => {
			shellRunning = true;
			shellRunning = false;
			return {};
		});
		const controller = new InteractiveInputController({
			agent,
			session: testSession(async () => undefined),
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
			allocateId: sequenceIds(),
			userShell: {
				get running() {
					return shellRunning;
				},
				cancel: () => false,
				run: runShell,
			} as never,
		});

		await controller.submit("initial", []);
		await started;
		await controller.submitUserShell("later");
		releaseModel();
		await controller.waitForIdle();

		expect(controller.queuePaused).toBe(true);
		expect(runShell).not.toHaveBeenCalled();
		await controller.submit("after pause", []);
		await controller.waitForIdle();
		expect(runShell).toHaveBeenCalledWith(expect.stringMatching(/^user_shell:/), "later");
		expect(
			agent.state.messages.filter(({ message }) => message.role === "user").map(({ message }) => message.content),
		).toEqual(["initial", "after pause"]);
	});

	it("drains deferred Follow-ups and local Shell commands in one strict FIFO", async () => {
		let releaseModel!: () => void;
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		let promptStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			promptStarted = resolve;
		});
		let releaseFirstInput!: () => void;
		const firstInputGate = new Promise<void>((resolve) => {
			releaseFirstInput = resolve;
		});
		let id = 0;
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			fauxAssistantMessage("prompt done", { timestamp: 100 }),
			fauxAssistantMessage("first done", { timestamp: 101 }),
			fauxAssistantMessage("second done", { timestamp: 102 }),
		]);
		const order: string[] = [];
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async ({ context, signal }) => {
				if (context.messages.length === 1) {
					promptStarted();
					await modelGate;
				}
				return faux.streamSimple(faux.getModel(), context, { signal, runtime });
			},
			autoDrainFollowUps: false,
		});
		agent.onEvent((event) => {
			if (event.type === "run_start") order.push(`agent:${String(event.inputMessage.message.content)}`);
		});
		let shellRunning = false;
		const userShell = {
			get running() {
				return shellRunning;
			},
			cancel: () => false,
			run: async (_shellId: string, command: string) => {
				shellRunning = true;
				order.push(`shell:${command}`);
				shellRunning = false;
				return {};
			},
		};
		const controller = new InteractiveInputController({
			agent,
			session: testSession(async () => undefined),
			buildInput: async (text) => {
				if (text === "first") await firstInputGate;
				return text;
			},
			prepareAttachments: async () => emptyTransaction(),
			allocateId: sequenceIds(),
			userShell: userShell as never,
		});

		await controller.submit("initial", []);
		await started;
		const first = controller.followUp("first", []);
		const shell = controller.submitUserShell("false");
		const second = controller.followUp("second", []);
		releaseFirstInput();
		await Promise.all([first, shell, second]);
		releaseModel();
		await controller.waitForIdle();

		expect(order).toEqual(["agent:initial", "agent:first", "shell:false", "agent:second"]);
		expect(agent.state.pendingFollowUps).toEqual([]);
	});

	it("reclaims a paused Follow-up into editable input and writes a durable tombstone", async () => {
		let id = 0;
		const queueId = "queue:paused" as QueueItemId;
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async () => {
				throw new Error("not called");
			},
			seed: {
				version: 1,
				messages: [],
				pendingFollowUps: [{ id: queueId, content: "edit me" }],
			},
			autoDrainFollowUps: false,
		});
		const record = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: testSession(record, [
				{ id: "composer:paused", kind: "follow_up", text: "edit me", queueItemId: queueId },
			]),
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
			allocateId: sequenceIds(),
		});

		await expect(controller.reclaimFollowUp(queueId)).resolves.toBeUndefined();
		expect(agent.state.pendingFollowUps).toEqual([]);
		expect(record).toHaveBeenCalledWith({ type: "follow_up_reclaimed", id: queueId });
		expect(record).toHaveBeenCalledWith({ type: "composer_submission_retracted", id: "composer:paused" });
	});

	it("commits staged Prompt attachments only after the User Message is accepted", async () => {
		let id = 0;
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: 100 })]);
		const order: string[] = [];
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			autoDrainFollowUps: false,
		});
		agent.onEvent((event) => {
			if (event.type === "run_start") order.push("run_start");
		});
		const controller = new InteractiveInputController({
			agent,
			session: testSession(async () => undefined),
			buildInput: async (text) => text,
			prepareAttachments: async () => ({
				commit: async () => {
					order.push("commit");
				},
				rollback: async () => {
					order.push("rollback");
				},
			}),
			allocateId: sequenceIds(),
		});

		await controller.submit("inspect", ["attachment:1"]);
		await controller.waitForIdle();

		expect(order).toEqual(["run_start", "commit"]);
	});

	it("accepts an attachment-only Prompt without adding a blank history entry", async () => {
		let id = 0;
		const runtime = testTimeRuntime(100);
		const faux = createFauxCore({ runtime });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: 100 })]);
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			autoDrainFollowUps: false,
		});
		const record = vi.fn(async (_change: Parameters<Session["record"]>[0]) => undefined);
		const commit = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: testSession(record),
			buildInput: async () => [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			prepareAttachments: async () => ({ commit, rollback: async () => undefined }),
			allocateId: sequenceIds(),
		});

		await expect(controller.submit("", ["attachment:1"])).resolves.toBeUndefined();
		await controller.waitForIdle();

		expect(record).not.toHaveBeenCalled();
		expect(commit).toHaveBeenCalledOnce();
	});

	it("rolls back staged attachments when Agent mutation is rejected", async () => {
		const agent = new Agent({
			clock: { now: () => 100 },
			idGenerator: { generate: () => "" },
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async () => {
				throw new Error("stream must not start");
			},
			autoDrainFollowUps: false,
		});
		const commit = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: testSession(async () => undefined),
			buildInput: async (text) => text,
			prepareAttachments: async () => ({ commit, rollback }),
			allocateId: sequenceIds(),
		});

		await expect(controller.submit("blocked", ["attachment:1"])).rejects.toMatchObject({
			code: "invalid_lifecycle",
		});
		expect(commit).not.toHaveBeenCalled();
		expect(rollback).toHaveBeenCalledOnce();
	});
});

function emptyTransaction() {
	return {
		commit: async () => undefined,
		rollback: async () => undefined,
	};
}

function sequenceIds(): () => string {
	let id = 0;
	return () => String(++id);
}

function testSession(
	record: Session["record"],
	composerSubmissions: Session["composerSubmissions"] = [],
): Pick<Session, "composerSubmissions" | "record"> {
	return { composerSubmissions, record };
}
