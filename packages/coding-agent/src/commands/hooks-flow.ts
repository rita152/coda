import type { HookRuntimeSnapshot } from "../hooks/types.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export interface HooksCommandFlowOptions {
	readonly snapshot: () => HookRuntimeSnapshot;
}

function eventFlow(snapshot: HookRuntimeSnapshot, event: HookRuntimeSnapshot["events"][number]): CommandFlowMenu {
	const handlers = snapshot.handlers.filter((handler) => handler.event === event.event);
	return Object.freeze({
		id: `hooks:event:${event.event}`,
		title: `Hooks / ${event.event}`,
		filterable: true,
		items: Object.freeze(
			handlers.length === 0
				? [{ id: "empty", label: "No installed handlers", disabledReason: "Add one to hooks.json" }]
				: handlers.map((handler) => ({
						id: handler.id,
						label: handler.command,
						description: `${handler.source} • ${handler.matcher || "all"} • ${handler.sourcePath}`,
						status: handler.trust === "trusted" ? "active" : "untrusted",
					})),
		),
	});
}

function diagnosticsFlow(snapshot: HookRuntimeSnapshot): CommandFlowMenu {
	return Object.freeze({
		id: "hooks:diagnostics",
		title: "Hooks / Diagnostics",
		filterable: true,
		items: Object.freeze(
			snapshot.diagnostics.length === 0
				? [{ id: "healthy", label: "No Hook diagnostics", status: "healthy" }]
				: snapshot.diagnostics.map((diagnostic, index) => ({
						id: `diagnostic:${index}`,
						label: diagnostic.code,
						description: `${diagnostic.message}${diagnostic.path ? ` • ${diagnostic.path}` : ""}`,
						status: "attention",
					})),
		),
	});
}

export function createHooksCommandFlow(options: HooksCommandFlowOptions): CommandFlowMenu {
	const snapshot = options.snapshot();
	return Object.freeze({
		id: "hooks",
		title: "Hooks",
		items: Object.freeze([
			...snapshot.events.map((event) => ({
				id: event.event,
				label: event.event,
				description: `${event.installed} installed • ${event.active} active`,
				status: event.active > 0 ? "active" : event.installed > 0 ? "untrusted" : "inactive",
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(eventFlow(snapshot, event)),
			})),
			{
				id: "diagnostics",
				label: "Diagnostics",
				description: `${snapshot.diagnostics.length} total • revision ${snapshot.revision.slice(0, 12)}`,
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(diagnosticsFlow(snapshot)),
			},
		]),
	});
}
