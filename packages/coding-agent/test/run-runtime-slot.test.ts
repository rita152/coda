import { describe, expect, it } from "vitest";
import { RunRuntimeSlot } from "../src/runtime/run-runtime-slot.ts";

describe("RunRuntimeSlot", () => {
	it("freezes only the active Run and lets the next Run consume the latest session selection", () => {
		const slot = new RunRuntimeSlot({ model: "model-a", reasoning: "low" });

		const first = slot.begin();
		slot.select({ model: "model-b", reasoning: "medium" });
		slot.select({ model: "model-c", reasoning: "high" });

		expect(first.value).toEqual({ model: "model-a", reasoning: "low" });
		expect(slot.active).toBe(first);
		expect(slot.selected).toEqual({ model: "model-c", reasoning: "high" });

		slot.end(first.id);
		const followUp = slot.begin();

		expect(followUp.value).toEqual({ model: "model-c", reasoning: "high" });
	});
});
