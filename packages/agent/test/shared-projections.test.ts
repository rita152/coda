import { describe, expect, it, vi } from "vitest";
import { AgentEventTraceReducer, BoundedObservationQueue } from "../src/index.ts";

describe("shared Agent projections", () => {
	it("serializes push delivery and replaces overflow with one resynchronization value", async () => {
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const delivered: number[] = [];
		let active = 0;
		let maximumActive = 0;
		const queue = new BoundedObservationQueue<number>({
			capacity: 2,
			deliver: async (value) => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				delivered.push(value);
				if (value === 1) await firstBlocked;
				active--;
			},
		});

		expect(queue.enqueue(1)).toBe(true);
		await vi.waitFor(() => expect(delivered).toEqual([1]));
		expect(queue.enqueue(2)).toBe(true);
		expect(queue.enqueue(3)).toBe(true);
		expect(queue.enqueue(4)).toBe(false);
		queue.replace(9);
		releaseFirst();

		await vi.waitFor(() => expect(delivered).toEqual([1, 9]));
		expect(maximumActive).toBe(1);
	});

	it("reduces detailed traces and constant-space resource summaries from the same event stream", () => {
		const reducer = new AgentEventTraceReducer();
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6 },
			stopReason: "stop",
			timestamp: 2,
		};
		const events = [
			{ type: "run_start", runId: "run:1", sequence: 1, timestamp: 1 },
			{ type: "turn_start", runId: "run:1", sequence: 2, timestamp: 1 },
			{
				type: "attempt_end",
				runId: "run:1",
				sequence: 3,
				timestamp: 2,
				attemptId: "attempt:1",
				turnId: "turn:1",
				outcome: "success",
				discarded: false,
				candidate: { id: "message:1", message: assistant },
			},
			{
				type: "message_end",
				runId: "run:1",
				sequence: 4,
				timestamp: 2,
				message: { id: "message:1", message: assistant },
			},
			{ type: "run_end", runId: "run:1", sequence: 5, timestamp: 3, outcome: "success" },
		];
		for (const event of events) reducer.accept(event);

		expect(reducer.completed()).toMatchObject([
			{
				runId: "run:1",
				turnCount: 1,
				finalText: "done",
				outcome: "success",
				attempts: [{ id: "attempt:1", outcome: "success" }],
			},
		]);
		expect(reducer.summary()).toMatchObject({
			turnCount: 1,
			usage: { inputTokens: 3, cacheReadTokens: 1, outputTokens: 2, attemptCount: 1 },
		});
	});
});
