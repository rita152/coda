import { CommandRegistry } from "./registry.ts";
import type { CommandArgumentPolicy, CommandDefinition } from "./types.ts";

const CORE_COMMANDS: readonly CommandDefinition[] = Object.freeze([
	coreCommand({
		id: "core:permission",
		name: "permission",
		aliases: ["permissions"],
		title: "Permission",
		description: "Choose the permission level for future Runs in this session",
		kind: "control",
	}),
	coreCommand({
		id: "core:auth",
		name: "auth",
		title: "Authentication",
		description: "Add, update, or remove a model provider login",
		kind: "control",
	}),
	coreCommand({
		id: "core:model",
		name: "model",
		title: "Model",
		description: "Choose the model for future Runs in this session",
		kind: "control",
	}),
	coreCommand({
		id: "core:skills",
		name: "skills",
		title: "Skills",
		description: "Inspect, refresh, and trust local Skills inventories",
		kind: "control",
	}),
	coreCommand({
		id: "core:session",
		name: "session",
		title: "Session",
		description: "Browse and switch sessions in this workspace",
		kind: "control",
	}),
	coreCommand({
		id: "core:new",
		name: "new",
		title: "New session",
		description: "Create and focus a new session",
		kind: "action",
	}),
	coreCommand({
		id: "core:follow-up",
		name: "follow-up",
		title: "Queue follow-up",
		description: "Queue input after the active Run",
		kind: "action",
		arguments: { kind: "tail", required: true },
	}),
]);

export function createCoreCommandRegistry(): CommandRegistry {
	const registry = new CommandRegistry();
	for (const command of CORE_COMMANDS) registry.register(command);
	return registry;
}

function coreCommand(
	options: Pick<CommandDefinition, "id" | "name" | "title" | "kind"> &
		Partial<Pick<CommandDefinition, "aliases" | "description" | "arguments">>,
): CommandDefinition {
	return Object.freeze({
		...options,
		aliases: options.aliases ? Object.freeze([...options.aliases]) : undefined,
		source: "core",
		triggerScope: "composer_start",
		arguments: options.arguments ?? ({ kind: "none" } satisfies CommandArgumentPolicy),
	});
}
