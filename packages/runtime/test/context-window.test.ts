import type { AgentMessage, MessageId } from "@coda/agent";
import {
	type AssistantMessage,
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Model,
} from "@coda/ai";
import { describe, expect, it } from "vitest";
import { ContextWindowController } from "../src/context-window/context-window.ts";
import type { CompactionCheckpoint } from "../src/context-window/types.ts";

function testTimeRuntime(clockOrValue: { now(): number } | number = 0) {
	const clock = typeof clockOrValue === "number" ? { now: () => clockOrValue } : clockOrValue;
	return {
		clock,
		random: { next: () => 0 },
		sleep: { wait: async () => {} },
	};
}

describe("ContextWindowController", () => {
	it("does not activate a checkpoint when the durable commit fails", async () => {
		const fixture = await controllerFixture();
		fixture.faux.setResponses([fauxAssistantMessage(summary("atomic summary"), { timestamp: 10_000 })]);
		const messages = [user("message:u1", "old request"), assistant("message:a1", "old answer")];
		const controller = fixture.controller({
			commit: async () => {
				throw new Error("journal unavailable");
			},
		});

		await expect(controller.compact({ messages, reason: "manual" })).rejects.toThrow("journal unavailable");
		expect(controller.checkpoint).toBeUndefined();
		expect(controller.project(messages)).toEqual(messages);
	});

	it("retains a Tool-pair-safe exact tail and records complete checkpoint provenance", async () => {
		const fixture = await controllerFixture();
		fixture.faux.setResponses([
			(context) => {
				const prompt = context.messages
					.map((message) =>
						typeof message.content === "string" ? message.content : JSON.stringify(message.content),
					)
					.join("\n");
				expect(prompt).toContain('"observation":{"status":"error","truncated":true');
				expect(prompt).not.toContain("SECRET_PRESENTATION_DETAIL");
				return fauxAssistantMessage(summary("safe tail"), { timestamp: 10_000 });
			},
		]);
		const messages: AgentMessage[] = [
			user("message:u1", "inspect"),
			{
				id: "message:a-tool" as MessageId,
				message: fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:read" }), {
					stopReason: "toolUse",
					timestamp: 10_000,
				}),
			},
			{
				id: "message:tool-result" as MessageId,
				message: {
					role: "toolResult",
					toolCallId: "provider:read",
					toolName: "read",
					content: [{ type: "text", text: `discarded-result:${"x".repeat(100_000)}` }],
					observation: { status: "error", truncated: true, facts: { code: "partial_read" } },
					details: { internal: "SECRET_PRESENTATION_DETAIL" },
					isError: true,
					timestamp: 10_000,
				},
			},
			assistant("message:a-final", "inspection complete"),
		];
		let committed: CompactionCheckpoint | undefined;
		const controller = fixture.controller({
			commit: async (checkpoint) => {
				committed = structuredClone(checkpoint);
			},
		});

		const checkpoint = await controller.compact({ messages, reason: "manual", focus: "keep file state" });

		expect(committed).toEqual(checkpoint);
		expect(checkpoint.coveredMessageIds).toEqual(["message:u1", "message:a-tool", "message:tool-result"]);
		expect(checkpoint.retainedMessageIds).toEqual(["message:a-final"]);
		expect(checkpoint.replacementHistory.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(checkpoint.replacementHistory.some(({ message }) => message.role === "toolResult")).toBe(false);
		expect(checkpoint.summaryPrompt).toMatchObject({ version: "1", calls: 1 });
		expect(checkpoint.summaryPrompt.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(checkpoint.model).toMatchObject({ id: "large", contextWindow: 128_000 });
		expect(checkpoint.usage.beforeEstimatedTokens).toBeGreaterThan(checkpoint.usage.afterEstimatedTokens);
	});

	it("chains repeated checkpoints and folds newly old Messages into the next summary", async () => {
		const fixture = await controllerFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage(summary("first decision"), { timestamp: 10_000 }),
			(context) => {
				const prompt = JSON.stringify(context.messages);
				expect(prompt).toContain("first decision");
				expect(prompt).toContain("new-large-state");
				return fauxAssistantMessage(summary("second decision"), { timestamp: 10_000 });
			},
		]);
		const committed: CompactionCheckpoint[] = [];
		const controller = fixture.controller({ commit: async (checkpoint) => void committed.push(checkpoint) });
		const firstMessages = [user("message:u1", "initial request"), assistant("message:a1", "initial answer")];
		const first = await controller.compact({ messages: firstMessages, reason: "manual" });
		const allMessages = [
			...firstMessages,
			user("message:u2", "continue"),
			assistant("message:a2", `new-large-state:${"y".repeat(100_000)}`),
		];

		const second = await controller.compact({ messages: allMessages, reason: "manual" });

		expect(committed).toHaveLength(2);
		expect(second.previousWindowId).toBe(first.windowId);
		expect(second.windowId).not.toBe(first.windowId);
		expect(second.coveredMessageIds).toEqual(["message:u1", "message:a1", "message:u2", "message:a2"]);
		expect(JSON.stringify(controller.project(allMessages))).not.toContain("new-large-state:");
	});

	it("recompacts an existing projection after a model downshift", async () => {
		const fixture = await controllerFixture({
			models: [
				{ id: "large", contextWindow: 128_000, maxTokens: 16_384 },
				{ id: "small", contextWindow: 16_000, maxTokens: 2_000 },
			],
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(summary("large-model checkpoint"), { timestamp: 10_000 }),
			fauxAssistantMessage(summary("small-model checkpoint"), { timestamp: 10_000 }),
		]);
		const controller = fixture.controller({ commit: async () => undefined });
		const firstMessages = [user("message:u1", "initial"), assistant("message:a1", "done")];
		const first = await controller.compact({ messages: firstMessages, reason: "manual" });
		fixture.select("small");
		const allMessages = [...firstMessages, user("message:u2", `downshift-large-input:${"z".repeat(40_000)}`)];
		const context: Context = {
			messages: allMessages.map(({ message }) => structuredClone(message) as Message),
		};

		const prepared = await controller.prepare(context, allMessages);

		expect(first.model.id).toBe("large");
		expect(controller.checkpoint).toMatchObject({ reason: "auto", previousWindowId: first.windowId });
		expect(controller.checkpoint?.model.id).toBe("small");
		expect(JSON.stringify(prepared.messages)).toContain("<conversation-checkpoint");
		expect(JSON.stringify(prepared.messages)).not.toContain("downshift-large-input:");
	});

	it("reports exact Provider usage plus estimated trailing Context", async () => {
		const fixture = await controllerFixture();
		const controller = fixture.controller({ commit: async () => undefined });
		const response = assistant("message:a1", "answer", usage(12_000, 0.4));
		const exact = controller.usage({ systemPrompt: "system" }, [user("message:u1", "question"), response]);
		const trailing = controller.usage({ systemPrompt: "system" }, [
			user("message:u1", "question"),
			response,
			user("message:u2", "x".repeat(400)),
		]);

		expect(exact).toEqual({ usedTokens: 12_000, estimated: false });
		expect(trailing.usedTokens).toBe(12_100);
		expect(trailing.estimated).toBe(true);
	});

	it("re-estimates a compacted projection until fresh Provider usage arrives", async () => {
		const fixture = await controllerFixture();
		fixture.faux.setResponses([fauxAssistantMessage(summary("compact estimate"), { timestamp: 10_000 })]);
		const controller = fixture.controller({ commit: async () => undefined });
		const old = assistant("message:a1", "old answer", usage(90_000, 0.9));
		const compacted = [user("message:u1", "old question"), old];

		await controller.compact({ messages: compacted, reason: "manual" });
		const estimated = controller.usage({ systemPrompt: "system" }, compacted);
		const fresh = assistant("message:a2", "fresh answer", usage(4_000, 0.04));
		const authoritative = controller.usage({ systemPrompt: "system" }, [...compacted, fresh]);

		expect(estimated.usedTokens).toBeLessThan(10_000);
		expect(estimated.estimated).toBe(true);
		expect(authoritative).toEqual({ usedTokens: 4_000, estimated: false });
	});

	it("persists cumulative compaction cost in the checkpoint", async () => {
		const fixture = await controllerFixture();
		const response = fauxAssistantMessage(summary("priced checkpoint"), { timestamp: 10_000 });
		response.usage = usage(1_000, 0.25);
		fixture.faux.setResponses([response]);
		const controller = fixture.controller({ commit: async () => undefined });

		const checkpoint = await controller.compact({
			messages: [user("message:u1", "question"), assistant("message:a1", "answer")],
			reason: "manual",
		});

		expect(checkpoint.usage).toMatchObject({ summaryCost: 0.25, cumulativeCost: 0.25 });
		expect(controller.compactionCost).toBe(0.25);
	});
});

