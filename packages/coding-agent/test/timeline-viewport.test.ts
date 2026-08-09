import { describe, expect, it } from "vitest";
import { TimelineViewport, type ViewportBlock } from "../src/interactive/timeline-viewport.ts";

function blocks(entries: ReadonlyArray<readonly [string, ...string[]]>): ViewportBlock[] {
	return entries.map(([id, ...lines]) => ({ id, lines }));
}

describe("TimelineViewport", () => {
	it("follows the tail until the user pages away and counts unseen updates", () => {
		const viewport = new TimelineViewport();
		const document = blocks([
			["a", "a1", "a2", "a3"],
			["b", "b1", "b2", "b3"],
			["c", "c1", "c2"],
		]);

		expect(viewport.layout(document, 4).lines).toEqual(["b2", "b3", "c1", "c2"]);
		expect(viewport.followEnd).toBe(true);

		viewport.pageUp(document, 4);
		expect(viewport.layout(document, 4).lines).toEqual(["a2", "a3", "b1", "b2"]);
		expect(viewport.followEnd).toBe(false);

		viewport.noteUpdate();
		viewport.noteUpdate(2);
		expect(viewport.unreadUpdates).toBe(3);
		expect(viewport.layout(document, 4).lines).toEqual(["a2", "a3", "b1", "b2"]);

		viewport.jumpToEnd();
		expect(viewport.unreadUpdates).toBe(0);
		expect(viewport.layout(document, 4).lines).toEqual(["b2", "b3", "c1", "c2"]);
	});

	it("preserves a logical block and intra-block line across reflow and resize", () => {
		const viewport = new TimelineViewport();
		const initial = blocks([
			["a", "a1", "a2", "a3"],
			["b", "b1", "b2", "b3"],
			["c", "c1", "c2"],
		]);
		viewport.pageUp(initial, 4);
		expect(viewport.anchor).toEqual({ blockId: "a", lineOffset: 1 });

		const reflowed = blocks([
			["a", "a1", "a2", "a2-wrap", "a3"],
			["b", "b1", "b2", "b3"],
			["c", "c1", "c2"],
		]);
		expect(viewport.layout(reflowed, 3).lines).toEqual(["a2", "a2-wrap", "a3"]);
		expect(viewport.anchor).toEqual({ blockId: "a", lineOffset: 1 });
	});

	it("pages toward the end and resumes tail-follow on the final page", () => {
		const viewport = new TimelineViewport();
		const document = blocks([
			["a", "1", "2", "3", "4"],
			["b", "5", "6", "7", "8"],
		]);
		viewport.jumpToStart(document);
		expect(viewport.layout(document, 3).lines).toEqual(["1", "2", "3"]);

		viewport.pageDown(document, 3);
		expect(viewport.layout(document, 3).lines).toEqual(["3", "4", "5"]);
		viewport.pageDown(document, 3);
		expect(viewport.layout(document, 3).lines).toEqual(["5", "6", "7"]);
		viewport.pageDown(document, 3);

		expect(viewport.followEnd).toBe(true);
		expect(viewport.layout(document, 3).lines).toEqual(["6", "7", "8"]);
	});

	it("reads only visible rows from a 10,000-line block", () => {
		const viewport = new TimelineViewport();
		let rowReads = 0;
		const source = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
		const lines = new Proxy(source, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) rowReads++;
				return Reflect.get(target, property, receiver);
			},
		});

		expect(viewport.layout([{ id: "history", lines }], 4).lines).toEqual([
			"line 9996",
			"line 9997",
			"line 9998",
			"line 9999",
		]);
		expect(rowReads).toBe(4);
	});
});
