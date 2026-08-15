import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createSessionCommandFlow } from "../src/commands/session-flow.ts";
import { CommandFlowHost } from "../src/ui/command-flow-host.ts";

describe("session command flow", () => {
	it("shows only workspace sessions and switches directly to the selected runtime", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createSessionCommandFlow({
				sessions: [
					{ id: "session-a", label: "Session A", status: "current" },
					{ id: "session-b", label: "Session B", status: "needs attention" },
				],
				onSelect,
			}),
		);

		expect(host.view?.items.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: "session-a", status: "current" },
			{ id: "session-b", status: "needs attention" },
		]);
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(onSelect).toHaveBeenCalledWith("session-b");
		expect(host.view).toBeUndefined();
	});
});

function key(keyName: KeyInput["key"]): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
	};
}
