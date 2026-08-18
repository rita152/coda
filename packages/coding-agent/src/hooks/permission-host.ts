import type { AgentInput } from "@coda/agent";
import {
	type CommandPermissionAskAnswer,
	type CommandPermissionPolicy,
	type CommandPermissionRequest,
	type RememberedCommandPermission,
	requestsSandboxOverride,
} from "@coda/permission";
import type {
	HookContinueOutcome,
	LifecycleHookHost,
	LifecycleHookSessionContext,
	LifecycleHookTurnContext,
	PostToolUseHookOutcome,
	PreToolUseHookOutcome,
	StopHookOutcome,
	UserPromptSubmitHookOutcome,
} from "@coda/runtime";

export type CommandPermissionAsk = (
	request: CommandPermissionRequest & { readonly prompt: string },
) => Promise<CommandPermissionAskAnswer>;

export interface PermissionLifecycleHookHostOptions {
	readonly inner: LifecycleHookHost;
	readonly policy: CommandPermissionPolicy;
	readonly ask?: CommandPermissionAsk;
	readonly onRemember?: (record: RememberedCommandPermission) => Promise<void> | void;
}

function permissionRequest(
	context: LifecycleHookTurnContext & {
		readonly toolName: string;
		readonly toolInput: Readonly<Record<string, unknown>>;
	},
): CommandPermissionRequest {
	return {
		toolName: context.toolName,
		toolInput: context.toolInput,
		sessionId: context.sessionId,
		workspace: context.cwd,
		...(requestsSandboxOverride(context.toolInput) ? { sandboxOverride: true } : {}),
	};
}

function withoutAsk(outcome: PreToolUseHookOutcome): PreToolUseHookOutcome {
	if (!outcome.permissionAsk) return outcome;
	const { permissionAsk: _ask, ...rest } = outcome;
	return rest;
}

/** Resolves Command Permission, including hook `permissionDecision:ask`, before the runtime sees the outcome. */
export class PermissionLifecycleHookHost implements LifecycleHookHost {
	readonly #inner: LifecycleHookHost;
	readonly #policy: CommandPermissionPolicy;
	readonly #ask?: CommandPermissionAsk;
	readonly #onRemember?: PermissionLifecycleHookHostOptions["onRemember"];

	constructor(options: PermissionLifecycleHookHostOptions) {
		this.#inner = options.inner;
		this.#policy = options.policy;
		this.#ask = options.ask;
		this.#onRemember = options.onRemember;
	}

	sessionStart(
		context: LifecycleHookSessionContext & { readonly source: "startup" | "resume" | "compact" },
	): Promise<HookContinueOutcome> {
		return this.#inner.sessionStart(context);
	}

	sessionEnd(context: Omit<LifecycleHookSessionContext, "model"> & { readonly reason: "other" }): Promise<void> {
		return this.#inner.sessionEnd(context);
	}

	userPromptSubmit(
		context: LifecycleHookTurnContext & { readonly prompt: AgentInput },
	): Promise<UserPromptSubmitHookOutcome> {
		return this.#inner.userPromptSubmit(context);
	}

	async preToolUse(
		context: LifecycleHookTurnContext & {
			readonly toolName: string;
			readonly matcherAliases?: readonly string[];
			readonly toolUseId: string;
			readonly toolInput: Readonly<Record<string, unknown>>;
		},
	): Promise<PreToolUseHookOutcome> {
		const inner = await this.#inner.preToolUse(context);
		if (!inner.continue) return withoutAsk(inner);
		const request = permissionRequest(context);
		const decision = inner.permissionAsk
			? { kind: "ask" as const, prompt: inner.reason ?? `Allow ${context.toolName}?` }
			: this.#policy.decide(request);
		if (decision.kind === "allow") return withoutAsk(inner);
		if (decision.kind === "deny") {
			return {
				continue: false,
				reason: decision.reason,
				additionalContext: inner.additionalContext,
			};
		}
		if (!this.#ask) {
			return {
				continue: false,
				reason: "Command Permission requires an interactive Session",
				additionalContext: inner.additionalContext,
			};
		}
		const answer = await this.#ask({ ...request, prompt: decision.prompt });
		if (answer.remember) {
			const record =
				answer.action === "deny"
					? this.#policy.remember(request, {
							kind: "deny",
							reason: answer.reason ?? "User denied this Tool Invocation",
							remember: answer.remember,
						})
					: this.#policy.remember(request, { kind: "allow", remember: answer.remember });
			await this.#onRemember?.(record);
		}
		if (answer.action === "deny") {
			return {
				continue: false,
				reason: answer.reason ?? "User denied this Tool Invocation",
				additionalContext: inner.additionalContext,
			};
		}
		return withoutAsk(inner);
	}

	postToolUse(context: Parameters<LifecycleHookHost["postToolUse"]>[0]): Promise<PostToolUseHookOutcome> {
		return this.#inner.postToolUse(context);
	}

	preCompact(context: LifecycleHookTurnContext & { readonly trigger: "auto" }): Promise<HookContinueOutcome> {
		return this.#inner.preCompact(context);
	}

	postCompact(context: LifecycleHookTurnContext & { readonly trigger: "auto" }): Promise<HookContinueOutcome> {
		return this.#inner.postCompact(context);
	}

	stop(context: Parameters<LifecycleHookHost["stop"]>[0]): Promise<StopHookOutcome> {
		return this.#inner.stop(context);
	}

	takeAdditionalContext(sessionId: string): readonly string[] {
		return this.#inner.takeAdditionalContext(sessionId);
	}

	close(): Promise<void> {
		return this.#inner.close();
	}
}
