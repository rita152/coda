import { createCoreCommandRegistry } from "./core-commands.ts";
import type { CommandRegistry } from "./registry.ts";
import type { CommandDefinition, CommandSource } from "./types.ts";

export interface SlashExtensionEntry {
	readonly id: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
}

export interface UnifiedCommandRegistryOptions {
	readonly skills?: readonly SlashExtensionEntry[];
	readonly mcp?: readonly SlashExtensionEntry[];
}

export function createUnifiedCommandRegistry(options: UnifiedCommandRegistryOptions = {}): CommandRegistry {
	const registry = createCoreCommandRegistry();
	for (const entry of options.skills ?? []) registry.register(extensionCommand("skill", entry));
	for (const entry of options.mcp ?? []) registry.register(extensionCommand("mcp", entry));
	return registry;
}

function extensionCommand(source: Exclude<CommandSource, "core">, entry: SlashExtensionEntry): CommandDefinition {
	const id = entry.id.trim();
	const name = entry.name.trim();
	if (!id) throw new Error(`${source} command id is required`);
	if (!name || /[\s/]/u.test(name)) throw new Error(`${source} command name must be one slash token`);
	return Object.freeze({
		id: `${source}:${id}`,
		name,
		title: entry.title?.trim() || name,
		description: entry.description,
		source,
		kind: "extension",
		triggerScope: "token_boundary",
		arguments: { kind: "none" } as const,
	});
}
