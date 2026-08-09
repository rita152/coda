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
		});
		const record = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: { record } as unknown as Session,
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
		});

		await expect(controller.submit("start", [])).resolves.toBeUndefined();
		expect(agent.state.status).toBe("running");
		const followUpId = await controller.followUp("later", []);
		expect(record).toHaveBeenCalledWith({
			type: "follow_up_enqueued",
			item: { id: followUpId, content: "later" },
		});

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
		});
		const record = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: { record } as unknown as Session,
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
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
		});
		const record = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: { record } as unknown as Session,
			buildInput: async (text) => text,
			prepareAttachments: async () => emptyTransaction(),
		});

		await expect(controller.reclaimFollowUp(queueId)).resolves.toBeUndefined();
		expect(agent.state.pendingFollowUps).toEqual([]);
		expect(record).toHaveBeenCalledWith({ type: "follow_up_reclaimed", id: queueId });
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
		});
		agent.onEvent((event) => {
			if (event.type === "run_start") order.push("run_start");
		});
		const controller = new InteractiveInputController({
			agent,
			session: { record: async () => undefined } as unknown as Session,
			buildInput: async (text) => text,
			prepareAttachments: async () => ({
				commit: async () => {
					order.push("commit");
				},
				rollback: async () => {
					order.push("rollback");
				},
			}),
		});

		await controller.submit("inspect", ["attachment:1"]);
		await controller.waitForIdle();

		expect(order).toEqual(["run_start", "commit"]);
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
		});
		const commit = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const controller = new InteractiveInputController({
			agent,
			session: { record: async () => undefined } as unknown as Session,
			buildInput: async (text) => text,
			prepareAttachments: async () => ({ commit, rollback }),
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
