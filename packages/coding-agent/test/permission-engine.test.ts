import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPolicyRequest } from "@coda/agent";
import { compileSandboxPolicy, type PermissionProfile } from "@coda/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ApprovalDecisionAuditEvent } from "../src/permissions/audit.ts";
import {
	type ApprovalDecision,
	type ApprovalPolicy,
	createPermissionEngine,
	type ExecutableIdentity,
	type PermissionApprovalRequest,
} from "../src/permissions/permission-engine.ts";
import { createWorkspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Permission Engine command matrix", () => {
	it.each<{
		name: string;
		profile: PermissionProfile;
		approvalPolicy: ApprovalPolicy;
		command: string;
		sandboxPermissions?: "require_escalated";
		expected: "sandboxed" | "unsandboxed" | "reject";
		prompts: number;
	}>([
		{
			name: "On Request runs an ordinary command in Workspace without prompting",
			profile: "workspace",
			approvalPolicy: "on-request",
			command: "npm test",
			expected: "sandboxed",
			prompts: 0,
		},
		{
			name: "On Request prompts for a dangerous command but keeps the approved command sandboxed",
			profile: "workspace",
			approvalPolicy: "on-request",
			command: "rm -rf build",
			expected: "sandboxed",
			prompts: 1,
		},
		{
			name: "Never forbids a dangerous command",
			profile: "workspace",
			approvalPolicy: "never",
			command: "rm --force build/file",
			expected: "reject",
			prompts: 0,
		},
		{
			name: "Unless Trusted auto-allows a known read-only command",
			profile: "read-only",
			approvalPolicy: "unless-trusted",
			command: "git status",
			expected: "sandboxed",
			prompts: 0,
		},
		{
			name: "Unless Trusted prompts for an unknown command",
			profile: "read-only",
			approvalPolicy: "unless-trusted",
			command: "npm test",
			expected: "sandboxed",
			prompts: 1,
		},
		{
			name: "On Request grants an explicit escalated request outside the Sandbox",
			profile: "workspace",
			approvalPolicy: "on-request",
			command: "npm publish",
			sandboxPermissions: "require_escalated",
			expected: "unsandboxed",
			prompts: 1,
		},
		{
			name: "Granular rejects a disabled Sandbox approval category",
			profile: "workspace",
			approvalPolicy: {
				mode: "granular",
				sandboxApproval: false,
				rules: true,
				skillApproval: false,
				requestPermissions: false,
				mcpElicitations: false,
			},
			command: "npm publish",
			sandboxPermissions: "require_escalated",
			expected: "reject",
			prompts: 0,
		},
		{
			name: "Full Access runs an ordinary command without an outer Sandbox",
			profile: "full-access",
			approvalPolicy: "never",
			command: "npm test",
			expected: "unsandboxed",
			prompts: 0,
		},
	])("$name", async ({ profile, approvalPolicy, command, sandboxPermissions, expected, prompts }) => {
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile,
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy,
			approval: {
				decide: async (request) => {
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const invocation = shellRequest(command, sandboxPermissions);

		const decision = await engine.check(invocation);

		expect(requests).toHaveLength(prompts);
		if (expected === "reject") {
			expect(decision.decision).toBe("reject");
			expect(engine.authorizationFor(invocation.invocationId)).toBeUndefined();
		} else {
			expect(decision).toEqual({ decision: "allow" });
			expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({ execution: expected });
			expect(engine.authorizationFor(invocation.invocationId)?.policy.profile).toBe(
				expected === "unsandboxed" ? "full-access" : profile,
			);
		}
	});

	it.each(
		(["read-only", "workspace", "full-access"] as const).flatMap((profile) =>
			(
				[
					"unless-trusted",
					"on-request",
					"never",
					{
						mode: "granular" as const,
						sandboxApproval: true,
						rules: true,
						skillApproval: true,
						requestPermissions: true,
						mcpElicitations: true,
					},
				] satisfies readonly ApprovalPolicy[]
			).flatMap((approvalPolicy) => [
				{ profile, approvalPolicy, request: "safe" as const },
				{ profile, approvalPolicy, request: "unknown" as const },
				{ profile, approvalPolicy, request: "escalated" as const },
			]),
		),
	)("covers $profile / $approvalPolicy / $request", async ({ profile, approvalPolicy, request }) => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile,
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy,
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const invocation =
			request === "safe"
				? shellRequest("git status")
				: request === "unknown"
					? shellRequest("npm test")
					: shellRequest("npm publish", "require_escalated");

		const decision = await engine.check(invocation);
		const directElevationAllowed = approvalPolicy === "on-request";
		if (request === "escalated" && !directElevationAllowed) {
			expect(decision).toMatchObject({ decision: "reject", reason: expect.stringContaining("cannot ask") });
			expect(prompts).toBe(0);
			return;
		}
		expect(decision).toEqual({ decision: "allow" });
		const expectedPrompts =
			request === "escalated"
				? profile === "full-access"
					? 0
					: 1
				: request === "unknown" && approvalPolicy === "unless-trusted"
					? 1
					: 0;
		expect(prompts).toBe(expectedPrompts);
		expect(engine.authorizationFor(invocation.invocationId)?.execution).toBe(
			profile === "full-access" || request === "escalated" ? "unsandboxed" : "sandboxed",
		);
	});
});

