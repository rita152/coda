import type { PermissionProfile } from "@coda/sandbox";
import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";

export interface PermissionCommandFlowOptions {
	readonly current: PermissionProfile;
	readonly onSelect: (profile: PermissionProfile) => Promise<unknown> | unknown;
}

export function createPermissionCommandFlow(options: PermissionCommandFlowOptions): CommandFlowMenu {
	const commit = (profile: PermissionProfile, navigation: CommandFlowNavigation): Promise<void> | void => {
		const result = options.onSelect(profile);
		if (isPromiseLike(result)) {
			return Promise.resolve(result).then(() => navigation.close());
		}
		navigation.close();
	};
	const confirmFullAccess: CommandFlowMenu = Object.freeze({
		id: "permission:confirm-full-access",
		title: "Confirm Full Access",
		items: Object.freeze([
			Object.freeze({
				id: "confirm",
				label: "Enable Full Access",
				description: "Disable the outer filesystem and network sandbox for future Runs",
				onSelect: (navigation: CommandFlowNavigation) => commit("full-access", navigation),
			}),
			Object.freeze({
				id: "cancel",
				label: "Cancel",
				onSelect: (navigation: CommandFlowNavigation) => navigation.back(),
			}),
		]),
	});
	return Object.freeze({
		id: "permission",
		title: "Permission",
		items: Object.freeze([
			permissionItem("read-only", "Readonly", "Allow reads; writes and network require approval", options, commit),
			permissionItem("workspace", "Workspace", "Allow writes in configured workspace roots", options, commit),
			Object.freeze({
				id: "full-access",
				label: "Full Access",
				description: "Run with host-user filesystem and network authority",
				status: options.current === "full-access" ? "current" : undefined,
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(confirmFullAccess),
			}),
		]),
	});
}

function permissionItem(
	profile: Exclude<PermissionProfile, "full-access">,
	label: string,
	description: string,
	options: PermissionCommandFlowOptions,
	commit: (profile: PermissionProfile, navigation: CommandFlowNavigation) => Promise<void> | void,
) {
	return Object.freeze({
		id: profile,
		label,
		description,
		status: options.current === profile ? "current" : undefined,
		onSelect: (navigation: CommandFlowNavigation) => commit(profile, navigation),
	});
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
