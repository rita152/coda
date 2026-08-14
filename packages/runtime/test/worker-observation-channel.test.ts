import type { AgentEvent } from "@coda/agent";
import { describe, expect, it, vi } from "vitest";
import { WorkerObservationChannel } from "../src/work-graph/worker-observation-channel.ts";

function observation(runId: string, sequence: number): AgentEvent {
	return {
		type: "message_update",
		runId,
		sequence,
		timestamp: sequence,
		turnId: "turn:1",
		attemptId: "attempt:1",
		messageId: "message:1",
		delta: { type: "text_delta", contentIndex: 0, delta: String(sequence) },
	} as unknown as AgentEvent;
}

function semantic(runId: string, sequence: number, type: "run_start" | "turn_start"): AgentEvent {
	return {
		type,
		runId,
		sequence,
		timestamp: sequence,
		...(type === "run_start"
			? {
					source: "prompt",
					inputMessage: { id: "message:input", message: { role: "user", content: "start", timestamp: 0 } },
				}
			: { turnId: "turn:1", steeringMessages: [] }),
	} as unknown as AgentEvent;
}

async function drainMicrotasks(count = 8): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}

describe("WorkerObservationChannel", () => {
	it("moves host projection off the Worker stack and preserves per-Run Agent sequence", async () => {
		const published: number[] = [];
		const publish = vi.fn((event: AgentEvent) => published.push(event.sequence));
		const channel = new WorkerObservationChannel({
			capacity: 8,
			publish: (event) => publish(event as AgentEvent),
			resynchronize: () => undefined,
		});

		channel.publishSemantic(semantic("run:1", 1, "run_start"));
		expect(publish).not.toHaveBeenCalled();
		await drainMicrotasks();
		expect(published).toEqual([1]);

		channel.publishTransient(observation("run:1", 3));
		channel.publishSemantic(semantic("run:1", 2, "turn_start"));
		expect(published).toEqual([1]);
		await drainMicrotasks();
		expect(published).toEqual([1, 2, 3]);
	});

	it("invalidates the stream instead of retaining an unbounded sequence gap", async () => {
		const published: number[] = [];
		let resynchronizations = 0;
		const channel = new WorkerObservationChannel({
			capacity: 2,
			publish: (event) => published.push((event as AgentEvent).sequence),
			resynchronize: () => {
				resynchronizations++;
			},
		});

		channel.publishSemantic(semantic("run:1", 1, "run_start"));
		await drainMicrotasks();
		published.splice(0);
		channel.publishTransient(observation("run:1", 3));
		channel.publishTransient(observation("run:1", 4));
		channel.publishTransient(observation("run:1", 5));
		channel.publishSemantic(semantic("run:1", 2, "turn_start"));
		channel.publishTransient(observation("run:1", 6));
		await drainMicrotasks();

		expect(resynchronizations).toBe(1);
		expect(published).toEqual([6]);
	});

	it("drops late transient events from a retired Run instead of switching the sequencer backward", async () => {
		const published: Array<[string, number]> = [];
		let resynchronizations = 0;
		const channel = new WorkerObservationChannel({
			capacity: 8,
			publish: (event) => published.push([String((event as AgentEvent).runId), (event as AgentEvent).sequence]),
			resynchronize: () => {
				resynchronizations++;
			},
		});

		channel.publishSemantic(semantic("run:1", 1, "run_start"));
		await drainMicrotasks();
		channel.publishSemantic(semantic("run:2", 1, "run_start"));
		channel.publishTransient(observation("run:1", 2));
		channel.publishTransient(observation("run:2", 2));
		await drainMicrotasks();

		expect(resynchronizations).toBe(1);
		expect(published).toEqual([
			["run:1", 1],
			["run:2", 2],
		]);
	});

	it("invalidates retained deliveries before the Worker releases its Session lease", async () => {
		const published: number[] = [];
		let resynchronizations = 0;
		const channel = new WorkerObservationChannel({
			capacity: 8,
			publish: (event) => published.push((event as AgentEvent).sequence),
			resynchronize: () => {
				resynchronizations++;
			},
		});

		channel.publishSemantic(semantic("run:1", 1, "run_start"));
		channel.publishTransient(observation("run:1", 2));
		channel.invalidateAndClose();
		channel.publishSemantic(semantic("run:2", 1, "run_start"));
		await drainMicrotasks();

		expect(published).toEqual([]);
		expect(resynchronizations).toBe(1);
	});
});
