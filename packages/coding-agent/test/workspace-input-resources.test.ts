import type { WorkGraphId, WorkItemId } from "@coda/runtime";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceInputResources } from "../src/runtime/workspace-input-resources.ts";

describe("Workspace input resources", () => {
	it("transfers commit and rollback ownership to one atomic Runtime reservation", async () => {
		const resources = new WorkspaceInputResources();
		const commit = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const registered = resources.register(["attachment:one", "attachment:two"], { commit, rollback });
		expect(registered.resources).toEqual(["attachment:one", "attachment:two"]);

		const reservation = await resources.adapter.reserve({
			graphId: "graph:resources" as WorkGraphId,
			itemId: "root" as WorkItemId,
			input: "input",
			references: registered.resources,
		});
		await expect(
			resources.adapter.reserve({
				graphId: "graph:other" as WorkGraphId,
				itemId: "root" as WorkItemId,
				input: "other",
				references: ["attachment:one"],
			}),
		).rejects.toThrow("already reserved");
		await reservation.commit();
		await registered.commit();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(rollback).not.toHaveBeenCalled();
	});

	it("lets the caller roll back resources rejected before Runtime reservation", async () => {
		const resources = new WorkspaceInputResources();
		const rollback = vi.fn(async () => undefined);
		const registered = resources.register(["attachment:rejected"], {
			commit: async () => undefined,
			rollback,
		});
		await registered.rollback();
		expect(rollback).toHaveBeenCalledTimes(1);
		await expect(
			resources.adapter.reserve({
				graphId: "graph:late" as WorkGraphId,
				itemId: "root" as WorkItemId,
				input: "late",
				references: ["attachment:rejected"],
			}),
		).rejects.toThrow("not registered");
	});
});