describe("Permission Engine command rules", () => {
	it("uses exact-program-first matching and restricts basename fallback to reviewed host executables", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
			commandRules: [{ pattern: ["git", "status"], decision: "allow" }],
			hostExecutables: [{ name: "git", paths: ["/usr/bin/git"] }],
		});
		const reviewed = shellRequest("/usr/bin/git status");
		const unreviewed = { ...shellRequest("/tmp/git status"), invocationId: "invocation:unreviewed-git" as never };

		await expect(engine.check(reviewed)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(unreviewed)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(reviewed.invocationId)).toMatchObject({ execution: "unsandboxed" });
		expect(engine.authorizationFor(unreviewed.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it("does not trust an absolute executable by basename when no host executable was reviewed", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
			commandRules: [{ pattern: ["git", "status"], decision: "allow" }],
		});
		const invocation = shellRequest("/tmp/git status");

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it.each([
		{
			name: "a forbidden rule remains a hard deny in Full Access",
			profile: "full-access" as const,
			approvalPolicy: "never" as const,
			rules: [{ pattern: ["git", "push"], decision: "forbidden" as const }],
			command: "git push origin main",
			expected: "reject",
			prompts: 0,
		},
		{
			name: "an explicit allow rule bypasses the Sandbox",
			profile: "workspace" as const,
			approvalPolicy: "on-request" as const,
			rules: [{ pattern: ["npm", "test"], decision: "allow" as const }],
			command: "npm test -- --runInBand",
			expected: "unsandboxed",
			prompts: 0,
		},
		{
			name: "the strictest matching rule wins",
			profile: "workspace" as const,
			approvalPolicy: "on-request" as const,
			rules: [
				{ pattern: ["npm"], decision: "allow" as const },
				{ pattern: ["npm", "publish"], decision: "forbidden" as const },
			],
			command: "npm publish",
			expected: "reject",
			prompts: 0,
		},
		{
			name: "Granular can reject a rule-triggered prompt independently",
			profile: "workspace" as const,
			approvalPolicy: {
				mode: "granular" as const,
				sandboxApproval: true,
				rules: false,
				skillApproval: false,
				requestPermissions: false,
				mcpElicitations: false,
			},
			rules: [{ pattern: ["npm", "publish"], decision: "prompt" as const }],
			command: "npm publish",
			expected: "reject",
			prompts: 0,
		},
	])("$name", async ({ profile, approvalPolicy, rules, command, expected, prompts }) => {
		const approvals: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile,
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy,
			commandRules: rules,
			approval: {
				decide: async (request) => {
					approvals.push(request);
					return { type: "approved" };
				},
			},
		});
		const invocation = shellRequest(command);

		const decision = await engine.check(invocation);

		expect(approvals).toHaveLength(prompts);
		if (expected === "reject") {
			expect(decision.decision).toBe("reject");
		} else {
			expect(decision).toEqual({ decision: "allow" });
			expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({ execution: expected });
			expect(engine.authorizationFor(invocation.invocationId)?.policy.profile).toBe(
				expected === "unsandboxed" ? "full-access" : profile,
			);
		}
	});
});

describe("Permission Engine multi-command rules", () => {
	it.each([
		"git status > /tmp/status.txt",
		"PATH=/tmp/attacker git status",
		"env PATH=/tmp/attacker git status",
		"command git status",
		"git status $(printf injected)",
		"git status # comment",
	])("does not let an allowed prefix bypass the Sandbox through shell syntax: %s", async (command) => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			commandRules: [{ pattern: ["git", "status"], decision: "allow" }],
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const invocation = shellRequest(command);

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it("evaluates complex syntax against the same configured shell that will execute it", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			shellExecutable: "/bin/zsh",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			commandRules: [
				{ pattern: ["/bin/zsh", "-c"], decision: "forbidden", justification: "complex zsh is blocked" },
			],
			approval: { decide: async () => ({ type: "approved" }) },
		});

		await expect(engine.check(shellRequest("git status > /tmp/status.txt"))).resolves.toEqual({
			decision: "reject",
			reason: "complex zsh is blocked",
		});
	});

	it("requires every parsed shell segment to be explicitly allowed before bypassing the Sandbox", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			commandRules: [{ pattern: ["git", "status"], decision: "allow" }],
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const mixed = shellRequest("git status && printf escaped > /outside.txt");

		await expect(engine.check(mixed)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(mixed.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it("applies a forbidden rule to any parsed shell segment", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			commandRules: [{ pattern: ["git", "push"], decision: "forbidden", justification: "push is blocked" }],
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const mixed = shellRequest("printf ready; git push origin main");

		await expect(engine.check(mixed)).resolves.toEqual({ decision: "reject", reason: "push is blocked" });
	});

	it.each([
		"git push origin main > /tmp/out",
		"sh -c 'git push origin main'",
		"printf '%s' \"$(git push origin main)\"",
	])("applies forbidden rules to literal commands nested in complex Shell syntax: %s", async (command) => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			commandRules: [{ pattern: ["git", "push"], decision: "forbidden", justification: "push is blocked" }],
			approval: { decide: async () => ({ type: "approved" }) },
		});

		await expect(engine.check(shellRequest(command))).resolves.toEqual({
			decision: "reject",
			reason: "push is blocked",
		});
	});

	it.each(["printf ready > /tmp/out", 'printf "%s" "$PWD"'])(
		"prompts for unclassified complex Shell syntax under On Request: %s",
		async (command) => {
			const approvals: PermissionApprovalRequest[] = [];
			const engine = createPermissionEngine({
				cwd: "/workspace",
				profile: compileSandboxPolicy({
					profile: "workspace",
					workspaceRoots: ["/workspace"],
					temporaryDirectory: "/tmp",
				}),
				approvalPolicy: "on-request",
				approval: {
					decide: async (request) => {
						approvals.push(request);
						return { type: "approved" };
					},
				},
			});
			const invocation = shellRequest(command);

			await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
			expect(approvals).toHaveLength(1);
			expect(approvals[0]).toMatchObject({
				kind: "command",
				reason: "complex Shell command could not be classified safely",
			});
		},
	);

	it("rejects unclassified complex Shell syntax under Never", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});

		await expect(engine.check(shellRequest("printf ready > /tmp/out"))).resolves.toEqual({
			decision: "reject",
			reason: "complex Shell command requires interactive approval; approval policy is never",
		});
		expect(prompts).toBe(0);
	});

	it.each([
		"sh -c 'rm -rf build'",
		"printf '%s' \"$(rm --force build/file)\"",
		"printf x | rm -rf build",
		"if test -d build; then rm --force build/file; fi",
		'rm -rf "$TARGET" >/dev/null',
		'for target in build/a build/b; do rm -r -f "$target"; done',
	])("detects dangerous commands nested in shell syntax under Never: %s", async (command) => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			approval: { decide: async () => ({ type: "approved" }) },
		});

		await expect(engine.check(shellRequest(command))).resolves.toMatchObject({ decision: "reject" });
	});

	it.each(["sudo rm -rf build", "env TARGET=build rm --force build/file", "trap 'rm -rf build' EXIT"])(
		"detects Codex dangerous-command wrappers under Never: %s",
		async (command) => {
			const engine = createPermissionEngine({
				cwd: "/workspace",
				profile: compileSandboxPolicy({
					profile: "full-access",
					workspaceRoots: ["/workspace"],
					temporaryDirectory: "/tmp",
				}),
				approvalPolicy: "never",
				approval: { decide: async () => ({ type: "approved" }) },
			});

			await expect(engine.check(shellRequest(command))).resolves.toMatchObject({ decision: "reject" });
		},
	);

	it("does not treat an operand after rm -- as a force option", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			approval: { decide: async () => ({ type: "approved" }) },
		});

		await expect(engine.check(shellRequest("rm -- -f"))).resolves.toEqual({ decision: "allow" });
	});

	it.each([
		"git log --output=/tmp/log",
		"base64 --output=/tmp/data input",
		"find . -delete",
		"rg --pre attacker pattern",
		"echo changed > /tmp/output",
	])("does not auto-trust a command with a write or subprocess escape: %s", async (command) => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "unless-trusted",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});

		await expect(engine.check(shellRequest(command))).resolves.toEqual({ decision: "allow" });
		expect(prompts).toBe(1);
	});
});

