import { describe, expect, it } from "vitest";
import {
	commandPermissionKey,
	createCommandPermissionPolicy,
	NEVER_PROMPT_REASON,
	requestsSandboxOverride,
	WRITE_REJECTED_OUTSIDE_PROJECT_REASON,
	WRITE_REJECTED_READ_ONLY_REASON,
} from "../src/index.ts";

const workspace = "/workspace";

function request(
	toolName: string,
	toolInput: Readonly<Record<string, unknown>> = {},
	overrides: { readonly workspace?: string; readonly sessionId?: string; readonly sandboxOverride?: boolean } = {},
) {
	return {
		toolName,
		toolInput,
		sessionId: overrides.sessionId ?? "session-1",
		workspace: overrides.workspace ?? workspace,
		...(overrides.sandboxOverride === undefined ? {} : { sandboxOverride: overrides.sandboxOverride }),
	};
}

describe("Command Permission policy", () => {
	it("under untrusted allows known-safe Shell and read-only Tools, then asks before anything else", () => {
		const policy = createCommandPermissionPolicy({ approvalPolicy: "untrusted" });
		expect(policy.decide(request("read", { path: "README.md" }))).toEqual({ kind: "allow" });
		expect(policy.decide(request("grep", { pattern: "TODO" }))).toEqual({ kind: "allow" });
		expect(policy.decide(request("bash", { command: "ls" }))).toEqual({ kind: "allow" });
		expect(policy.decide(request("bash", { command: "ls && pwd" }))).toEqual({ kind: "allow" });
		expect(policy.decide(request("bash", { command: "npm test" }))).toEqual({
			kind: "ask",
			prompt: "Allow bash?\nnpm test",
		});
		expect(policy.decide(request("write", { path: "secrets.env" }))).toEqual({
			kind: "ask",
			prompt: "Allow write?\nsecrets.env",
		});
		expect(policy.decide(request("process", { action: "poll", processId: "process:1" }))).toEqual({ kind: "allow" });
		expect(policy.decide(request("process", { action: "start", command: "npm test" }))).toEqual({
			kind: "ask",
			prompt: "Allow process?\nnpm test",
		});
	});

	it("under on-request lets the sandbox enforce restricted Shell and only asks for danger or escalation", () => {
		const restricted = createCommandPermissionPolicy({
			approvalPolicy: "on-request",
			filesystemAccess: "restricted",
			writableRoots: [workspace, "/tmp"],
			denyWrite: [`${workspace}/.git`, `${workspace}/.agents`, `${workspace}/.coda`],
		});
		expect(restricted.decide(request("bash", { command: "npm test" }))).toEqual({ kind: "allow" });
		expect(restricted.decide(request("bash", { command: "rm -rf /tmp/example" }))).toEqual({
			kind: "ask",
			prompt: "Allow bash?\nrm -rf /tmp/example",
		});
		expect(
			restricted.decide(request("bash", { command: "curl example.test", sandbox_permissions: "require_escalated" })),
		).toEqual({
			kind: "ask",
			prompt: "Allow bash?\ncurl example.test",
		});
		expect(restricted.decide(request("write", { path: "src/app.ts" }))).toEqual({ kind: "allow" });
		expect(restricted.decide(request("write", { path: "/etc/passwd" }))).toEqual({
			kind: "ask",
			prompt: "Allow write?\n/etc/passwd",
		});
		expect(restricted.decide(request("write", { path: ".git/config" }))).toEqual({
			kind: "ask",
			prompt: "Allow write?\n.git/config",
		});

		const unrestricted = createCommandPermissionPolicy({
			approvalPolicy: "on-request",
			filesystemAccess: "unrestricted",
		});
		expect(unrestricted.decide(request("bash", { command: "npm test" }))).toEqual({ kind: "allow" });
		expect(unrestricted.decide(request("write", { path: "/etc/passwd" }))).toEqual({ kind: "allow" });
		expect(unrestricted.decide(request("bash", { command: "rm -rf /tmp/example" }))).toEqual({
			kind: "ask",
			prompt: "Allow bash?\nrm -rf /tmp/example",
		});
	});

	it("under never never asks: dangerous Shell and out-of-policy writes are denied", () => {
		const restricted = createCommandPermissionPolicy({
			approvalPolicy: "never",
			filesystemAccess: "restricted",
			writableRoots: [workspace, "/tmp"],
		});
		expect(restricted.decide(request("bash", { command: "npm test" }))).toEqual({ kind: "allow" });
		expect(restricted.decide(request("bash", { command: "rm -rf /tmp/example" }))).toEqual({
			kind: "deny",
			reason: NEVER_PROMPT_REASON,
		});
		expect(restricted.decide(request("write", { path: "src/app.ts" }))).toEqual({ kind: "allow" });
		expect(restricted.decide(request("write", { path: "/etc/passwd" }))).toEqual({
			kind: "deny",
			reason: WRITE_REJECTED_OUTSIDE_PROJECT_REASON,
		});

		const readOnly = createCommandPermissionPolicy({
			approvalPolicy: "never",
			filesystemAccess: "restricted",
			writableRoots: [],
		});
		expect(readOnly.decide(request("write", { path: "src/app.ts" }))).toEqual({
			kind: "deny",
			reason: WRITE_REJECTED_READ_ONLY_REASON,
		});
	});

	it("reuses a remembered allow for the same Tool input and not another Workspace", () => {
		const policy = createCommandPermissionPolicy({ approvalPolicy: "untrusted" });
		const bash = request("bash", { command: "npm test" });
		policy.remember(bash, { kind: "allow", remember: "workspace" });
		expect(policy.decide(bash)).toEqual({ kind: "allow" });
		expect(policy.decide(request("bash", { command: "npm test" }, { workspace: "/other" }))).toEqual({
			kind: "ask",
			prompt: "Allow bash?\nnpm test",
		});
		expect(commandPermissionKey(bash)).toBe('bash\0{"command":"npm test"}');
		expect(commandPermissionKey(request("Bash", { command: "npm test" }))).toBe(commandPermissionKey(bash));
	});

	it("reconfigures Approval Policy and filesystem bounds for later decisions", () => {
		const policy = createCommandPermissionPolicy({
			approvalPolicy: "untrusted",
			filesystemAccess: "unrestricted",
		});
		const write = request("write", { path: "src/app.ts" });
		expect(policy.decide(write)).toEqual({ kind: "ask", prompt: "Allow write?\nsrc/app.ts" });
		policy.configure({
			approvalPolicy: "on-request",
			filesystemAccess: "restricted",
			writableRoots: [workspace],
			denyWrite: [],
		});
		expect(policy.decide(write)).toEqual({ kind: "allow" });
		expect(policy.snapshot()).toMatchObject({
			approvalPolicy: "on-request",
			filesystemAccess: "restricted",
			writableRoots: [workspace],
		});
	});

	it("reuses a remembered deny with its reason", () => {
		const policy = createCommandPermissionPolicy({ approvalPolicy: "untrusted" });
		const bash = request("bash", { command: "curl evil.test" });
		policy.remember(bash, { kind: "deny", reason: "blocked by user", remember: "user" });
		expect(policy.decide(bash)).toEqual({ kind: "deny", reason: "blocked by user" });
	});

	it("treats quoted forced rm as dangerous instead of known-safe", () => {
		const quoted = request("bash", { command: 'echo "$(rm -rf /tmp/example)"' });
		expect(createCommandPermissionPolicy({ approvalPolicy: "untrusted" }).decide(quoted)).toEqual({
			kind: "ask",
			prompt: 'Allow bash?\necho "$(rm -rf /tmp/example)"',
		});
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "unrestricted" }).decide(
				quoted,
			),
		).toEqual({
			kind: "ask",
			prompt: 'Allow bash?\necho "$(rm -rf /tmp/example)"',
		});
		expect(createCommandPermissionPolicy({ approvalPolicy: "never" }).decide(quoted)).toEqual({
			kind: "deny",
			reason: NEVER_PROMPT_REASON,
		});
	});

	it("asks or denies in-workspace writes when restricted filesystem is not enforced", () => {
		const write = request("write", { path: "src/app.ts" });
		const onRequest = createCommandPermissionPolicy({
			approvalPolicy: "on-request",
			filesystemAccess: "restricted",
			writableRoots: [workspace],
			filesystemEnforced: false,
		});
		expect(onRequest.decide(write)).toEqual({ kind: "ask", prompt: "Allow write?\nsrc/app.ts" });
		const never = createCommandPermissionPolicy({
			approvalPolicy: "never",
			filesystemAccess: "restricted",
			writableRoots: [workspace],
			filesystemEnforced: false,
		});
		expect(never.decide(write)).toEqual({ kind: "deny", reason: WRITE_REJECTED_OUTSIDE_PROJECT_REASON });
		expect(onRequest.decide(request("bash", { command: "npm test" }))).toEqual({
			kind: "ask",
			prompt: "Allow bash?\nnpm test",
		});
		expect(never.decide(request("bash", { command: "npm test" }))).toEqual({
			kind: "deny",
			reason: NEVER_PROMPT_REASON,
		});
		expect(onRequest.decide(request("bash", { command: "ls" }))).toEqual({ kind: "allow" });
	});

	it("maps Codex sandbox_permissions wire names onto sandboxOverride", () => {
		expect(requestsSandboxOverride({ command: "curl example.test" })).toBe(false);
		expect(requestsSandboxOverride({ command: "curl example.test", sandbox_permissions: "use_default" })).toBe(false);
		expect(requestsSandboxOverride({ command: "curl example.test", sandbox_permissions: "require_escalated" })).toBe(
			true,
		);
		expect(
			requestsSandboxOverride({
				command: "curl example.test",
				sandbox_permissions: "with_additional_permissions",
			}),
		).toBe(true);
	});

	it("rejects Codex with_additional_permissions unless on-request and additional_permissions are present", () => {
		const extra = {
			command: "curl example.test",
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: { network: { enabled: true } },
		};
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", extra),
			),
		).toEqual({
			kind: "ask",
			prompt: "Allow bash?\ncurl example.test",
		});
		expect(createCommandPermissionPolicy({ approvalPolicy: "never" }).decide(request("bash", extra))).toEqual({
			kind: "deny",
			reason:
				"approval policy is Never; reject command — you cannot request additional permissions unless the approval policy is OnRequest",
		});
		expect(createCommandPermissionPolicy({ approvalPolicy: "untrusted" }).decide(request("bash", extra))).toEqual({
			kind: "deny",
			reason:
				"approval policy is UnlessTrusted; reject command — you cannot request additional permissions unless the approval policy is OnRequest",
		});
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", { command: "curl example.test", sandbox_permissions: "with_additional_permissions" }),
			),
		).toEqual({
			kind: "deny",
			reason:
				"missing `additional_permissions`; provide at least one of `network` or `file_system` when using `with_additional_permissions`",
		});
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", {
					command: "curl example.test",
					sandbox_permissions: "with_additional_permissions",
					additional_permissions: {},
				}),
			),
		).toEqual({
			kind: "deny",
			reason:
				"`additional_permissions` must include at least one requested permission in `network` or `file_system`",
		});
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", {
					command: "curl example.test",
					additional_permissions: { network: { enabled: true } },
				}),
			),
		).toEqual({
			kind: "deny",
			reason: "`additional_permissions` requires `sandbox_permissions` set to `with_additional_permissions`",
		});
	});

	it("rejects justification without sandbox_permissions and includes it on require_escalated prompts", () => {
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", { command: "ls", justification: "Allow this command" }),
			),
		).toEqual({
			kind: "deny",
			reason:
				'`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.',
		});
		expect(
			createCommandPermissionPolicy({ approvalPolicy: "on-request", filesystemAccess: "restricted" }).decide(
				request("bash", {
					command: "curl example.test",
					sandbox_permissions: "require_escalated",
					justification: "needs network",
				}),
			),
		).toEqual({
			kind: "ask",
			prompt: "Allow bash?\ncurl example.test\nneeds network",
		});
	});
});
