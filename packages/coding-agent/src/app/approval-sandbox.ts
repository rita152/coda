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

export type LiveWrapScript = (request: WrapScriptRequest) => Promise<WrappedProcessSpawn | undefined>;

export interface PermissionsCommand {
	snapshot(): PermissionsCommandState;
	apply(preset: PermissionPreset): Promise<void>;
}

interface CommandPermissionBoundOptions {
	readonly tmpdir?: string;
	readonly filesystemEnforced?: boolean;
}

export function isApprovalPolicy(value: string): value is ApprovalPolicy {
	return (APPROVAL_POLICIES as readonly string[]).includes(value);
}

export function absoluteTmpdir(environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const value = environment.TMPDIR;
	return typeof value === "string" && value.startsWith("/") ? value : undefined;
}

export function resolveApprovalPolicy(input: {
	readonly cli?: ApprovalPolicy;
	readonly noPermission?: boolean;
	readonly bypassApprovalsAndSandbox?: boolean;
	readonly settings?: { readonly approvalPolicy?: ApprovalPolicy; readonly enabled?: boolean };
	readonly interactive?: boolean;
}): ApprovalPolicy {
	if (input.bypassApprovalsAndSandbox) return "never";
	if (input.noPermission) return "never";
	if (input.cli) return input.cli;
	if (input.interactive === false) return "never";
	if (input.settings?.approvalPolicy) return input.settings.approvalPolicy;
	if (input.settings?.enabled === false) return "never";
	if (input.settings?.enabled === true) return "untrusted";
	return "on-request";
}

export function resolveSandboxMode(input: {
	readonly cli?: SandboxMode;
	readonly noSandbox?: boolean;
	readonly bypassApprovalsAndSandbox?: boolean;
	readonly settings?: { readonly mode?: string; readonly enabled?: boolean };
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
	bounds: CommandPermissionBoundOptions = {},
): CommandPermissionPolicyOptions {
	const roots = { tmpdir: bounds.tmpdir };
	return {
		approvalPolicy,
		filesystemAccess: filesystemAccessForSandboxMode(sandboxMode),
		writableRoots: writableRootsForSandboxMode(workspace, sandboxMode, roots),
		denyWrite: denyWriteForSandboxMode(workspace, sandboxMode, roots),
		filesystemEnforced: bounds.filesystemEnforced ?? true,
		remembered,
	};
}

export function applyPermissionPreset(
	policy: CommandPermissionPolicy,
	preset: PermissionPreset,
	workspace: string,
	bounds: CommandPermissionBoundOptions = {},
): void {
	policy.configure(
		commandPermissionOptionsFor(preset.approvalPolicy, preset.sandboxMode, workspace, undefined, bounds),
	);
}

export function createLiveWrapScript(holder: { current?: ProcessConfinement }): LiveWrapScript {
	return async (request) => holder.current?.wrapScript(request);
}

export function createPermissionsCommand(input: {
	readonly policy: CommandPermissionPolicy;
	readonly workspace: string;
	readonly sandboxMode: { current: SandboxMode };
	readonly replaceConfinement?: (mode: SandboxMode) => Promise<void>;
	readonly bounds?: CommandPermissionBoundOptions | (() => CommandPermissionBoundOptions);
}): PermissionsCommand {
	return {
		snapshot: () =>
			Object.freeze({
				approvalPolicy: input.policy.snapshot().approvalPolicy,
				sandboxMode: input.sandboxMode.current,
			}),
		apply: async (preset) => {
			input.sandboxMode.current = preset.sandboxMode;
			await input.replaceConfinement?.(preset.sandboxMode);
			const bounds = typeof input.bounds === "function" ? input.bounds() : (input.bounds ?? {});
			applyPermissionPreset(input.policy, preset, input.workspace, bounds);
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
	readonly tmpdir?: string;
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
			...(input.tmpdir ? { tmpdir: input.tmpdir } : {}),
		},
		engine: input.engine,
	});
	input.holder.current = next;
	input.resources.useProcessConfinement(next);
}
