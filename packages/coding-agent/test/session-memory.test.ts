import type { IdGenerator, IdKind, QueueItemId } from "@coda/agent";
import { fauxAssistantMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { createTestAgent } from "./agent-runtime-adapter.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("Session facade", () => {
	it("restores Composer submission history independently from Agent Messages", async () => {
		let id = 0;
		const manager = new InMemorySessionManager({
			clock: { now: () => 1_000 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		});
		const session = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
		});
		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:1", kind: "prompt", text: "kept" },
		});
		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:2", kind: "follow_up", text: "removed", queueItemId: "queue:2" },
		});
		await session.record({ type: "composer_submission_retracted", id: "submission:2" });
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.composerSubmissions).toEqual([{ id: "submission:1", kind: "prompt", text: "kept" }]);
		await restored.close();
	});

	it("round-trips ordered v6 Skill and MCP references in Composer history", async () => {
		let id = 0;
		const manager = new InMemorySessionManager({
			clock: { now: () => 1_025 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		});
		const session = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
		});
		const references = [
			{
				id: "extension-reference:one",
				commandId: "skill:review",
				source: "skill" as const,
				name: "review",
				start: 4,
				end: 11,
			},
			{
				id: "extension-reference:two",
				commandId: "mcp:search",
				source: "mcp" as const,
				name: "search",
				start: 17,
				end: 24,
			},
		];
		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:refs", kind: "prompt", text: "Use /review then /search", references },
		});
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.composerSubmissions).toEqual([
			{ id: "submission:refs", kind: "prompt", text: "Use /review then /search", references },
		]);
		await restored.close();
	});

	it("persists reclaiming a failed Follow-up as a distinct recoverability tombstone", async () => {
		let id = 0;
		const manager = new InMemorySessionManager({
			clock: { now: () => 1_050 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		});
		const session = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
		});
		const queueId = "queue:failed" as QueueItemId;
		await session.record({ type: "follow_up_enqueued", item: { id: queueId, content: "repair me" } });
		await session.record({ type: "follow_up_reclaimed", id: queueId });
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.seed.pendingFollowUps).toEqual([]);
		await restored.close();
	});

	it("records one attached Agent and restores only an idle Agent Seed plus application Model state", async () => {
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const manager = new InMemorySessionManager({
			clock: { now: () => 1_100 },
			idGenerator,
		});
		const session = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
		});
		await session.record({
			type: "model_selected",
			model: { provider: "opencode-go", id: "kimi-k2.6" },
			reasoning: "high",
		});
		await session.record({
			type: "prepare_run",
			promptVersion: "coda-system-prompt-v1",
			promptSha256: "a".repeat(64),
		});
		const responses = [fauxAssistantMessage("persisted answer", { timestamp: 1_100 })];
		const runtime = testTimeRuntime(1_100);
		const agent = createTestAgent({
			clock: { now: () => 1_100 },
			idGenerator,
			tools: [],
			stream: async () => {
				const { createFauxCore } = await import("@coda/ai");
				const faux = createFauxCore({ runtime });
				faux.setResponses(responses.splice(0));
				return faux.streamSimple(faux.getModel(), { messages: [] }, { runtime });
			},
		});
		agent.onSemanticEvent((event) => session.accept(event));
		await agent.prompt("persist me");
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});

		expect(restored.seed.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(restored.seed.pendingFollowUps).toEqual([]);
		expect(restored.restored).toMatchObject({
			model: { provider: "opencode-go", id: "kimi-k2.6" },
			reasoning: "high",
		});
		await restored.close();
	});
});
