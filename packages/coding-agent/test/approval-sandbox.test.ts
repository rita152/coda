import { createCommandPermissionPolicy } from "@coda/permission";
import type { ProcessConfinement, ProcessConfinementEngine } from "@coda/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
	applyPermissionPreset,
	commandPermissionOptionsFor,
	createLiveWrapScript,
	createPermissionsCommand,
	replaceProcessConfinement,
	resolveApprovalPolicy,
	resolveSandboxMode,
	settingsAfterPermissionPreset,
} from "../src/app/approval-sandbox.ts";
import { PERMISSION_PRESETS } from "../src/commands/permissions-flow.ts";

describe("approval and sandbox resolution", () => {
	it("maps CLI, legacy enabled flags, and Codex defaults", () => {
		expect(resolveApprovalPolicy({})).toBe("on-request");
		expect(resolveApprovalPolicy({ settings: { enabled: true } })).toBe("untrusted");
		expect(resolveApprovalPolicy({ settings: { enabled: false } })).toBe("never");
		expect(resolveApprovalPolicy({ settings: { approvalPolicy: "never", enabled: true } })).toBe("never");
		expect(resolveApprovalPolicy({ cli: "untrusted", settings: { approvalPolicy: "never" } })).toBe("untrusted");
		expect(resolveApprovalPolicy({ noPermission: true })).toBe("never");
		expect(resolveApprovalPolicy({ bypassApprovalsAndSandbox: true, cli: "untrusted" })).toBe("never");

		expect(resolveSandboxMode({})).toBe("danger-full-access");
		expect(resolveSandboxMode({ settings: { enabled: true } })).toBe("workspace-write");
		expect(resolveSandboxMode({ settings: { mode: "read-only", enabled: false } })).toBe("read-only");
		expect(resolveSandboxMode({ cli: "workspace-write" })).toBe("workspace-write");
		expect(resolveSandboxMode({ noSandbox: true, cli: "read-only" })).toBe("danger-full-access");
		expect(resolveSandboxMode({ bypassApprovalsAndSandbox: true })).toBe("danger-full-access");
	});

	it("derives Command Permission filesystem bounds from the sandbox mode", () => {
		expect(commandPermissionOptionsFor("on-request", "workspace-write", "/workspace", [])).toEqual({
			approvalPolicy: "on-request",
			filesystemAccess: "restricted",
			writableRoots: ["/workspace", "/tmp"],
			denyWrite: ["/workspace/.git", "/workspace/.agents", "/workspace/.coda"],
			remembered: [],
		});
		expect(commandPermissionOptionsFor("never", "danger-full-access", "/workspace", [])).toMatchObject({
			filesystemAccess: "unrestricted",
			writableRoots: [],
			denyWrite: [],
		});
	});

	it("applies a Codex preset to policy, settings, and live wrapScript", async () => {
		const policy = createCommandPermissionPolicy({
			approvalPolicy: "untrusted",
			filesystemAccess: "unrestricted",
		});
		const write = {
			toolName: "write",
			toolInput: { path: "src/app.ts" },
			sessionId: "s",
			workspace: "/workspace",
		};
		expect(policy.decide(write)).toEqual({ kind: "ask", prompt: "Allow write?\nsrc/app.ts" });
		const auto = PERMISSION_PRESETS.find((preset) => preset.id === "auto")!;
		applyPermissionPreset(policy, auto, "/workspace");
		expect(policy.decide(write)).toEqual({ kind: "allow" });
		expect(settingsAfterPermissionPreset({}, auto)).toEqual({
			permission: { approvalPolicy: "on-request" },
			sandbox: { mode: "workspace-write" },
		});

		const engine: ProcessConfinementEngine = {
			initialize: vi.fn(async () => undefined),
			wrapScript: async ({ command, shell, environment }) => ({
				executable: "/usr/bin/srt",
				args: [shell, "-c", command],
				environment,
			}),
			close: vi.fn(async () => undefined),
		};
		const holder: { current?: ProcessConfinement } = {};
		const resources = { useProcessConfinement: vi.fn() };
		await replaceProcessConfinement({
			holder,
			mode: "workspace-write",
			workspace: "/workspace",
			platform: "darwin",
			engine,
			resources,
		});
		expect(engine.initialize).toHaveBeenCalled();
		expect(resources.useProcessConfinement).toHaveBeenCalledWith(holder.current);
		const wrap = createLiveWrapScript(holder);
		await expect(
			wrap({
				command: "ls",
				shell: "/bin/zsh",
				cwd: "/workspace",
				environment: { PATH: "/usr/bin" },
			}),
		).resolves.toMatchObject({ executable: "/usr/bin/srt" });

		await replaceProcessConfinement({
			holder,
			mode: "danger-full-access",
			workspace: "/workspace",
			platform: "darwin",
			engine,
			resources,
		});
		expect(engine.close).toHaveBeenCalled();
		expect(holder.current).toBeUndefined();
		await expect(
			wrap({
				command: "ls",
				shell: "/bin/zsh",
				cwd: "/workspace",
				environment: { PATH: "/usr/bin" },
			}),
		).resolves.toBeUndefined();
	});

	it("persists the selected preset and can reopen Process Confinement", async () => {
		const policy = createCommandPermissionPolicy({ approvalPolicy: "on-request" });
		const persist = vi.fn(async () => undefined);
		const replaceConfinement = vi.fn(async () => undefined);
		const sandboxMode = { current: "danger-full-access" as const };
		const command = createPermissionsCommand({
			policy,
			workspace: "/workspace",
			sandboxMode,
			settings: () => ({}),
			persist,
			replaceConfinement,
		});
		const fullAccess = PERMISSION_PRESETS.find((preset) => preset.id === "full-access")!;
		await command.apply(fullAccess);
		expect(command.snapshot()).toEqual({ approvalPolicy: "never", sandboxMode: "danger-full-access" });
		expect(persist).toHaveBeenCalledWith({
			permission: { approvalPolicy: "never" },
			sandbox: { mode: "danger-full-access" },
		});
		expect(replaceConfinement).toHaveBeenCalledWith("danger-full-access");
	});
});
