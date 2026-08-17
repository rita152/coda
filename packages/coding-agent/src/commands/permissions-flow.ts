import type { ApprovalPolicy } from "@coda/permission";
import type { SandboxMode } from "@coda/sandbox";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export interface PermissionPreset {
	readonly id: "read-only" | "auto" | "full-access";
	readonly label: string;
	readonly description: string;
	readonly approvalPolicy: ApprovalPolicy;
	readonly sandboxMode: SandboxMode;
	readonly requiresConfirmation?: boolean;
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = Object.freeze([
	Object.freeze({
		id: "read-only",
		label: "Read Only",
		description:
			"Coda can read files in the current workspace. Approval is required to edit files or access the internet.",
		approvalPolicy: "on-request",
		sandboxMode: "read-only",
	}),
	Object.freeze({
		id: "auto",
		label: "Ask for approval",
		description:
			"Coda can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
		approvalPolicy: "on-request",
		sandboxMode: "workspace-write",
	}),
	Object.freeze({
		id: "full-access",
		label: "Full Access",
		description:
			"Coda can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
		approvalPolicy: "never",
		sandboxMode: "danger-full-access",
		requiresConfirmation: true,
	}),
]);

export interface PermissionsCommandState {
	readonly approvalPolicy: ApprovalPolicy;
	readonly sandboxMode: SandboxMode;
}

export interface PermissionsCommandFlowOptions {
	readonly current: PermissionsCommandState;
	readonly onSelect: (preset: PermissionPreset) => Promise<unknown> | unknown;
}

export function matchingPermissionPreset(state: PermissionsCommandState): PermissionPreset | undefined {
	return PERMISSION_PRESETS.find(
		(preset) => preset.approvalPolicy === state.approvalPolicy && preset.sandboxMode === state.sandboxMode,
	);
}

export function permissionStatusLabel(state: PermissionsCommandState): string {
	return (
		matchingPermissionPreset(state)?.label ??
		`${approvalStatusLabel(state.approvalPolicy)} · ${sandboxStatusLabel(state.sandboxMode)}`
	);
}

function approvalStatusLabel(policy: ApprovalPolicy): string {
	if (policy === "untrusted") return "Untrusted";
	if (policy === "never") return "Never";
	return "Ask for approval";
}

function sandboxStatusLabel(mode: SandboxMode): string {
	if (mode === "read-only") return "Read Only";
	if (mode === "workspace-write") return "Workspace";
	return "Full Access";
}

export function createPermissionsCommandFlow(options: PermissionsCommandFlowOptions): CommandFlowMenu {
	const current = matchingPermissionPreset(options.current);
	return Object.freeze({
		id: "permissions",
		title: "Update Model Permissions",
		items: Object.freeze(
			PERMISSION_PRESETS.map((preset) =>
				Object.freeze({
					id: preset.id,
					label: preset.label,
					description: preset.description,
					status: current?.id === preset.id ? "current" : undefined,
					onSelect: (navigation: CommandFlowNavigation) => {
						if (preset.requiresConfirmation) {
							navigation.push(createFullAccessConfirmation(preset, options.onSelect));
							return;
						}
						return finishSelection(options.onSelect(preset), navigation);
					},
				}),
			),
		),
	});
}

function createFullAccessConfirmation(
	preset: PermissionPreset,
	onSelect: PermissionsCommandFlowOptions["onSelect"],
): CommandFlowMenu {
	return Object.freeze({
		id: "permissions:full-access",
		title: "Enable full access?",
		items: Object.freeze([
			Object.freeze({
				id: "confirm",
				label: "Yes, continue anyway",
				description:
					"When Coda runs with full access, it can edit any file on your computer and run commands with network, without your approval. Apply full access for this session.",
				onSelect: (navigation: CommandFlowNavigation) => finishSelection(onSelect(preset), navigation),
			}),
			Object.freeze({
				id: "cancel",
				label: "Cancel",
				description: "Go back without enabling full access",
				onSelect: (navigation: CommandFlowNavigation) => navigation.back(),
			}),
		]),
	});
}

function finishSelection(result: Promise<unknown> | unknown, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