describe("Permission Engine approval memory", () => {
	it("reuses and exposes a reviewed command prefix only for this process", async () => {
		let prompts = 0;
		const reuseAudits: ApprovalDecisionAuditEvent[] = [];
		const executable: ExecutableIdentity = {
			path: "/usr/local/bin/npm",
			device: "1",
			inode: "42",
			size: 512,
			modifiedAt: 1_000,
		};
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			onSessionApprovalUsed: (event) => {
				reuseAudits.push(event);
			},
			resolveExecutable: async ({ executable: name, cwd }) => {
				expect(name).toBe("npm");
				expect(cwd).toBe("/workspace");
				return executable;
			},
			approval: {
				decide: async (request) => {
					prompts++;
					return prompts === 1
						? { type: "approved-command-prefix-for-session", command: request.proposedSessionCommandRule! }
						: { type: "denied", rejection: "grant was revoked" };
				},
			},
		});
		const first = {
			...shellRequest("npm publish --tag next", "require_escalated"),
			arguments: {
				command: "npm publish --tag next",
				sandbox_permissions: "require_escalated",
				justification: "publish the prerelease",
				prefix_rule: ["npm", "publish"],
			},
		};
		const second = {
			...shellRequest("npm publish --tag latest", "require_escalated"),
			invocationId: "invocation:second-prefix-use" as never,
		};

		await expect(engine.check(first)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(second)).resolves.toEqual({ decision: "allow" });
		expect(prompts).toBe(1);
		expect(engine.approvalFor(first.invocationId)).toMatchObject({
			outcome: "approved-for-process",
			commandPrefix: ["npm", "publish"],
		});
		expect(engine.approvalFor(second.invocationId)).toMatchObject({
			outcome: "allowed-by-process",
			commandPrefix: ["npm", "publish"],
		});
		expect(reuseAudits).toEqual([engine.approvalFor(second.invocationId)]);
		expect(engine.listSessionApprovals()).toEqual([
			expect.objectContaining({
				id: "command-session-approval:1",
				command: ["npm", "publish"],
				environmentId: "local",
				cwd: "/workspace",
				shellExecutable: "/bin/sh",
				sandboxPermissions: "require_escalated",
				executable,
			}),
		]);

		expect(engine.revokeSessionApproval("command-session-approval:1")).toBe(true);
		expect(engine.listSessionApprovals()).toEqual([]);
		const afterRevoke = {
			...shellRequest("npm publish --tag stable", "require_escalated"),
			invocationId: "invocation:after-prefix-revoke" as never,
		};
		await expect(engine.check(afterRevoke)).resolves.toEqual({ decision: "reject", reason: "grant was revoked" });
		expect(prompts).toBe(2);
	});

	it("revokes a command prefix approval when the resolved executable identity drifts", async () => {
		const warnings: string[] = [];
		let prompts = 0;
		let executable: ExecutableIdentity = {
			path: "/usr/local/bin/npm",
			device: "1",
			inode: "42",
			size: 512,
			modifiedAt: 1_000,
		};
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			resolveExecutable: async () => executable,
			onWarning: (warning) => {
				warnings.push(warning);
			},
			approval: {
				decide: async (request) => {
					prompts++;
					return prompts === 1
						? { type: "approved-command-prefix-for-session", command: request.proposedSessionCommandRule! }
						: { type: "denied", rejection: "executable changed" };
				},
			},
		});
		const first = {
			...shellRequest("npm publish", "require_escalated"),
			arguments: {
				command: "npm publish",
				sandbox_permissions: "require_escalated",
				justification: "publish",
				prefix_rule: ["npm", "publish"],
			},
		};

		await expect(engine.check(first)).resolves.toEqual({ decision: "allow" });
		executable = { ...executable, inode: "99", modifiedAt: 2_000 };
		const second = {
			...shellRequest("npm publish --tag latest", "require_escalated"),
			invocationId: "invocation:identity-drift" as never,
		};
		await expect(engine.check(second)).resolves.toEqual({ decision: "reject", reason: "executable changed" });

		expect(prompts).toBe(2);
		expect(engine.listSessionApprovals()).toEqual([]);
		expect(warnings).toEqual(["Revoked Session Approval for npm publish because the executable identity changed"]);
	});

	it("revokes every command Session Approval when the Permission configuration changes", async () => {
		const workspaceProfile = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/tmp",
		});
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: workspaceProfile,
			approvalPolicy: "on-request",
			resolveExecutable: async () => ({
				path: "/usr/local/bin/npm",
				device: "1",
				inode: "42",
				size: 512,
				modifiedAt: 1_000,
			}),
			approval: {
				decide: async (request) => ({
					type: "approved-command-prefix-for-session",
					command: request.proposedSessionCommandRule!,
				}),
			},
		});
		const request = {
			...shellRequest("npm publish", "require_escalated"),
			arguments: {
				command: "npm publish",
				sandbox_permissions: "require_escalated",
				justification: "publish",
				prefix_rule: ["npm", "publish"],
			},
		};

		await engine.check(request);
		expect(engine.listSessionApprovals()).toHaveLength(1);
		engine.update({
			profile: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
		});
		expect(engine.listSessionApprovals()).toEqual([]);
	});

	it.each<{
		name: string;
		review: ApprovalDecision;
		reason: string;
		aborted: boolean;
	}>([
		{
			name: "denial",
			review: { type: "denied", rejection: "use a safer release path" },
			reason: "use a safer release path",
			aborted: false,
		},
		{
			name: "timeout",
			review: { type: "timed-out" },
			reason: "approval request timed out",
			aborted: false,
		},
		{
			name: "abort",
			review: { type: "abort" },
			reason: "approval request aborted",
			aborted: true,
		},
	])("keeps approval $name distinct at the Policy Gate", async ({ review, reason, aborted }) => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => review },
		});
		const request = shellRequest("npm publish", "require_escalated");

		await expect(engine.check(request)).resolves.toEqual({ decision: "reject", reason });
		expect(engine.consumeAbort(request.invocationId)).toBe(aborted);
		expect(engine.consumeAbort(request.invocationId)).toBe(false);
		expect(engine.authorizationFor(request.invocationId)).toBeUndefined();
	});

	it("reuses only an exact process-local Session approval", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-for-session" };
				},
			},
		});
		const first = shellRequest("npm publish", "require_escalated");
		const second = {
			...shellRequest("npm publish", "require_escalated"),
			invocationId: "invocation:second" as never,
		};

		await expect(engine.check(first)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(second)).resolves.toEqual({ decision: "allow" });

		expect(prompts).toBe(1);
		expect(engine.authorizationFor(second.invocationId)).toMatchObject({ execution: "unsandboxed" });
	});

	it("does not reuse a Session approval across shell scripts with different quoted semantics", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return prompts === 1
						? { type: "approved-for-session" }
						: { type: "denied", rejection: "second script was not approved" };
				},
			},
		});

		await expect(engine.check(shellRequest("echo '$HOME' > /tmp/value", "require_escalated"))).resolves.toEqual({
			decision: "allow",
		});
		await expect(engine.check(shellRequest('echo "$HOME" > /tmp/value', "require_escalated"))).resolves.toEqual({
			decision: "reject",
			reason: "second script was not approved",
		});

		expect(prompts).toBe(2);
	});

	it("continues the approved command when persistence fails but does not install the rule", async () => {
		let prompts = 0;
		const warnings: string[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "unless-trusted",
			persistCommandRule: async () => {
				throw new Error("disk full");
			},
			onWarning: (warning) => {
				warnings.push(warning);
			},
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-execpolicy-amendment", command: ["npm", "publish"] };
				},
			},
		});
		const first = {
			...shellRequest("npm publish"),
			arguments: { command: "npm publish", prefix_rule: ["npm", "publish"] },
		};
		const second = {
			...shellRequest("npm publish"),
			invocationId: "invocation:again" as never,
			arguments: { command: "npm publish", prefix_rule: ["npm", "publish"] },
		};

		await expect(engine.check(first)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(second)).resolves.toEqual({ decision: "allow" });

		expect(prompts).toBe(2);
		expect(warnings).toEqual([
			"Could not persist Command Rule for npm publish: disk full",
			"Could not persist Command Rule for npm publish: disk full",
		]);
		expect(engine.authorizationFor(first.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it("keeps a command approval when both persistence and warning presentation fail", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "unless-trusted",
			persistCommandRule: async () => {
				throw new Error("disk full");
			},
			onWarning: () => {
				throw new Error("warning sink failed");
			},
			approval: {
				decide: async () => ({ type: "approved-execpolicy-amendment", command: ["npm", "publish"] }),
			},
		});
		const invocation = {
			...shellRequest("npm publish"),
			arguments: { command: "npm publish", prefix_rule: ["npm", "publish"] },
		};

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({ execution: "sandboxed" });
	});

	it("installs a persisted allow rule for later matching commands", async () => {
		const persisted: unknown[] = [];
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "unless-trusted",
			persistCommandRule: async (rule) => {
				persisted.push(rule);
			},
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-execpolicy-amendment", command: ["npm", "publish"] };
				},
			},
		});
		const first = {
			...shellRequest("npm publish"),
			arguments: { command: "npm publish", prefix_rule: ["npm", "publish"] },
		};
		const second = { ...shellRequest("npm publish --tag next"), invocationId: "invocation:later" as never };

		await engine.check(first);
		await engine.check(second);

		expect(prompts).toBe(1);
		expect(persisted).toEqual([{ pattern: ["npm", "publish"], decision: "allow" }]);
		expect(engine.authorizationFor(first.invocationId)).toMatchObject({ execution: "sandboxed" });
		expect(engine.authorizationFor(second.invocationId)).toMatchObject({ execution: "unsandboxed" });
	});
});

