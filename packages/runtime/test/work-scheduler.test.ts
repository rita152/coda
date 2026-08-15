import { describe, expect, it } from "vitest";
import { AdmissionController } from "../src/work-graph/admission-controller.ts";
import type { WorkCapacityPolicy } from "../src/work-graph/types.ts";

const CAPACITY: WorkCapacityPolicy = Object.freeze({
	processMaximumConcurrency: 4,
	graphMaximumConcurrency: 4,
});

function repeatableSchedule(): string[] {
	const scheduler = new AdmissionController(CAPACITY);
	const queues = Array.from({ length: 32 }, (_, graph) =>
		Array.from({ length: 4 }, (_, item) => `graph:${graph}/item:${item}`),
	);
	const selected: string[] = [];
	while (selected.length < 32 * 4) {
		const next = scheduler.select({
			activeProcessConcurrency: 0,
			graphs: queues.map((queue, graph) => ({
				graphId: `graph:${graph}`,
				activeConcurrency: 0,
				maximumConcurrency: CAPACITY.graphMaximumConcurrency,
				next: () => queue.shift(),
			})),
		});
		if (!next) throw new Error("Expected schedulable Work");
		selected.push(next);
	}
	return selected;
}

describe("AdmissionController", () => {
	it("gives 32 continuously ready Sessions bounded round-robin progress", () => {
		const selected = repeatableSchedule();
		expect(selected.slice(0, 32).map((entry) => entry.split("/")[0])).toEqual(
			Array.from({ length: 32 }, (_, graph) => `graph:${graph}`),
		);
		for (let graph = 0; graph < 32; graph++) {
			expect(selected.filter((entry) => entry.startsWith(`graph:${graph}/`))).toEqual(
				Array.from({ length: 4 }, (_, item) => `graph:${graph}/item:${item}`),
			);
		}
	});

	it("is repeatable for the same accepted Graph and Item order", () => {
		expect(repeatableSchedule()).toEqual(repeatableSchedule());
	});

	it("does not let one older hot Graph starve later ready Graphs", () => {
		const scheduler = new AdmissionController(CAPACITY);
		const queues = [
			Array.from({ length: 10_000 }, (_, item) => `hot:${item}`),
			...Array.from({ length: 31 }, (_, graph) => [`later:${graph}`]),
		];
		const selected = Array.from({ length: 32 }, () =>
			scheduler.select({
				activeProcessConcurrency: 0,
				graphs: queues.map((queue, graph) => ({
					graphId: `graph:${graph}`,
					activeConcurrency: 0,
					maximumConcurrency: CAPACITY.graphMaximumConcurrency,
					next: () => queue.shift(),
				})),
			}),
		);
		expect(selected).toEqual(["hot:0", ...Array.from({ length: 31 }, (_, graph) => `later:${graph}`)]);
	});

	it("enforces process and per-Graph capacity exactly", () => {
		const scheduler = new AdmissionController(CAPACITY);
		const ready = () => "ready";
		expect(
			scheduler.select({
				activeProcessConcurrency: CAPACITY.processMaximumConcurrency,
				graphs: [{ graphId: "full-process", activeConcurrency: 0, maximumConcurrency: 1, next: ready }],
			}),
		).toBeUndefined();
		expect(
			scheduler.select({
				activeProcessConcurrency: CAPACITY.processMaximumConcurrency - 1,
				graphs: [{ graphId: "full-graph", activeConcurrency: 2, maximumConcurrency: 2, next: ready }],
			}),
		).toBeUndefined();
	});
});
