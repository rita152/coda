import type { AgentMessage, FailedAttemptRecoveryDecision, Immutable, TurnRetryContext } from "@coda/agent";
import type { Api, AssistantMessage, Context, Message, Model } from "@coda/ai";
import { assertModelContextFits } from "../prompt/context-budget.ts";
import { type ContextWindowController, shouldAutoCompact } from "./context-window.ts";

const CONTEXT_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_overflow", "context_window_exceeded"]);

export interface ContextOverflowRecoveryOptions {
	readonly contextWindow: Pick<ContextWindowController, "canCompact" | "compact" | "prepare" | "project">;
	readonly model: () => Model<Api>;
}

export interface PreparedModelContext {
	readonly context: Context;
	readonly reservedOutputTokens: number;
}

/**
 * Keeps Auto-Compaction and the one Provider-overflow retry ahead of the
 * interactive empty-Session fallback, while exposing only a one-shot failure
 * signal to presentation code.
 */
export class ContextOverflowRecovery {
	readonly #contextWindow: ContextOverflowRecoveryOptions["contextWindow"];
	readonly #model: () => Model<Api>;
	#unrecoverable = false;

	constructor(options: ContextOverflowRecoveryOptions) {
		this.#contextWindow = options.contextWindow;
		this.#model = options.model;
	}

	async prepare(
		context: Context,
		messages: readonly AgentMessage[],
		signal?: AbortSignal,
	): Promise<PreparedModelContext> {
		const model = this.#model();
		const projectedContext: Context = {
			...context,
			messages: this.#contextWindow.project(messages).map(({ message }) => structuredClone(message) as Message),
		};
		const autoCompactionRequired =
			this.#contextWindow.canCompact(messages) && shouldAutoCompact(model, projectedContext);
		try {
			const prepared = await this.#contextWindow.prepare(context, messages, signal);
			const budget = assertModelContextFits(model, prepared);
			return { context: prepared, reservedOutputTokens: budget.reservedOutputTokens };
		} catch (error) {
			if (autoCompactionRequired || isContextOverflowError(error)) this.#unrecoverable = true;
			throw error;
		}
	}

	async recoverFailedAttempt(
		attempt: TurnRetryContext,
		messages: readonly AgentMessage[],
	): Promise<FailedAttemptRecoveryDecision> {
		if (!isProviderContextOverflow(attempt.message.message)) return { retry: false };
		this.#unrecoverable = true;
		if (!this.#contextWindow.canCompact(messages)) return { retry: false };
		await this.#contextWindow.compact({ messages, reason: "overflow" });
		this.#unrecoverable = false;
		return { retry: true, reason: "context overflow compacted" };
	}

	takeUnrecoverable(): boolean {
		const value = this.#unrecoverable;
		this.#unrecoverable = false;
		return value;
	}
}

export function isProviderContextOverflow(message: Immutable<AssistantMessage>): boolean {
	if (message.content.length > 0) return false;
	if (
		(message.diagnostics ?? []).some((diagnostic) => {
			const code = diagnostic.error?.code;
			return typeof code === "string" && CONTEXT_OVERFLOW_CODES.has(code.toLowerCase());
		})
	) {
		return true;
	}
	return isContextOverflowText(message.errorMessage ?? "");
}

export function isContextOverflowError(error: unknown): boolean {
	return isContextOverflowText(error instanceof Error ? error.message : String(error));
}

function isContextOverflowText(value: string): boolean {
	const normalized = value.toLowerCase();
	if (normalized.includes("context overflow")) return true;
	return (
		(normalized.includes("context length") || normalized.includes("context window")) &&
		(normalized.includes("exceed") || normalized.includes("too long") || normalized.includes("maximum"))
	);
}
