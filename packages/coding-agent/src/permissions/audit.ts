import type { CompiledSandboxPolicy, SandboxBackend, SandboxViolation } from "@coda/sandbox";
import { sanitizeTerminalText } from "@coda/tui";
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
	readonly readableRoots: readonly string[];
	readonly approvedReadRoots: readonly string[];
	readonly deniedReadRoots: readonly string[];
	readonly writableRoots: readonly string[] | "full-disk";
	readonly protectedMetadataRoots: readonly string[];
	readonly protectedMetadataNames: readonly string[];
	readonly protectedMetadataPaths: readonly string[];
	readonly networkAccess: CompiledSandboxPolicy["networkAccess"];
}

export type ApprovalAuditOutcome =
	| "approved-once"
	| "approved-for-process"
	| "allowed-by-process"
	| "denied"
	| "aborted"
	| "timed-out"
	| "persistent-rule"
	| "reviewer-failed";

export interface ApprovalAuditDenial {
	readonly type: "plain" | "feedback" | "reviewer-failed";
	readonly characterCount: number;
	readonly summary: string;
}

export interface ApprovalDecisionAuditEvent {
	readonly type: "approval_decision";
	readonly invocationId: string;
	readonly kind: PermissionApprovalRequest["kind"];
	readonly outcome: ApprovalAuditOutcome;
	readonly commandPrefix?: readonly string[];
	readonly denial?: ApprovalAuditDenial;
}

export interface ReadAccessAuditEvent {
	readonly type: "read_access";
	readonly invocationId: string;
	readonly toolName: string;
	readonly requestedPath: string;
	readonly canonicalPath: string;
	readonly recursive: boolean;
	readonly outcome: "allowed" | "denied";
	readonly source?: "full-access" | "readable-root" | "approved-root" | "review";
	readonly reason?: "outside-readable-roots" | "denied-read-root" | "invalid-path" | "approval-unavailable";
}

export type PermissionAuditEvent =
	| {
			readonly type: "configuration";
			readonly source: "startup" | "permissions-command";
			readonly approvalPolicy: ApprovalPolicy;
			readonly policy: PermissionPolicyAuditSnapshot;
	  }
	| ApprovalDecisionAuditEvent
	| ReadAccessAuditEvent
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

function denialAudit(type: ApprovalAuditDenial["type"], value: string): ApprovalAuditDenial {
	const sanitized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
	return Object.freeze({
		type,
		characterCount: Array.from(value).length,
		summary: Array.from(sanitized).slice(0, 160).join(""),
	});
}

export function approvalDecisionAuditEvent(
	request: PermissionApprovalRequest,
	decision: ApprovalDecision | { readonly type: "reviewer-failed"; readonly message: string },
): ApprovalDecisionAuditEvent {
	const base = {
		type: "approval_decision" as const,
		invocationId: String(request.invocationId),
		kind: request.kind,
	};
	switch (decision.type) {
		case "approved":
			return Object.freeze({ ...base, outcome: "approved-once" });
		case "approved-for-session":
			return Object.freeze({ ...base, outcome: "approved-for-process" });
		case "approved-command-prefix-for-session":
			return Object.freeze({
				...base,
				outcome: "approved-for-process",
				commandPrefix: Object.freeze([...decision.command]),
			});
		case "approved-execpolicy-amendment":
		case "network-policy-amendment":
			return Object.freeze({ ...base, outcome: "persistent-rule" });
		case "denied": {
			const type = decision.rejection === "user denied the approval request" ? "plain" : "feedback";
			return Object.freeze({ ...base, outcome: "denied", denial: denialAudit(type, decision.rejection) });
		}
		case "timed-out":
			return Object.freeze({ ...base, outcome: "timed-out" });
		case "abort":
			return Object.freeze({ ...base, outcome: "aborted" });
		case "reviewer-failed":
			return Object.freeze({
				...base,
				outcome: "reviewer-failed",
				denial: denialAudit("reviewer-failed", decision.message),
			});
	}
}

export function permissionPolicyAuditSnapshot(policy: Readonly<CompiledSandboxPolicy>): PermissionPolicyAuditSnapshot {
	return Object.freeze({
		profile: policy.profile,
		readAccess: policy.readAccess,
		readableRoots: Object.freeze([...policy.readableRoots]),
		approvedReadRoots: Object.freeze([...policy.approvedReadRoots]),
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
