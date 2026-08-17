import { type Api, fauxAssistantMessage, type Model } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionTitleComplete,
	generateSessionTitle,
	subscribeSessionTitleGeneration,
} from "../src/session/session-title.ts";
import type { Session } from "../src/session/types.ts";

describe("Session Title generation", () => {
	it("asks the Model for a short title and sanitizes the reply", async () => {
		const complete = vi.fn(async (context) => {
			expect(context.tools).toBeUndefined();
			expect(context.messages).toEqual([
				expect.objectContaining({
					role: "user",
					content: "First Prompt:\nPlease implement a readable session picker for the /session command",
				}),
			]);
			return fauxAssistantMessage('  "Readable session picker"\nextra line', { timestamp: 1_000 });
		});

		await expect(
			generateSessionTitle({
				excerpt: "Please implement a readable session picker for the /session command",
				complete,
			}),
		).resolves.toBe("Readable session picker");
		expect(complete).toHaveBeenCalledOnce();
	});

	it("strips thinking wrappers and refuses empty or failed replies", async () => {
		await expect(
			generateSessionTitle({
				excerpt: "fix auth",
				complete: async () =>
					fauxAssistantMessage("<think>planning</think>\n\nAuth login fix", { timestamp: 1_000 }),
			}),
		).resolves.toBe("Auth login fix");

		await expect(
			generateSessionTitle({
				excerpt: "fix auth",
				complete: async () => fauxAssistantMessage("   ", { timestamp: 1_000 }),
			}),
		).resolves.toBeUndefined();

		await expect(
			generateSessionTitle({
				excerpt: "fix auth",
				complete: async () => fauxAssistantMessage("nope", { timestamp: 1_000, stopReason: "error" }),
			}),
		).resolves.toBeUndefined();

		await expect(
			generateSessionTitle({
				excerpt: "fix auth",
				complete: async () => fauxAssistantMessage("Auth login fix", { timestamp: 1_000, stopReason: "length" }),
			}),
		).resolves.toBe("Auth login fix");

		await expect(
			generateSessionTitle({
				excerpt: "fix auth",
				complete: async () => ({
					...fauxAssistantMessage("", { timestamp: 1_000, stopReason: "length" }),
					content: [
						{
							type: "thinking",
							thinking: "I should name this Auth login fix",
							thinkingSignature: "reasoning_content",
						},
					],
				}),
			}),
		).resolves.toBeUndefined();
	});

	it("leaves room for a title when the Model cannot disable thinking", async () => {
		const complete = vi.fn(async () => fauxAssistantMessage("Readable session picker", { timestamp: 1_000 }));
		const generate = createSessionTitleComplete(
			{ bindSimple: () => ({ complete }) as never },
			{
				provider: "opencode-go",
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				api: "openai-completions",
				reasoning: true,
				thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
				maxTokens: 384_000,
				contextWindow: 1_000_000,
				input: ["text"],
			} as Model<Api>,
			{ auth: { headers: {} }, env: {} } as never,
		);
		expect(generate).toBeDefined();
		await generate!({
			systemPrompt: "",
			messages: [{ role: "user", content: "Please implement a readable session picker", timestamp: 0 }],
		});
		const [, options] = complete.mock.calls[0] as unknown as [unknown, { maxTokens: number; reasoning: string }];
		expect(options).toEqual({ maxTokens: expect.any(Number), reasoning: "low" });
		expect(options.maxTokens).toBeGreaterThan(64);
	});

	it("keeps the short title budget when thinking can be turned off", async () => {
		const complete = vi.fn(async () => fauxAssistantMessage("Readable session picker", { timestamp: 1_000 }));
		const generate = createSessionTitleComplete(
			{ bindSimple: () => ({ complete }) as never },
			{
				provider: "opencode-go",
				id: "hy3",
				name: "Hy3",
				api: "openai-completions",
				reasoning: true,
				thinkingLevelMap: { off: "none", low: "low", high: "high" },
				maxTokens: 64_000,
				contextWindow: 256_000,
				input: ["text"],
			} as Model<Api>,
			{ auth: { headers: {} }, env: {} } as never,
		);
		await generate!({
			systemPrompt: "",
			messages: [{ role: "user", content: "Please implement a readable session picker", timestamp: 0 }],
		});
		expect(complete).toHaveBeenCalledWith(expect.anything(), { maxTokens: 64 });
	});

	it("generates from the first Prompt run and ignores later Follow-ups", async () => {
		const session = titleSession();
		const listeners: Array<(event: { readonly type: string; readonly source?: string }) => void> = [];
		const { done, dispose } = subscribeSessionTitleGeneration({
			session,
			complete: async () => fauxAssistantMessage("Readable session picker", { timestamp: 1_000 }),
			subscribe: (observer) => {
				listeners.push((event) => {
					void observer.accept(event as never);
				});
				return () => undefined;
			},
		});

		listeners[0]!({
			type: "run_start",
			source: "prompt",
			inputMessage: { message: { content: "Please implement a readable session picker" } },
		} as never);
		listeners[0]!({ type: "run_end" });
		await done;
		expect(session.title).toBe("Readable session picker");

		listeners[0]!({ type: "run_start", source: "follow_up" });
		listeners[0]!({ type: "run_end" });
		expect(session.records).toHaveLength(1);
		dispose();
	});

	it("leaves the first-Prompt fallback when the side call fails", async () => {
		const session = titleSession();
		const { done, dispose } = subscribeSessionTitleGeneration({
			session,
			complete: async () => {
				throw new Error("provider unavailable");
			},
			subscribe: (observer) => {
				void observer.accept({
					type: "run_start",
					source: "prompt",
					inputMessage: { message: { content: "Please implement a readable session picker" } },
				} as never);
				void observer.accept({ type: "run_end" } as never);
				return () => undefined;
			},
		});
		await done;
		expect(session.title).toBeUndefined();
		expect(session.records).toEqual([]);
		dispose();
	});

	it("settles without generating when the first Prompt never starts", async () => {
		const session = titleSession();
		const { done, dispose } = subscribeSessionTitleGeneration({
			session,
			complete: async () => fauxAssistantMessage("Should not run", { timestamp: 1_000 }),
			subscribe: () => () => undefined,
		});
		dispose();
		await done;
		expect(session.records).toEqual([]);
	});
});

function titleSession(): Pick<Session, "title" | "record"> & {
	title: string | undefined;
	readonly records: Array<{ readonly type: string; readonly title: string }>;
} {
	const records: Array<{ readonly type: string; readonly title: string }> = [];
	const session = {
		title: undefined as string | undefined,
		records,
		record: async (change: { readonly type: string; readonly title?: string }) => {
			if (change.type !== "session_title_set" || !change.title) return;
			records.push({ type: change.type, title: change.title });
			session.title = change.title;
		},
	};
	return session;
}
