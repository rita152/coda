import type { DelegatedWorkItemProjection } from "../runtime/session-work-controller.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "interrupted", "blocked"]);
const NO_ROLLBACK = "Does not roll back Tool or Publication side effects that already happened";

export interface CancelWorkCommandFlowOptions {
	readonly graphActive: boolean;
	readonly children: readonly DelegatedWorkItemProjection[];
	readonly onCancelGraph: () => Promise<void> | void;
	readonly onCancelItem: (itemId: string) => Promise<void> | void;
}

export function createCancelWorkCommandFlow(options: CancelWorkCommandFlowOptions): CommandFlowMenu {
	const running = options.children.filter((child) => !TERMINAL.has(child.state));
	return Object.freeze({
		id: "cancel-work",
		title: "Cancel Work",
		emptyMessage: "No active Work Graph",
		items: Object.freeze([
			...(options.graphActive
				? [
						Object.freeze({
							id: "graph",
							label: "Cancel entire Work Graph",
							description: NO_ROLLBACK,
							onSelect: (navigation: CommandFlowNavigation) =>
								finish(options.onCancelGraph(), navigation),
						}),
					]
				: []),
			...running.map((child) =>
				Object.freeze({
					id: `item:${child.itemId}`,
					label: `Cancel ${String(child.itemId)}`,
					description: child.objective ? `${child.objective} — ${NO_ROLLBACK}` : NO_ROLLBACK,
					onSelect: (navigation: CommandFlowNavigation) =>
						finish(options.onCancelItem(String(child.itemId)), navigation),
				}),
			),
		]),
	});
}

async function finish(operation: Promise<void> | void, navigation: CommandFlowNavigation): Promise<void> {
	await operation;
	navigation.close();
}