describe("Permission Engine managed network", () => {
	it("keys Session host approvals by environment, lowercase host, protocol, and port", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-for-session" };
				},
			},
		});
		const invocation = shellRequest("curl https://example.com");
		await engine.check(invocation);
		const network = engine.authorizationFor(invocation.invocationId)?.managedNetwork;
		if (!network) throw new Error("expected managed network policy");

		await expect(
			network.decide({ environmentId: "local", host: "EXAMPLE.COM", protocol: "https", port: 443 }),
		).resolves.toMatchObject({ action: "allow" });
		await expect(
			network.decide({ environmentId: "local", host: "example.com", protocol: "https", port: 443 }),
		).resolves.toMatchObject({ action: "allow", source: "session" });
		await expect(
			network.decide({ environmentId: "local", host: "example.com", protocol: "https", port: 8443 }),
		).resolves.toMatchObject({ action: "allow" });

		expect(prompts).toBe(2);
	});

	it("does not share an allow-once host decision across concurrent executions", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const first = shellRequest("curl https://example.com");
		const second = {
			...shellRequest("curl https://example.com"),
			invocationId: "invocation:second-network-execution" as never,
		};
		await Promise.all([engine.check(first), engine.check(second)]);
		const firstNetwork = engine.authorizationFor(first.invocationId)?.managedNetwork;
		const secondNetwork = engine.authorizationFor(second.invocationId)?.managedNetwork;
		if (!firstNetwork || !secondNetwork) throw new Error("expected managed network policies");
		const destination = { environmentId: "local", host: "example.com", protocol: "https" as const, port: 443 };

		await expect(
			Promise.all([
				firstNetwork.decide(destination),
				firstNetwork.decide(destination),
				secondNetwork.decide(destination),
			]),
		).resolves.toEqual([
			{ action: "allow", source: "user" },
			{ action: "allow", source: "user" },
			{ action: "allow", source: "user" },
		]);
		expect(prompts).toBe(2);
	});

	it("Never denies an unlisted host without contacting the reviewer", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const invocation = shellRequest("curl https://example.com");
		await engine.check(invocation);
		const network = engine.authorizationFor(invocation.invocationId)?.managedNetwork;
		if (!network) throw new Error("expected managed network policy");

		await expect(
			network.decide({ environmentId: "local", host: "example.com", protocol: "https", port: 443 }),
		).resolves.toEqual({ action: "deny", source: "policy", reason: "approval policy is never" });
		expect(prompts).toBe(0);
	});

	it("allows managed-network review under Granular independently of request_permissions", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: {
				mode: "granular",
				sandboxApproval: false,
				rules: false,
				skillApproval: false,
				requestPermissions: false,
				mcpElicitations: false,
			},
			approval: {
				decide: async (request) => {
					expect(request.kind).toBe("network");
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const invocation = shellRequest("curl https://example.com");
		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		const network = engine.authorizationFor(invocation.invocationId)?.managedNetwork;
		if (!network) throw new Error("expected managed network policy");

		await expect(
			network.decide({ environmentId: "local", host: "example.com", protocol: "https", port: 443 }),
		).resolves.toEqual({ action: "allow", source: "user" });
		expect(prompts).toBe(1);
	});

	it("persists a host rule, warns on persistence failure, and still honors the current approval", async () => {
		const warnings: string[] = [];
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			persistNetworkRule: async () => {
				throw new Error("read-only settings");
			},
			onWarning: (warning) => {
				warnings.push(warning);
			},
			approval: {
				decide: async () => {
					prompts++;
					return { type: "network-policy-amendment", host: "example.com", action: "allow" };
				},
			},
		});
		const invocation = shellRequest("curl https://example.com");
		await engine.check(invocation);
		const network = engine.authorizationFor(invocation.invocationId)?.managedNetwork;
		if (!network) throw new Error("expected managed network policy");
		const destination = { environmentId: "local", host: "example.com", protocol: "https" as const, port: 443 };

		await expect(network.decide(destination)).resolves.toMatchObject({ action: "allow" });
		await expect(network.decide(destination)).resolves.toMatchObject({ action: "allow" });

		expect(prompts).toBe(2);
		expect(warnings).toEqual([
			"Could not persist Network Rule for example.com: read-only settings",
			"Could not persist Network Rule for example.com: read-only settings",
		]);
	});

	it("keeps a network approval when both persistence and warning presentation fail", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			persistNetworkRule: async () => {
				throw new Error("read-only settings");
			},
			onWarning: () => {
				throw new Error("warning sink failed");
			},
			approval: {
				decide: async () => ({ type: "network-policy-amendment", host: "example.com", action: "allow" }),
			},
		});
		const invocation = shellRequest("curl https://example.com");
		await engine.check(invocation);
		const network = engine.authorizationFor(invocation.invocationId)?.managedNetwork;
		if (!network) throw new Error("expected managed network policy");

		await expect(
			network.decide({ environmentId: "local", host: "example.com", protocol: "https", port: 443 }),
		).resolves.toMatchObject({ action: "allow", source: "user" });
	});
});

