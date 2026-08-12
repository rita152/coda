import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";

export interface ContextOverflowFlowOptions {
	readonly openEmptySession: () => Promise<void> | void;
}

/** Offers the only two safe actions after Context Overflow recovery is exhausted. */
export function createContextOverflowFlow(options: ContextOverflowFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "context-overflow",
		title: "Context Overflow",
		items: Object.freeze([
			Object.freeze({
				id: "cancel",
				label: "Cancel",
				description: "Keep this Session without retrying",
				onSelect: (navigation: CommandFlowNavigation) => navigation.close(),
			}),
			Object.freeze({
				id: "new-session",
				label: "Open a new empty Session",
				description: "Close this Session and continue in the same Workspace",
				onSelect: (navigation: CommandFlowNavigation) => finish(options.openEmptySession(), navigation),
			}),
		]),
	});
}

function finish(result: Promise<void> | void, navigation: CommandFlowNavigation): Promise<void> | void {
	if (result instanceof Promise) return result.then(() => navigation.close());
	navigation.close();
}
