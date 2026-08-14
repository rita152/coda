import type { WorkGraphId, WorkItemId } from "@coda/runtime";
import { describe, expect, it } from "vitest";
import { WorkspaceWorkSessions } from "../src/runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const placement = {
	placementId: "direct:graph:child",
	root: "/workspace",
	baseIdentity: "base",
	kind: "direct" as const,
};

describe("Workspace Work Sessions", () => {
	it("recreates an empty private child Session during pending Work recovery", async () => {
		const sessions = new WorkspaceWorkSessions();
		const created = await sessions.adapter.reserve({
			graphId: "graph:recovery" as WorkGraphId,
			itemId: "child" as WorkItemId,
			parentItemId: "root" as WorkItemId,
			target: { type: "create", sessionId: "session:child" },
			placement,
		});
		await created.commit();
		await created.session.close();

		const recovered = await sessions.adapter.reserve({
			graphId: "graph:recovery" as WorkGraphId,
			itemId: "child" as WorkItemId,
			parentItemId: "root" as WorkItemId,
			target: { type: "resume", sessionId: "session:child" },
			placement,
		});
		expect(recovered.session.id).toBe("session:child");
		expect(recovered.session.seed?.messages).toEqual([]);
		await recovered.session.close();
	});

	it("does not fabricate a missing durable root Session", async () => {
		const sessions = new WorkspaceWorkSessions();
		await expect(
			sessions.adapter.reserve({
				graphId: "graph:root" as WorkGraphId,
				itemId: "root" as WorkItemId,
				target: { type: "resume", sessionId: "session:root" },
				placement,
			}),
		).rejects.toThrow("Durable Session is not open");
	});

	it("single-flights a missing durable root through the SessionManager and releases its ownership", async () => {
		const time = testTimeRuntime(100);
		let nextId = 0;
		const manager = new InMemorySessionManager({
			clock: time.clock,
			idGenerator: { generate: (kind) => `${kind}:${++nextId}` },
		});
		const workspace = { id: "workspace", path: "/workspace" };
		const original = await manager.open({
			workspace,
			mode: "print",
			createId: "session-root",
			persistent: true,
		});
		await original.close();
		let loads = 0;
		const sessions = new WorkspaceWorkSessions({
			resumeDurableRoot: async (sessionId) => {
				loads++;
				return manager.open({ workspace, mode: "print", resumeId: sessionId, persistent: true });
			},
		});
		const request = {
			graphId: "graph:root" as WorkGraphId,
			itemId: "root" as WorkItemId,
			target: { type: "resume" as const, sessionId: "session-root" },
			placement,
		};

		const attempts = await Promise.allSettled([sessions.adapter.reserve(request), sessions.adapter.reserve(request)]);
		const accepted = attempts.find(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof sessions.adapter.reserve>>> =>
				result.status === "fulfilled",
		);
		expect(loads).toBe(1);
		expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
		expect(accepted?.value.session.id).toBe("session-root");
		await accepted?.value.session.close();

		const reopened = await manager.open({ workspace, mode: "print", resumeId: "session-root", persistent: true });
		expect(reopened.descriptor.id).toBe("session-root");
		await reopened.close();
	});
});
