import { createCoreCommandRegistry } from "./core-commands.ts";
import type { CommandRegistry } from "./registry.ts";
import { type CommandDefinition, type CommandSource, commandTrigger } from "./types.ts";

export interface CommandExtensionEntry {
	readonly id: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly defaultPrompt?: string;
}

export interface UnifiedCommandRegistryOptions {
	readonly skills?: readonly CommandExtensionEntry[];
	readonly mcp?: readonly CommandExtensionEntry[];
}

export function createUnifiedCommandRegistry(options: UnifiedCommandRegistryOptions = {}): CommandRegistry {
	const registry = createCoreCommandRegistry();
	for (const entry of options.skills ?? []) registerCommandExtension(registry, "skill", entry);
	for (const entry of options.mcp ?? []) registerCommandExtension(registry, "mcp", entry);
	return registry;
}

export function registerCommandExtension(
	registry: CommandRegistry,
	source: Exclude<CommandSource, "core">,
	entry: CommandExtensionEntry,
): () => void {
	return registry.register(extensionCommand(source, entry));
}

function extensionCommand(source: Exclude<CommandSource, "core">, entry: CommandExtensionEntry): CommandDefinition {
	const id = entry.id.trim();
	const name = entry.name.trim();
	if (!id) throw new Error(`${source} command id is required`);
	if (!name || /\s/u.test(name) || name.includes(commandTrigger(source))) {
		throw new Error(`${source} command name must be one trigger token`);
	}
	return Object.freeze({
		id: `${source}:${id}`,
		name,
		title: entry.title?.trim() || name,
		description: entry.description,
		...(entry.defaultPrompt?.trim() ? { defaultPrompt: entry.defaultPrompt.trim() } : {}),
		source,
		kind: "extension",
		triggerScope: "token_boundary",
		arguments: { kind: "none" } as const,
	});
}
