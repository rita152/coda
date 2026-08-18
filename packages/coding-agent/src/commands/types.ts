export type CommandSource = "core" | "skill" | "mcp";

export type CommandKind = "control" | "action" | "extension";

export type CommandTrigger = "/" | "$";

const COMMAND_TRIGGER_BY_SOURCE: Readonly<Record<CommandSource, CommandTrigger>> = Object.freeze({
	core: "/",
	skill: "$",
	mcp: "$",
});

export function commandTrigger(source: CommandSource): CommandTrigger {
	return COMMAND_TRIGGER_BY_SOURCE[source];
}

export type CommandTriggerScope = "composer_start" | "token_boundary";

export type CommandArgumentPolicy = { readonly kind: "none" } | { readonly kind: "tail"; readonly required: boolean };

export interface CommandDefinition {
	readonly id: string;
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly visibleInPalette?: boolean;
	readonly title: string;
	readonly description?: string;
	readonly source: CommandSource;
	readonly kind: CommandKind;
	readonly triggerScope: CommandTriggerScope;
	readonly arguments: CommandArgumentPolicy;
}

export type CommandMatchKind = "exact" | "prefix" | "fuzzy";

export interface CommandMatch {
	readonly command: CommandDefinition;
	readonly kind: CommandMatchKind;
}

export interface CommandSearchOptions {
	readonly location: CommandTriggerScope;
	readonly trigger?: CommandTrigger;
}
