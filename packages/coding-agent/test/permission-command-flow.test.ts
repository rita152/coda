import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createPermissionCommandFlow } from "../src/commands/permission-flow.ts";
import { CommandFlowHost } from "../src/interactive/command-flow-host.ts";

describe("permission command flow", () => {
	it("requires confirmation for Full Access and commits the selected preset", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(createPermissionCommandFlow({ current: "workspace", onSelect }));

		host.handleInput(key("down"));
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(host.view?.breadcrumb).toEqual(["Permission", "Confirm Full Access"]);
		expect(onSelect).not.toHaveBeenCalled();

		host.handleInput(key("enter"));

		expect(onSelect).toHaveBeenCalledWith("full-access");
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
