import { displayWidth } from "@coda/tui";
import type { TimelineEntry } from "./semantic-timeline.ts";
import type { ViewportBlock } from "./timeline-viewport.ts";

export type MainTimelineContentType =
	| "user"
	| "thinking"
	| "assistant"
	| "assistant_commentary"
	| "assistant_final"
	| "exploration"
	| "tool"
	| "user_shell"
	| "error"
	| "notice";

export interface MainTimelineBlock extends ViewportBlock {
	readonly contentType: MainTimelineContentType;
}

export function timelineEntryContentType(entry: TimelineEntry): MainTimelineContentType {
	switch (entry.kind) {
		case "user":
			return "user";
		case "thinking":
			return "thinking";
		case "assistant":
			return entry.textPhase === "commentary"
				? "assistant_commentary"
				: entry.textPhase === "final_answer"
					? "assistant_final"
					: "assistant";
		case "tool":
			return "tool";
		case "user_shell":
			return "user_shell";
	}
}

/** Inserts one stable blank row only when adjacent visible content changes semantic type. */
export function spaceMainTimelineBlocks(blocks: readonly MainTimelineBlock[]): readonly ViewportBlock[] {
	const spaced: ViewportBlock[] = [];
	let previousVisible: MainTimelineBlock | undefined;
	for (const block of blocks) {
		const visible = block.lines.some((line) => displayWidth(line) > 0);
		if (visible && previousVisible && previousVisible.contentType !== block.contentType) {
			spaced.push({
				id: spacingBlockId(previousVisible.id, block.id),
				lines: [""],
			});
		}
		spaced.push(block);
		if (visible) previousVisible = block;
	}
	return Object.freeze(spaced);
}

function spacingBlockId(previousId: string, nextId: string): string {
	return `spacing:${previousId.length}:${previousId}${nextId}`;
}
