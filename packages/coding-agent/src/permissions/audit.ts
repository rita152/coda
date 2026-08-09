import type { CompiledSandboxPolicy, SandboxBackend, SandboxViolation } from "@coda/sandbox";
import type {
	ApprovalDecision,
	ApprovalPolicy,
	CommandRule,
	NetworkRule,
	PermissionApprovalRequest,
} from "./permission-engine.ts";

export interface PermissionPolicyAuditSnapshot {
	readonly profile: CompiledSandboxPolicy["profile"];
	readonly readAccess: CompiledSandboxPolicy["readAccess"];
	readonly deniedReadRoots: readonly string[];
	readonly writableRoots: readonly string[] | "full-disk";
	readonly protectedMetadataRoots: readonly string[];
	readonly protectedMetadataNames: readonly string[];
	readonly protectedMetadataPaths: readonly string[];
	readonly networkAccess: CompiledSandboxPolicy["networkAccess"];
}

export type PermissionAuditEvent =
	| {
			readonly type: "configuration";
			readonly source: "startup" | "permissions-command";
			readonly approvalPolicy: ApprovalPolicy;
			readonly policy: PermissionPolicyAuditSnapshot;
	  }
	| {
			readonly type: "approval_decision";
			readonly request: PermissionApprovalRequest;
			readonly decision: ApprovalDecision | { readonly type: "reviewer-failed"; readonly message: string };
	  }
	| {
			readonly type: "rule_persistence";
			readonly kind: "command" | "network";
			readonly rule: CommandRule | NetworkRule;
			readonly outcome: "persisted" | "failed";
			readonly error?: string;
	  }
	| { readonly type: "warning"; readonly message: string }
	| {
			readonly type: "sandbox_execution";
			readonly invocationId: string;
			readonly toolName: string;
			readonly policy: PermissionPolicyAuditSnapshot;
			readonly backend?: SandboxBackend;
			readonly outcome:
				| "success"
				| "normal-failure"
				| "sandbox-denial"
				| "timed-out"
				| "cancelled"
				| "launch-failed";
			readonly exitCode?: number | null;
			readonly signal?: NodeJS.Signals | null;
			readonly denial?: SandboxViolation;
			readonly error?: string;
	  };

export type PermissionAuditSink = (event: PermissionAuditEvent) => Promise<void> | void;

export function permissionPolicyAuditSnapshot(policy: Readonly<CompiledSandboxPolicy>): PermissionPolicyAuditSnapshot {
	return Object.freeze({
		profile: policy.profile,
		readAccess: policy.readAccess,
		deniedReadRoots: Object.freeze([...policy.deniedReadRoots]),
		writableRoots: policy.writableRoots === "full-disk" ? "full-disk" : Object.freeze([...policy.writableRoots]),
		protectedMetadataRoots: Object.freeze([...policy.protectedMetadataRoots]),
		protectedMetadataNames: Object.freeze([...policy.protectedMetadataNames]),
		protectedMetadataPaths: Object.freeze([...policy.protectedMetadataPaths]),
		networkAccess: policy.networkAccess,
	});
}

export function permissionConfigurationAuditEvent(
	source: "startup" | "permissions-command",
	policy: Readonly<CompiledSandboxPolicy>,
	approvalPolicy: ApprovalPolicy,
): PermissionAuditEvent {
	return Object.freeze({
		type: "configuration",
		source,
		approvalPolicy: structuredClone(approvalPolicy),
		policy: permissionPolicyAuditSnapshot(policy),
	});
}