describe("Permission Engine model escalation protocol", () => {
	it("canonicalizes reviewed additional roots before prompting or granting them", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-additional-root-"));
		temporaryDirectories.push(fixture);
		const workspaceRoot = join(fixture, "workspace");
		const cacheRoot = join(fixture, "cache");
		await mkdir(workspaceRoot);
		await mkdir(cacheRoot);
		await symlink(cacheRoot, join(workspaceRoot, "cache-alias"));
		const workspace = await createWorkspace(workspaceRoot, createNodeFileSystem());
		const canonicalCache = await realpath(cacheRoot);
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: [workspace.root],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async (request) => {
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const alias = "cache-alias";
		const invocation = {
			...shellRequest("npm install"),
			arguments: {
				command: "npm install",
				sandbox_permissions: "with_additional_permissions",
				justification: "Use the reviewed cache root",
				additional_permissions: {
					file_system: { write: [alias] },
				},
			},
		};

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		expect(requests[0]?.additionalPermissions?.file_system?.write).toEqual([canonicalCache]);
		const policy = engine.authorizationFor(invocation.invocationId)?.policy;
		expect(policy?.writableRoots).toEqual([canonicalCache]);
		expect(policy?.protectedMetadataRoots).toEqual([canonicalCache]);
		expect(policy?.protectedMetadataPaths).toContain(join(canonicalCache, ".git"));
	});

	it("applies only the reviewed additional filesystem and network permissions", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const invocation = {
			...shellRequest("npm install"),
			arguments: {
				command: "npm install",
				sandbox_permissions: "with_additional_permissions",
				justification: "Dependency installation needs one cache root and the registry",
				additional_permissions: {
					network: { enabled: true },
					file_system: { write: ["/cache/npm"] },
				},
			},
		};

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		const authorization = engine.authorizationFor(invocation.invocationId);
		expect(authorization).toMatchObject({
			execution: "sandboxed",
			policy: { profile: "read-only", networkAccess: "enabled", writableRoots: ["/cache/npm"] },
		});
		expect(authorization?.managedNetwork).toBeUndefined();
	});

	it("preserves reviewed read roots without exposing internal deny entries", async () => {
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const invocation = {
			...shellRequest("cat /shared/input"),
			arguments: {
				command: "cat /shared/input",
				sandbox_permissions: "with_additional_permissions",
				justification: "Read the reviewed input root",
				additional_permissions: {
					file_system: { read: ["/shared"] },
				},
			},
		};

		await expect(engine.check(invocation)).resolves.toEqual({ decision: "allow" });
		expect(engine.authorizationFor(invocation.invocationId)).toMatchObject({
			execution: "sandboxed",
			additionalPermissions: { file_system: { read: ["/shared"] } },
			policy: { profile: "read-only", deniedReadRoots: [] },
		});
	});

	it("rejects an empty additional permission request before review", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const invocation = {
			...shellRequest("true"),
			arguments: {
				command: "true",
				sandbox_permissions: "with_additional_permissions",
				justification: "empty request",
				additional_permissions: { file_system: { read: [], write: [] } },
			},
		};

		await expect(engine.check(invocation)).resolves.toMatchObject({ decision: "reject" });
		expect(prompts).toBe(0);
	});

	it("rejects malformed additional permissions but ignores an unusable prefix proposal", async () => {
		let prompts = 0;
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async (request) => {
					prompts++;
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const legacyShape = {
			...shellRequest("npm install"),
			arguments: {
				command: "npm install",
				sandbox_permissions: "with_additional_permissions",
				justification: "needs cache",
				additional_permissions: { fileSystem: { entries: [{ path: "/cache", access: "write" }] } },
			},
		};
		const broadPrefix = {
			...shellRequest("npm publish", "require_escalated"),
			invocationId: "invocation:broad-prefix" as never,
			arguments: {
				command: "npm publish",
				sandbox_permissions: "require_escalated",
				justification: "publish",
				prefix_rule: ["git", "push"],
			},
		};

		await expect(engine.check(legacyShape)).resolves.toMatchObject({ decision: "reject" });
		await expect(engine.check(broadPrefix)).resolves.toEqual({ decision: "allow" });
		expect(prompts).toBe(1);
		expect(requests[0]?.proposedCommandRule).toBeUndefined();
		expect(engine.authorizationFor(broadPrefix.invocationId)).toMatchObject({ execution: "unsandboxed" });
	});

	it("never offers a prefix grant for a pipeline even when every command shares the proposed prefix", async () => {
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			resolveExecutable: async () => ({
				path: "/usr/local/bin/npm",
				device: "1",
				inode: "42",
				size: 512,
				modifiedAt: 1_000,
			}),
			approval: {
				decide: async (request) => {
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const pipeline = {
			...shellRequest("npm test | npm run summarize", "require_escalated"),
			arguments: {
				command: "npm test | npm run summarize",
				sandbox_permissions: "require_escalated",
				justification: "run and summarize",
				prefix_rule: ["npm"],
			},
		};

		await expect(engine.check(pipeline)).resolves.toEqual({ decision: "allow" });
		expect(requests[0]?.proposedCommandRule).toBeUndefined();
		expect(requests[0]?.proposedSessionCommandRule).toBeUndefined();
	});

	it("accepts empty or omitted justification with an explicit sandbox override", async () => {
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async (request) => {
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const empty = {
			...shellRequest("npm publish", "require_escalated"),
			arguments: { command: "npm publish", sandbox_permissions: "require_escalated", justification: "" },
		};
		const omitted = {
			...shellRequest("npm publish", "require_escalated"),
			invocationId: "invocation:omitted-justification" as never,
			arguments: { command: "npm publish", sandbox_permissions: "require_escalated" },
		};

		await expect(engine.check(empty)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(omitted)).resolves.toEqual({ decision: "allow" });
		expect(requests.map((request) => request.justification)).toEqual(["", undefined]);
	});

	it("requires sandbox_permissions whenever justification is present", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});

		await expect(
			engine.check({ ...shellRequest("true"), arguments: { command: "true", justification: "because" } }),
		).resolves.toMatchObject({
			decision: "reject",
			reason: expect.stringContaining("requires an explicit `sandbox_permissions`"),
		});
		expect(prompts).toBe(0);
	});

	it("applies a process-local permissions update only to future invocations", async () => {
		const workspaceProfile = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/tmp",
		});
		const fullAccessProfile = compileSandboxPolicy({
			profile: "full-access",
			workspaceRoots: ["/workspace"],
			temporaryDirectory: "/tmp",
		});
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: workspaceProfile,
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const before = shellRequest("npm test");
		await engine.check(before);

		engine.update({ profile: fullAccessProfile, approvalPolicy: "never" });
		const after = { ...shellRequest("npm test"), invocationId: "invocation:after-update" as never };
		await engine.check(after);

		expect(engine.authorizationFor(before.invocationId)).toMatchObject({ execution: "sandboxed" });
		expect(engine.authorizationFor(after.invocationId)).toMatchObject({ execution: "unsandboxed" });
		expect(engine.configuration()).toEqual({ profile: fullAccessProfile, approvalPolicy: "never" });
	});
});

