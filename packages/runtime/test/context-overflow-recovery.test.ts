import type { AgentMessage, TurnRetryContext } from "@coda/agent";
import { type Context, fauxAssistantMessage, fauxProvider, type Message } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { ContextOverflowRecovery } from "../src/context-window/overflow-recovery.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const messages = Object.freeze([
	Object.freeze({
		id: "message:1",
		message: Object.freeze({ role: "user", content: "x".repeat(4_000), timestamp: 1 }),
	}),
]) as unknown as readonly AgentMessage[];

const contextMessages = messages.map(({ message }) => structuredClone(message) as Message);

function fixture(
	options: { readonly compactable: boolean; readonly preparedMessages?: readonly Message[] } = {
		compactable: false,
	},
) {
	const model = fauxProvider({
		runtime: testTimeRuntime(1),
		models: [{ id: "tiny", contextWindow: 128, maxTokens: 32 }],
	}).getModel();
	const contextWindow = {
		canCompact: vi.fn(() => options.compactable),
		compact: vi.fn(async () => ({}) as never),
		prepare: vi.fn(
			async (context: Context): Promise<Context> => ({
				...context,
				messages: [...(options.preparedMessages ?? context.messages)],
			}),
		),
		project: vi.fn((projected: readonly AgentMessage[]) => projected),
	};
	return {
		contextWindow,
		recovery: new ContextOverflowRecovery({ contextWindow, model: () => model }),
	};
}

function providerOverflowAttempt(): TurnRetryContext {
	return {
		runId: "run:1",
		turnId: "turn:1",
		attemptId: "attempt:1",
		attempt: 1,
		transient: false,
		message: {
			id: "message:provider-overflow",
			message: fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 1,
			}),
		},
	} as unknown as TurnRetryContext;
}

describe("ContextOverflowRecovery", () => {
	it("uses the Context Window's Auto-Compaction result before declaring local overflow", async () => {
		const { contextWindow, recovery } = fixture({ compactable: true, preparedMessages: [] });

		await expect(recovery.prepare({ messages: contextMessages }, messages)).resolves.toMatchObject({
			context: { messages: [] },
		});

		expect(contextWindow.prepare).toHaveBeenCalledOnce();
		expect(recovery.takeUnrecoverable()).toBe(false);
	});

	it("publishes a one-shot failure after definite local overflow cannot be compacted", async () => {
		const { contextWindow, recovery } = fixture();

		await expect(recovery.prepare({ messages: contextMessages }, messages)).rejects.toThrow("Context Overflow");

		expect(contextWindow.compact).not.toHaveBeenCalled();
		expect(recovery.takeUnrecoverable()).toBe(true);
		expect(recovery.takeUnrecoverable()).toBe(false);
	});

	it("compacts and retries Provider overflow before exposing the fallback", async () => {
		const { contextWindow, recovery } = fixture({ compactable: true });

		await expect(recovery.recoverFailedAttempt(providerOverflowAttempt(), messages)).resolves.toEqual({
			retry: true,
			reason: "context overflow compacted",
		});

		expect(contextWindow.compact).toHaveBeenCalledWith({ messages, reason: "overflow" });
		expect(recovery.takeUnrecoverable()).toBe(false);
	});

	it("exposes Provider overflow when no safe compactable prefix exists", async () => {
		const { contextWindow, recovery } = fixture();

		await expect(recovery.recoverFailedAttempt(providerOverflowAttempt(), messages)).resolves.toEqual({
			retry: false,
		});

		expect(contextWindow.compact).not.toHaveBeenCalled();
		expect(recovery.takeUnrecoverable()).toBe(true);
	});

	it("retains the fallback signal when Provider-overflow Compaction fails", async () => {
		const { contextWindow, recovery } = fixture({ compactable: true });
		contextWindow.compact.mockRejectedValueOnce(new Error("checkpoint append failed"));

		await expect(recovery.recoverFailedAttempt(providerOverflowAttempt(), messages)).rejects.toThrow(
			"checkpoint append failed",
		);

		expect(recovery.takeUnrecoverable()).toBe(true);
	});
});
