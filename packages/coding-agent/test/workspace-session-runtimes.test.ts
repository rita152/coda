import { describe, expect, it, vi } from "vitest";
import { WorkspaceSessionRuntimes } from "../src/runtime/workspace-session-runtimes.ts";

interface FauxRuntime {
	readonly id: string;
	empty: boolean;
	running: boolean;
}

describe("WorkspaceSessionRuntimes", () => {
	it("switches focus without stopping the former runtime", async () => {
		const first: FauxRuntime = { id: "a", empty: false, running: true };
		const second: FauxRuntime = { id: "b", empty: false, running: false };
		const runtimes = new WorkspaceSessionRuntimes(first, {
			id: (runtime) => runtime.id,
			isEmpty: (runtime) => runtime.empty,
		});
		const load = vi.fn(async () => second);

		await runtimes.focus("b", load);

		expect(runtimes.active).toBe(second);
		expect(first.running).toBe(true);
		expect(runtimes.open).toEqual([first, second]);
	});

	it("does not create a meaningless replacement for an empty active session", async () => {
		const empty: FauxRuntime = { id: "empty", empty: true, running: false };
		const runtimes = new WorkspaceSessionRuntimes(empty, {
			id: (runtime) => runtime.id,
			isEmpty: (runtime) => runtime.empty,
		});
		const create = vi.fn(async () => ({ id: "new", empty: true, running: false }));

		const result = await runtimes.create(create);

		expect(result).toEqual({ runtime: empty, created: false });
		expect(create).not.toHaveBeenCalled();
	});

	it("coalesces concurrent attempts to open the same historical session", async () => {
		const first: FauxRuntime = { id: "a", empty: false, running: false };
		const second: FauxRuntime = { id: "b", empty: false, running: false };
		const runtimes = new WorkspaceSessionRuntimes(first, {
			id: (runtime) => runtime.id,
			isEmpty: (runtime) => runtime.empty,
		});
		const load = vi.fn(async () => second);

		const [left, right] = await Promise.all([runtimes.focus("b", load), runtimes.focus("b", load)]);

		expect(left).toBe(second);
		expect(right).toBe(second);
		expect(load).toHaveBeenCalledTimes(1);
	});
});
