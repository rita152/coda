import { describe, expect, it } from "vitest";
import { RunRuntimeSlot } from "../src/runtime/run-runtime-slot.ts";

describe("RunRuntimeSlot", () => {
	it("freezes only the active Run and lets the next Run consume the latest session selection", () => {
		const slot = new RunRuntimeSlot({ model: "model-a", permission: "workspace" });

		const first = slot.begin();
		slot.select({ model: "model-b", permission: "read-only" });
		slot.select({ model: "model-c", permission: "full-access" });

		expect(first.value).toEqual({ model: "model-a", permission: "workspace" });
		expect(slot.active).toBe(first);
		expect(slot.selected).toEqual({ model: "model-c", permission: "full-access" });

		slot.end(first.id);
		const followUp = slot.begin();

		expect(followUp.value).toEqual({ model: "model-c", permission: "full-access" });
	});
});
