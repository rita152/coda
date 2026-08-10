import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";

export interface SessionCommandEntry {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly status: "current" | "needs attention" | "running" | "idle";
}

export interface SessionCommandFlowOptions {
	readonly sessions: readonly SessionCommandEntry[];
	readonly onSelect: (sessionId: string) => Promise<void> | void;
}

export function createSessionCommandFlow(options: SessionCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "session",
		title: "Session",
		filterable: true,
		items: Object.freeze(
			options.sessions.map((session) =>
				Object.freeze({
					id: session.id,
					label: session.label,
					description: session.description,
					status: session.status,
					onSelect: (navigation: CommandFlowNavigation) => finish(options.onSelect(session.id), navigation),
				}),
			),
		),
	});
}

function finish(result: Promise<void> | void, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
