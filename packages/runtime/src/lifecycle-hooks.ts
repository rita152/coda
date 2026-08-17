import type { AgentInput, ToolExecutionOutput } from "@coda/agent";

export const LIFECYCLE_HOOK_EVENTS = Object.freeze([
	"PreToolUse",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
] as const);

export type LifecycleHookEventName = (typeof LIFECYCLE_HOOK_EVENTS)[number];

export interface LifecycleHookSessionContext {
	readonly sessionId: string;
	readonly transcriptPath?: string;
	readonly cwd: string;
	readonly model: string;
}

export interface LifecycleHookTurnContext extends LifecycleHookSessionContext {
	/** Codex-compatible turn identity. A Coda Run is the user-visible turn. */
	readonly turnId: string;
}

export interface HookContinueOutcome {
	readonly continue: boolean;
	readonly reason?: string;
}

export interface UserPromptSubmitHookOutcome extends HookContinueOutcome {
	readonly additionalContext?: readonly string[];
}

export interface PreToolUseHookOutcome extends HookContinueOutcome {
	readonly updatedInput?: Readonly<Record<string, unknown>>;
	readonly additionalContext?: readonly string[];
}

export interface PostToolUseHookOutcome extends HookContinueOutcome {
	readonly feedback?: readonly string[];
	readonly additionalContext?: readonly string[];
}

export interface StopHookOutcome extends HookContinueOutcome {
	readonly continuation?: string;
}

/**
 * Runtime-facing lifecycle seam. The runtime owns event timing while the
 * application adapter owns configuration discovery and physical processes.
 */
export interface LifecycleHookHost {
	sessionStart(
		context: LifecycleHookSessionContext & { readonly source: "startup" | "resume" | "compact" },
	): Promise<HookContinueOutcome>;
	sessionEnd(context: Omit<LifecycleHookSessionContext, "model"> & { readonly reason: "other" }): Promise<void>;
	userPromptSubmit(
		context: LifecycleHookTurnContext & { readonly prompt: AgentInput },
	): Promise<UserPromptSubmitHookOutcome>;
	preToolUse(
		context: LifecycleHookTurnContext & {
			readonly toolName: string;
			readonly matcherAliases?: readonly string[];
			readonly toolUseId: string;
			readonly toolInput: Readonly<Record<string, unknown>>;
		},
	): Promise<PreToolUseHookOutcome>;
	postToolUse(
		context: LifecycleHookTurnContext & {
			readonly toolName: string;
			readonly matcherAliases?: readonly string[];
			readonly toolUseId: string;
			readonly toolInput: Readonly<Record<string, unknown>>;
			readonly toolResponse: ToolExecutionOutput | { readonly error: string };
		},
	): Promise<PostToolUseHookOutcome>;
	preCompact(context: LifecycleHookTurnContext & { readonly trigger: "auto" }): Promise<HookContinueOutcome>;
	postCompact(context: LifecycleHookTurnContext & { readonly trigger: "auto" }): Promise<HookContinueOutcome>;
	stop(
		context: LifecycleHookTurnContext & {
			readonly stopHookActive: boolean;
			readonly lastAssistantMessage?: string;
		},
	): Promise<StopHookOutcome>;
	/** Takes context produced by completed sync or async hooks exactly once. */
	takeAdditionalContext(sessionId: string): readonly string[];
	close(): Promise<void>;
}
