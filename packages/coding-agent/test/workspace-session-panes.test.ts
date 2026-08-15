import { describe, expect, it, vi } from "vitest";
import { WorkspaceSessionPanes } from "../src/ui/workspace-session-panes.ts";

interface FauxPane {
	readonly id: string;
	empty: boolean;
	running: boolean;
}

describe("WorkspaceSessionPanes", () => {
	it("switches focus without stopping the former pane", async () => {
		const first: FauxPane = { id: "a", empty: false, running: true };
		const second: FauxPane = { id: "b", empty: false, running: false };
		const panes = new WorkspaceSessionPanes(first, {
			id: (pane) => pane.id,
			isEmpty: (pane) => pane.empty,
		});
		const load = vi.fn(async () => second);

		await panes.focus("b", load);

		expect(panes.active).toBe(second);
		expect(first.running).toBe(true);
		expect(panes.open).toEqual([first, second]);
	});

	it("does not create a meaningless replacement for an empty active session", async () => {
		const empty: FauxPane = { id: "empty", empty: true, running: false };
		const panes = new WorkspaceSessionPanes(empty, {
			id: (pane) => pane.id,
			isEmpty: (pane) => pane.empty,
		});
		const create = vi.fn(async () => ({ id: "new", empty: true, running: false }));

		const result = await panes.create(create);

		expect(result).toEqual({ pane: empty, created: false });
		expect(create).not.toHaveBeenCalled();
	});

	it("coalesces concurrent attempts to open the same historical session", async () => {
		const first: FauxPane = { id: "a", empty: false, running: false };
		const second: FauxPane = { id: "b", empty: false, running: false };
		const panes = new WorkspaceSessionPanes(first, {
			id: (pane) => pane.id,
			isEmpty: (pane) => pane.empty,
		});
		const load = vi.fn(async () => second);

		const [left, right] = await Promise.all([panes.focus("b", load), panes.focus("b", load)]);

		expect(left).toBe(second);
		expect(right).toBe(second);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("replaces only the active pane after an empty successor is ready", async () => {
		const first: FauxPane = { id: "a", empty: false, running: false };
		const background: FauxPane = { id: "b", empty: false, running: true };
		const replacement: FauxPane = { id: "c", empty: true, running: false };
		const panes = new WorkspaceSessionPanes(first, {
			id: (pane) => pane.id,
			isEmpty: (pane) => pane.empty,
		});

		await panes.focus("b", async () => background);
		await panes.focus("a", async () => first);
		const replaced = panes.replaceActive(replacement);

		expect(replaced).toBe(first);
		expect(panes.active).toBe(replacement);
		expect(panes.open).toEqual([background, replacement]);
		expect(panes.get("a")).toBeUndefined();
	});

	it("rejects a non-empty or duplicate replacement without changing active state", () => {
		const first: FauxPane = { id: "a", empty: false, running: false };
		const panes = new WorkspaceSessionPanes(first, {
			id: (pane) => pane.id,
			isEmpty: (pane) => pane.empty,
		});

		expect(() => panes.replaceActive({ id: "b", empty: false, running: false })).toThrow(
			"Replacement Session pane is not empty",
		);
		expect(() => panes.replaceActive({ id: "a", empty: true, running: false })).toThrow(
			"Replacement Session pane identity is already open",
		);
		expect(panes.active).toBe(first);
		expect(panes.open).toEqual([first]);
	});
});
