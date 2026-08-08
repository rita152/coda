import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "../src/index.ts";
import { AssistantMessageEventStream, EventStream } from "../src/index.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "opencode-go",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("EventStream", () => {
	test("delivers the terminal event before closing and ignores later pushes", async () => {
		const stream = new EventStream<number, number>(
			(value) => value === 2,
			(value) => value * 10,
		);
		stream.push(1);
		stream.push(2);
		stream.push(3);

		const observed: number[] = [];
		for await (const value of stream) observed.push(value);

		expect(observed).toEqual([1, 2]);
		await expect(stream.result()).resolves.toBe(20);
	});

	test("turns a runtime end-without-result mistake into a settled invariant failure", async () => {
		const stream = new EventStream<string, string>(() => false, String);
		const result = stream.result();

		expect(() => (stream.end as () => void)()).toThrowError("EventStream.end() requires a result");
		await expect(result).rejects.toThrowError("EventStream.end() requires a result");
	});

	test("aggregates an Assistant Message from its terminal event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = assistant("complete");
		stream.push({ type: "done", reason: "stop", message });

		await expect(stream.result()).resolves.toBe(message);
	});
});
