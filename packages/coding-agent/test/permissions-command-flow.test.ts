import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import {
	createPermissionsCommandFlow,
	PERMISSION_PRESETS,
	permissionStatusLabel,
} from "../src/commands/permissions-flow.ts";
import { CommandFlowHost } from "../src/ui/command-flow-host.ts";

describe("permissions command flow", () => {
	it("lists Codex presets, marks the current pair, and applies Ask for approval immediately", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createPermissionsCommandFlow({
				current: { approvalPolicy: "on-request", sandboxMode: "read-only" },
				onSelect,
			}),
		);

		expect(host.view?.menuId).toBe("permissions");
		expect(host.view?.breadcrumb).toEqual(["Update Model Permissions"]);
		expect(host.view?.items.map(({ id, label, status }) => ({ id, label, status }))).toEqual([
			{ id: "read-only", label: "Read Only", status: "current" },
			{ id: "auto", label: "Ask for approval", status: undefined },
			{ id: "full-access", label: "Full Access", status: undefined },
		]);

		host.handleInput(key("down"));
		host.handleInput(key("enter"));
		expect(onSelect).toHaveBeenCalledWith(PERMISSION_PRESETS[1]);
		expect(host.view).toBeUndefined();
	});

	it("requires confirmation before enabling Full Access", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createPermissionsCommandFlow({
				current: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
				onSelect,
			}),
		);

		host.handleInput(key("down"));
		host.handleInput(key("down"));
		host.handleInput(key("enter"));
		expect(onSelect).not.toHaveBeenCalled();
		expect(host.view?.breadcrumb).toEqual(["Update Model Permissions", "Enable full access?"]);
		expect(host.view?.items.map(({ id, label }) => ({ id, label }))).toEqual([
			{ id: "confirm", label: "Yes, continue anyway" },
			{ id: "cancel", label: "Cancel" },
		]);

		host.handleInput(key("down"));
		host.handleInput(key("enter"));
		expect(onSelect).not.toHaveBeenCalled();
		expect(host.view?.breadcrumb).toEqual(["Update Model Permissions"]);

		host.handleInput(key("enter"));
		host.handleInput(key("enter"));
		expect(onSelect).toHaveBeenCalledWith(PERMISSION_PRESETS[2]);
		expect(host.view).toBeUndefined();
	});

	it("names the current pair for the status line", () => {
		expect(permissionStatusLabel({ approvalPolicy: "on-request", sandboxMode: "read-only" })).toBe("Read Only");
		expect(permissionStatusLabel({ approvalPolicy: "on-request", sandboxMode: "workspace-write" })).toBe(
			"Ask for approval",
		);
		expect(permissionStatusLabel({ approvalPolicy: "never", sandboxMode: "danger-full-access" })).toBe("Full Access");
		expect(permissionStatusLabel({ approvalPolicy: "on-request", sandboxMode: "danger-full-access" })).toBe(
			"Ask for approval · Full Access",
		);
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
