import { describe, expect, it } from "vitest";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { SessionManagerRouter } from "../src/session/session-manager-router.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("SessionManagerRouter", () => {
	it("lists only persistent user Sessions, never Worker-private children", async () => {
		const time = testTimeRuntime(1_000);
		let nextId = 0;
		const idGenerator = { generate: (kind: string) => `${kind}:${++nextId}` };
		const memory = new InMemorySessionManager({ clock: time.clock, idGenerator });
		const persistent = new InMemorySessionManager({ clock: time.clock, idGenerator });
		const router = new SessionManagerRouter(memory, persistent);
		const workspace = { id: "workspace", path: "/workspace" };
		const user = await persistent.open({ workspace, mode: "interactive", createId: "session:user" });
		const child = await memory.open({
			workspace,
			mode: "print",
			createId: "session:worker-child",
			persistent: false,
		});
		expect(child.descriptor.persistent).toBe(false);
		const listed = await router.list(workspace);
		expect(listed.map((session) => session.id)).not.toContain("session:worker-child");
		const summaries = await router.listSummaries(workspace);
		expect(summaries.map((summary) => summary.descriptor.id)).not.toContain("session:worker-child");
		await user.close();
		await child.close();
	});
});