describe("Permission Engine generic approval protocol", () => {
	it("shares Granular categories, exact Session memory, and abort semantics with future skill and MCP callers", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: {
				mode: "granular",
				sandboxApproval: true,
				rules: true,
				skillApproval: true,
				requestPermissions: true,
				mcpElicitations: false,
			},
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-for-session" };
				},
			},
		});
		const request = {
			kind: "skill" as const,
			runId: "run-1" as never,
			turnId: "turn-1" as never,
			invocationId: "skill-1" as never,
			reason: "load a declared Skill",
			toolName: "skill.load",
		};

		await expect(engine.requestGenericApproval(request)).resolves.toEqual({ decision: "allow" });
		await expect(engine.requestGenericApproval({ ...request, invocationId: "skill-2" as never })).resolves.toEqual({
			decision: "allow",
		});
		await expect(
			engine.requestGenericApproval({ ...request, kind: "mcp", invocationId: "mcp-1" as never }),
		).resolves.toMatchObject({ decision: "reject" });
		expect(prompts).toBe(1);
	});

	it("routes a model Skill Tool through exact revision-bound Session approval", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved-for-session" };
				},
			},
			genericApprovalForTool: (request) =>
				request.toolName === "skill"
					? {
							kind: "skill",
							reason: `activate ${String(request.arguments.skill)} at ${String(request.arguments.revision)}`,
						}
					: undefined,
		});
		const request = {
			runId: "run-1" as never,
			turnId: "turn-1" as never,
			invocationId: "skill-1" as never,
			resultMessageId: "result-1" as never,
			providerToolCallId: "provider-1",
			toolName: "skill",
			arguments: { skill: "skill:a", revision: "revision-1" },
			replaySafety: "safe" as const,
		};

		await expect(engine.check(request)).resolves.toEqual({ decision: "allow" });
		await expect(
			engine.check({ ...request, invocationId: "skill-2" as never, resultMessageId: "result-2" as never }),
		).resolves.toEqual({ decision: "allow" });
		await expect(
			engine.check({
				...request,
				invocationId: "skill-3" as never,
				resultMessageId: "result-3" as never,
				arguments: { skill: "skill:a", revision: "revision-2" },
			}),
		).resolves.toEqual({ decision: "allow" });
		expect(prompts).toBe(2);
	});

	it("rejects autonomous Skill Tool activation under Approval Policy never", async () => {
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: "/workspace",
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: ["/workspace"],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "never",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
			genericApprovalForTool: (request) =>
				request.toolName === "skill" ? { kind: "skill", reason: "activate exact revision" } : undefined,
		});

		await expect(
			engine.check({
				runId: "run-1" as never,
				turnId: "turn-1" as never,
				invocationId: "skill-1" as never,
				resultMessageId: "result-1" as never,
				providerToolCallId: "provider-1",
				toolName: "skill",
				arguments: { skill: "skill:a" },
				replaySafety: "safe",
			}),
		).resolves.toEqual({ decision: "reject", reason: "approval policy is never" });
		expect(prompts).toBe(0);
	});
});

