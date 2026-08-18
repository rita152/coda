import type { LifecycleHookEventName } from "@coda/runtime";

export const SUPPORTED_HOOK_EVENTS = Object.freeze([
	"PreToolUse",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
] as const satisfies readonly LifecycleHookEventName[]);

export type HookConfigurationSource = "user" | "workspace";
export type HookTrust = "trusted" | "untrusted";

export interface HookTrustRecord {
	readonly key: string;
	readonly sha256: string;
}

export interface HookDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export interface ConfiguredCommandHook {
	readonly id: string;
	readonly event: LifecycleHookEventName;
	readonly source: HookConfigurationSource;
	readonly sourcePath: string;
	readonly matcher?: string;
	readonly command: string;
	readonly commandWindows?: string;
	readonly timeoutMs: number;
	readonly async: boolean;
	readonly statusMessage?: string;
	readonly additionalContextLimit: number;
	readonly trustKey: string;
	readonly sha256: string;
	readonly trust: HookTrust;
}

export interface HookConfigurationSnapshot {
	readonly revision: string;
	readonly paths: readonly string[];
	readonly handlers: readonly ConfiguredCommandHook[];
	readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookEventStatus {
	readonly event: LifecycleHookEventName;
	readonly installed: number;
	readonly active: number;
}

export interface HookRuntimeSnapshot extends HookConfigurationSnapshot {
	readonly events: readonly HookEventStatus[];
}
