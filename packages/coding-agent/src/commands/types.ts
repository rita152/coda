export type CommandSource = "core" | "skill" | "mcp";

export type CommandKind = "control" | "action" | "extension";

export type CommandTriggerScope = "composer_start" | "token_boundary";

export type CommandArgumentPolicy = { readonly kind: "none" } | { readonly kind: "tail"; readonly required: boolean };

export interface CommandDefinition {
	readonly id: string;
	readonly name: string;
	readonly aliases?: readonly string[];
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
}