describe("Permission Engine filesystem matrix", () => {
	it("allows full-disk reads without secret-name exceptions", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-permission-files-"));
		temporaryDirectories.push(fixture);
		const root = join(fixture, "workspace");
		await mkdir(join(root, ".ssh"), { recursive: true });
		await writeFile(join(root, ".env"), "VISIBLE_TO_MODEL=yes\n");
		await writeFile(join(root, ".ssh", "id_ed25519"), "also-readable\n");
		const outside = join(fixture, "outside.txt");
		await writeFile(outside, "outside-readable\n");
		const workspace = await createWorkspace(root, createNodeFileSystem());
		let prompts = 0;
		const engine = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: [workspace.root],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});

		for (const [index, path] of [".env", ".ssh/id_ed25519", outside].entries()) {
			await expect(engine.check(fileRequest("read", path, index))).resolves.toEqual({ decision: "allow" });
		}
		expect(prompts).toBe(0);
	});

	it.each([
		{
			profile: "read-only" as const,
			approvalPolicy: "on-request" as const,
			path: "ordinary.txt",
			prompts: 1,
			allowed: true,
		},
		{
			profile: "workspace" as const,
			approvalPolicy: "on-request" as const,
			path: "ordinary.txt",
			prompts: 0,
			allowed: true,
		},
		{
			profile: "workspace" as const,
			approvalPolicy: "on-request" as const,
			path: ".git/config",
			prompts: 1,
			allowed: true,
		},
		{
			profile: "workspace" as const,
			approvalPolicy: "never" as const,
			path: ".coda/state",
			prompts: 0,
			allowed: false,
		},
		{
			profile: "full-access" as const,
			approvalPolicy: "never" as const,
			path: ".git/config",
			prompts: 0,
			allowed: true,
		},
	])(
		"resolves $profile / $approvalPolicy write authority for $path",
		async ({ profile, approvalPolicy, path, prompts, allowed }) => {
			const root = await mkdtemp(join(tmpdir(), "coda-permission-write-"));
			temporaryDirectories.push(root);
			const workspace = await createWorkspace(root, createNodeFileSystem());
			let promptCount = 0;
			const engine = createPermissionEngine({
				cwd: workspace.root,
				workspace,
				profile: compileSandboxPolicy({
					profile,
					workspaceRoots: [workspace.root],
					temporaryDirectory: "/tmp",
				}),
				approvalPolicy,
				approval: {
					decide: async () => {
						promptCount++;
						return { type: "approved" };
					},
				},
			});

			const decision = await engine.check(fileRequest("write", path, 1));

			expect(promptCount).toBe(prompts);
			expect(decision.decision).toBe(allowed ? "allow" : "reject");
		},
	);

	it("creates an invocation-scoped outer Sandbox grant for an approved exact mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-permission-exact-write-"));
		temporaryDirectories.push(root);
		const workspace = await createWorkspace(root, createNodeFileSystem());
		const engine = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: [workspace.root],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const request = fileRequest("write", ".git/config", 8);

		await expect(engine.check(request)).resolves.toEqual({ decision: "allow" });
		const policy = engine.sandboxPolicyFor(request.invocationId);
		expect(policy?.writableRoots).toContain(join(workspace.root, ".git"));
		expect(policy?.protectedMetadataRoots).not.toContain(workspace.root);
		expect(engine.configuration().profile.protectedMetadataRoots).toContain(workspace.root);
	});

	it("protects both a metadata symlink and its canonical target from unapproved file tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-permission-metadata-link-"));
		temporaryDirectories.push(root);
		const metadataTarget = join(root, "git-metadata-target");
		await mkdir(metadataTarget);
		await symlink(metadataTarget, join(root, ".git"));
		const workspace = await createWorkspace(root, createNodeFileSystem());
		const protectedAlias = join(workspace.root, ".git");
		const canonicalMetadataTarget = await realpath(metadataTarget);
		const requests: PermissionApprovalRequest[] = [];
		const engine = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: [workspace.root],
				temporaryDirectory: "/tmp",
			}),
			approvalPolicy: "on-request",
			approval: {
				decide: async (request) => {
					requests.push(request);
					return { type: "approved" };
				},
			},
		});
		const aliasRequest = fileRequest("write", ".git/config", 10);
		const targetRequest = fileRequest("write", "git-metadata-target/config", 11);

		await expect(engine.check(aliasRequest)).resolves.toEqual({ decision: "allow" });
		await expect(engine.check(targetRequest)).resolves.toEqual({ decision: "allow" });

		expect(requests).toHaveLength(2);
		expect(requests).toEqual([
			expect.objectContaining({ kind: "filesystem", reason: expect.stringContaining("protected metadata") }),
			expect.objectContaining({ kind: "filesystem", reason: expect.stringContaining("protected metadata") }),
		]);
		for (const request of [aliasRequest, targetRequest]) {
			const policy = engine.sandboxPolicyFor(request.invocationId);
			expect(policy?.protectedMetadataPaths).not.toContain(protectedAlias);
			expect(policy?.protectedMetadataPaths).not.toContain(canonicalMetadataTarget);
		}
	});
});

