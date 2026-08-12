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

	it("replaces only the active runtime after an empty successor is ready", async () => {
		const first: FauxRuntime = { id: "a", empty: false, running: false };
		const background: FauxRuntime = { id: "b", empty: false, running: true };
		const replacement: FauxRuntime = { id: "c", empty: true, running: false };
		const runtimes = new WorkspaceSessionRuntimes(first, {
			id: (runtime) => runtime.id,
			isEmpty: (runtime) => runtime.empty,
		});

		await runtimes.focus("b", async () => background);
		await runtimes.focus("a", async () => first);
		const replaced = runtimes.replaceActive(replacement);

		expect(replaced).toBe(first);
		expect(runtimes.active).toBe(replacement);
		expect(runtimes.open).toEqual([background, replacement]);
		expect(runtimes.get("a")).toBeUndefined();
	});

	it("rejects a non-empty or duplicate replacement without changing active state", () => {
		const first: FauxRuntime = { id: "a", empty: false, running: false };
		const runtimes = new WorkspaceSessionRuntimes(first, {
			id: (runtime) => runtime.id,
			isEmpty: (runtime) => runtime.empty,
		});

		expect(() => runtimes.replaceActive({ id: "b", empty: false, running: false })).toThrow(
			"Replacement Session runtime is not empty",
		);
		expect(() => runtimes.replaceActive({ id: "a", empty: true, running: false })).toThrow(
			"Replacement Session runtime identity is already open",
		);
		expect(runtimes.active).toBe(first);
		expect(runtimes.open).toEqual([first]);
	});
});
