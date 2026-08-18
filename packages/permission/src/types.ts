export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const FILESYSTEM_ACCESS = ["restricted", "unrestricted"] as const;
export type FilesystemAccess = (typeof FILESYSTEM_ACCESS)[number];

export const SANDBOX_PERMISSIONS = ["use_default", "require_escalated", "with_additional_permissions"] as const;
export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];

export function requestsSandboxOverride(toolInput: Readonly<Record<string, unknown>>): boolean {
	const value = toolInput.sandbox_permissions ?? toolInput.sandboxPermissions;
	return value === "require_escalated" || value === "with_additional_permissions";
}

export type PermissionRememberScope = "session" | "workspace" | "user";

export interface CommandPermissionRequest {
	readonly toolName: string;
	readonly toolInput: Readonly<Record<string, unknown>>;
	readonly sessionId: string;
	readonly workspace: string;
	readonly sandboxOverride?: boolean;
}

export type CommandPermissionDecision =
	| { readonly kind: "allow"; readonly remember?: PermissionRememberScope }
	| { readonly kind: "deny"; readonly reason: string; readonly remember?: PermissionRememberScope }
	| { readonly kind: "ask"; readonly prompt: string };

export interface RememberedCommandPermission {
	readonly key: string;
	readonly decision: "allow" | "deny";
	readonly reason?: string;
	readonly scope: PermissionRememberScope;
	readonly workspace?: string;
}

export interface CommandPermissionPolicyOptions {
	readonly approvalPolicy?: ApprovalPolicy;
	readonly filesystemAccess?: FilesystemAccess;
	readonly writableRoots?: readonly string[];
	readonly denyWrite?: readonly string[];
	readonly filesystemEnforced?: boolean;
	readonly remembered?: readonly RememberedCommandPermission[];
}

export interface CommandPermissionAskAnswer {
	readonly action: "allow" | "deny";
	readonly remember?: PermissionRememberScope;
	readonly reason?: string;
}

export interface CommandPermissionPolicySnapshot {
	readonly approvalPolicy: ApprovalPolicy;
	readonly filesystemAccess: FilesystemAccess;
	readonly writableRoots: readonly string[];
	readonly denyWrite: readonly string[];
	readonly filesystemEnforced: boolean;
}

export interface CommandPermissionPolicy {
	decide(request: CommandPermissionRequest): CommandPermissionDecision;
	remember(
		request: CommandPermissionRequest,
		decision: Extract<CommandPermissionDecision, { kind: "allow" | "deny" }>,
	): RememberedCommandPermission;
	remembered(): readonly RememberedCommandPermission[];
	configure(options: Omit<CommandPermissionPolicyOptions, "remembered">): void;
	snapshot(): CommandPermissionPolicySnapshot;
}