function shellRequest(command: string, sandboxPermissions?: "require_escalated"): ToolPolicyRequest {
	return {
		runId: "run-1" as ToolPolicyRequest["runId"],
		turnId: "turn-1" as ToolPolicyRequest["turnId"],
		invocationId: `invocation:${command}` as ToolPolicyRequest["invocationId"],
		resultMessageId: "message-1" as ToolPolicyRequest["resultMessageId"],
		providerToolCallId: "provider-call-1",
		toolName: "bash",
		arguments: {
			command,
			...(sandboxPermissions
				? { sandbox_permissions: sandboxPermissions, justification: "The command needs host authority" }
				: {}),
		},
		replaySafety: "never",
	};
}

function fileRequest(intent: "read" | "write", path: string, index: number): ToolPolicyRequest {
	return {
		runId: "run-1" as ToolPolicyRequest["runId"],
		turnId: "turn-1" as ToolPolicyRequest["turnId"],
		invocationId: `file:${intent}:${index}` as ToolPolicyRequest["invocationId"],
		resultMessageId: `message:file:${index}` as ToolPolicyRequest["resultMessageId"],
		providerToolCallId: `provider-file-${index}`,
		toolName: intent === "read" ? "read" : "write",
		arguments: intent === "read" ? { path } : { path, content: "updated\n" },
		replaySafety: intent === "read" ? "safe" : "never",
	};
}
