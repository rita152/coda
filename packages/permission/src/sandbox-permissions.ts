import type { ApprovalPolicy } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalPolicyDebugName(approvalPolicy: ApprovalPolicy): string {
	if (approvalPolicy === "on-request") return "OnRequest";
	if (approvalPolicy === "never") return "Never";
	return "UnlessTrusted";
}

function networkPermissionRequested(value: unknown): boolean {
	return isRecord(value) && typeof value.enabled === "boolean";
}

function fileSystemPermissionRequested(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (Array.isArray(value.entries) && value.entries.length > 0) return true;
	if (Array.isArray(value.read) && value.read.length > 0) return true;
	if (Array.isArray(value.write) && value.write.length > 0) return true;
	return false;
}

function additionalPermissionsRequested(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return networkPermissionRequested(value.network) || fileSystemPermissionRequested(value.file_system);
}

/** Codex `normalize_and_validate_additional_permissions` / justification checks. */
export function sandboxPermissionRequestReason(
	toolInput: Readonly<Record<string, unknown>>,
	approvalPolicy: ApprovalPolicy,
): string | undefined {
	const sandboxPermissions = toolInput.sandbox_permissions ?? toolInput.sandboxPermissions;
	if (toolInput.justification !== undefined && sandboxPermissions === undefined) {
		return '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.';
	}
	const additionalPermissions = toolInput.additional_permissions ?? toolInput.additionalPermissions;
	if (sandboxPermissions === "with_additional_permissions") {
		if (approvalPolicy !== "on-request") {
			return `approval policy is ${approvalPolicyDebugName(approvalPolicy)}; reject command — you cannot request additional permissions unless the approval policy is OnRequest`;
		}
		if (additionalPermissions === undefined) {
			return "missing `additional_permissions`; provide at least one of `network` or `file_system` when using `with_additional_permissions`";
		}
		if (!additionalPermissionsRequested(additionalPermissions)) {
			return "`additional_permissions` must include at least one requested permission in `network` or `file_system`";
		}
		return undefined;
	}
	if (additionalPermissions !== undefined) {
		return "`additional_permissions` requires `sandbox_permissions` set to `with_additional_permissions`";
	}
	if (sandboxPermissions === "require_escalated" && approvalPolicy !== "on-request") {
		const label = approvalPolicyDebugName(approvalPolicy);
		return `approval policy is ${label}; reject command — you should not ask for escalated permissions if the approval policy is ${label}`;
	}
	return undefined;
}
