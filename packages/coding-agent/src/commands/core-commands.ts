import { CommandRegistry } from "./registry.ts";
import type { CommandArgumentPolicy, CommandDefinition } from "./types.ts";

export const CORE_COMMANDS: readonly CommandDefinition[] = Object.freeze([
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
		id: "core:effort",
		name: "effort",
		title: "Reasoning Effort",
		description: "Choose the reasoning effort for future Runs in this session",
		kind: "control",
	}),
	coreCommand({
		id: "core:skill",
		name: "skill",
		title: "Select Skill",
		description: "Insert a Skill reference into the Composer",
		kind: "control",
	}),
	coreCommand({
		id: "core:skills",
		name: "skills",
		title: "Skills",
		description: "Inspect and refresh local Skills",
		visibleInPalette: false,
		kind: "control",
	}),
	coreCommand({
		id: "core:mcp",
		name: "mcp",
		title: "MCP",
		description: "Inspect and operate configured MCP Servers and Tools",
		kind: "control",
		arguments: { kind: "tail", required: false },
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
		id: "core:compact",
		name: "compact",
		title: "Compact context",
		description: "Compress older conversation context, optionally preserving a focus",
		kind: "action",
		arguments: { kind: "tail", required: false },
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
		Partial<Pick<CommandDefinition, "aliases" | "description" | "arguments" | "visibleInPalette">>,
): CommandDefinition {
	return Object.freeze({
		...options,
		aliases: options.aliases ? Object.freeze([...options.aliases]) : undefined,
		source: "core",
		triggerScope: "composer_start",
		arguments: options.arguments ?? ({ kind: "none" } satisfies CommandArgumentPolicy),
	});
}
