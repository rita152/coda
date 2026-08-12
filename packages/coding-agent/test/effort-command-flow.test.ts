import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createEffortCommandFlow } from "../src/commands/effort-flow.ts";
import { CommandFlowHost } from "../src/interactive/command-flow-host.ts";

describe("reasoning effort command flow", () => {
	it("lists only available efforts, marks the current value, and commits a selection", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createEffortCommandFlow({
				current: "medium",
				available: ["off", "low", "medium", "high"],
				onSelect,
			}),
		);

		expect(host.view?.items.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: "off", status: undefined },
			{ id: "low", status: undefined },
			{ id: "medium", status: "current" },
			{ id: "high", status: undefined },
		]);

		host.handleInput(key("down"));
		host.handleInput(key("down"));
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(onSelect).toHaveBeenCalledWith("high");
		expect(host.view).toBeUndefined();
	});
});

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}
