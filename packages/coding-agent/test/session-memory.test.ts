import { Agent, type IdGenerator, type IdKind } from "@coda/agent";
import { fauxAssistantMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("Session facade", () => {
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
		const agent = new Agent({
			clock: { now: () => 1_100 },
			idGenerator,
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async () => {
				const { createFauxCore } = await import("@coda/ai");
				const faux = createFauxCore({ runtime });
				faux.setResponses(responses.splice(0));
				return faux.streamSimple(faux.getModel(), { messages: [] }, { runtime });
			},
		});
		session.attach(agent);
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
