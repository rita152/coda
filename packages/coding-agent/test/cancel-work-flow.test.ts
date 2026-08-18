import { describe, expect, it } from "vitest";
import { createCancelWorkCommandFlow } from "../src/commands/cancel-work-flow.ts";

describe("cancel-work command flow", () => {
	it("lists the Graph and running children without claiming rollback", () => {
		const canceled: string[] = [];
		const flow = createCancelWorkCommandFlow({
			graphActive: true,
			children: [
				{ itemId: "alpha", objective: "write alpha", state: "running" },
				{ itemId: "beta", objective: "write beta", state: "succeeded" },
			],
			onCancelGraph: () => {
				canceled.push("graph");
			},
			onCancelItem: (itemId) => {
				canceled.push(itemId);
			},
		});
		expect(flow.items.map((item) => item.id)).toEqual(["graph", "item:alpha"]);
		expect(flow.items.every((item) => item.description?.includes("Does not roll back"))).toBe(true);
		expect(JSON.stringify(flow)).not.toMatch(/rolled back/i);
		void canceled;
	});
});