async function controllerFixture(
	options: { models?: Array<{ id: string; contextWindow: number; maxTokens: number }> } = {},
) {
	const runtime = testTimeRuntime(10_000);
	const faux = fauxProvider({
		runtime,
		models: options.models ?? [{ id: "large", contextWindow: 128_000, maxTokens: 16_384 }],
	});
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	let selected = faux.getModel();
	let id = 0;
	return {
		faux,
		select(modelId: string) {
			selected = faux.getModel(modelId)!;
		},
		controller({ commit }: { commit: (checkpoint: CompactionCheckpoint) => Promise<void> }) {
			return new ContextWindowController({
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				runtime: () => {
					const driver = models.bindSimple(selected as Model, { auth: {} });
					return { model: selected as Model, complete: driver.complete };
				},
				commit,
			});
		},
	};
}

function user(id: string, content: string): AgentMessage {
	return {
		id: id as MessageId,
		message: { role: "user", content, timestamp: 10_000 },
	};
}

function assistant(
	id: string,
	content: string,
	customUsage?: AssistantMessage["usage"],
): AgentMessage<AssistantMessage> {
	const message = fauxAssistantMessage(content, { timestamp: 10_000 });
	if (customUsage) message.usage = customUsage;
	return {
		id: id as MessageId,
		message,
	};
}

function usage(totalTokens: number, cost: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function summary(decision: string): string {
	return [
		"## Objective",
		"- Continue.",
		"## Constraints",
		"- Preserve intent.",
		"## Decisions",
		`- ${decision}.`,
		"## Completed",
		"- Prior work.",
		"## Current State",
		"- Ready.",
		"## Next Steps",
		"- Continue.",
		"## Relevant Files and Commands",
		"- None.",
		"## Errors and Open Questions",
		"- None.",
	].join("\n");
}
