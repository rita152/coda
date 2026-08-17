import {
	APPROVAL_POLICIES,
	type ApprovalPolicy,
	type CommandPermissionPolicy,
	type CommandPermissionPolicyOptions,
} from "@coda/permission";
import {
	denyWriteForSandboxMode,
	filesystemAccessForSandboxMode,
	isSandboxMode,
	openProcessConfinement,
	type ProcessConfinement,
	type ProcessConfinementEngine,
	processConfinementActive,
	type SandboxMode,
	type WrappedProcessSpawn,
	type WrapScriptRequest,
	writableRootsForSandboxMode,
} from "@coda/sandbox";
import type { PermissionPreset, PermissionsCommandState } from "../commands/permissions-flow.ts";
import type { UserSettings } from "../settings/types.ts";

export type LiveWrapScript = (request: WrapScriptRequest) => Promise<WrappedProcessSpawn | undefined>;

export interface PermissionsCommand {
	snapshot(): PermissionsCommandState;
	apply(preset: PermissionPreset): Promise<void>;
}

export function isApprovalPolicy(value: string): value is ApprovalPolicy {
	return (APPROVAL_POLICIES as readonly string[]).includes(value);
}

export function resolveApprovalPolicy(input: {
	readonly cli?: ApprovalPolicy;
	readonly noPermission?: boolean;
	readonly bypassApprovalsAndSandbox?: boolean;
	readonly settings?: UserSettings["permission"];
}): ApprovalPolicy {
	if (input.bypassApprovalsAndSandbox) return "never";
	if (input.noPermission) return "never";
	if (input.cli) return input.cli;
	if (input.settings?.approvalPolicy) return input.settings.approvalPolicy;
	if (input.settings?.enabled === false) return "never";
	if (input.settings?.enabled === true) return "untrusted";
	return "on-request";
}

export function resolveSandboxMode(input: {
	readonly cli?: SandboxMode;
	readonly noSandbox?: boolean;
	readonly bypassApprovalsAndSandbox?: boolean;
	readonly settings?: UserSettings["sandbox"];
}): SandboxMode {
	if (input.bypassApprovalsAndSandbox) return "danger-full-access";
	if (input.noSandbox) return "danger-full-access";
	if (input.cli) return input.cli;
	if (input.settings?.mode && isSandboxMode(input.settings.mode)) return input.settings.mode;
	if (input.settings?.enabled === true) return "workspace-write";
	if (input.settings?.enabled === false) return "danger-full-access";
	return "danger-full-access";
}

export function commandPermissionOptionsFor(
	approvalPolicy: ApprovalPolicy,
	sandboxMode: SandboxMode,
	workspace: string,
	remembered: CommandPermissionPolicyOptions["remembered"],
): CommandPermissionPolicyOptions {
	return {
		approvalPolicy,
		filesystemAccess: filesystemAccessForSandboxMode(sandboxMode),
		writableRoots: writableRootsForSandboxMode(workspace, sandboxMode),
		denyWrite: denyWriteForSandboxMode(workspace, sandboxMode),
		remembered,
	};
}

export function applyPermissionPreset(
	policy: CommandPermissionPolicy,
	preset: PermissionPreset,
	workspace: string,
): void {
	policy.configure(commandPermissionOptionsFor(preset.approvalPolicy, preset.sandboxMode, workspace, undefined));
}

export function settingsAfterPermissionPreset(settings: UserSettings, preset: PermissionPreset): UserSettings {
	return {
		...settings,
		permission: {
			...settings.permission,
			approvalPolicy: preset.approvalPolicy,
		},
		sandbox: {
			...settings.sandbox,
			mode: preset.sandboxMode,
		},
	};
}

export function createLiveWrapScript(holder: { current?: ProcessConfinement }): LiveWrapScript {
	return async (request) => holder.current?.wrapScript(request);
}

export function createPermissionsCommand(input: {
	readonly policy: CommandPermissionPolicy;
	readonly workspace: string;
	readonly sandboxMode: { current: SandboxMode };
	readonly settings: () => UserSettings;
	readonly persist: (settings: UserSettings) => Promise<void>;
	readonly replaceConfinement?: (mode: SandboxMode) => Promise<void>;
}): PermissionsCommand {
	return {
		snapshot: () =>
			Object.freeze({
				approvalPolicy: input.policy.snapshot().approvalPolicy,
				sandboxMode: input.sandboxMode.current,
			}),
		apply: async (preset) => {
			applyPermissionPreset(input.policy, preset, input.workspace);
			input.sandboxMode.current = preset.sandboxMode;
			await input.persist(settingsAfterPermissionPreset(input.settings(), preset));
			await input.replaceConfinement?.(preset.sandboxMode);
		},
	};
}

export async function replaceProcessConfinement(input: {
	readonly holder: { current?: ProcessConfinement };
	readonly mode: SandboxMode;
	readonly workspace: string;
	readonly platform: NodeJS.Platform;
	readonly engine: ProcessConfinementEngine;
	readonly allowedDomains?: readonly string[];
	readonly deniedDomains?: readonly string[];
	readonly resources: { useProcessConfinement(confinement: { close(): Promise<void> }): void };
}): Promise<void> {
	const previous = input.holder.current;
	input.holder.current = undefined;
	if (previous) await previous.close();
	if (!processConfinementActive(input.mode)) return;
	const next = await openProcessConfinement({
		platform: input.platform,
		config: {
			workspace: input.workspace,
			mode: input.mode,
			...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
			...(input.deniedDomains ? { deniedDomains: input.deniedDomains } : {}),
		},
		engine: input.engine,
	});
	input.holder.current = next;
	input.resources.useProcessConfinement(next);
}

export { isSandboxMode };
