import type { CommandRegistry } from "./registry.ts";
import type { CommandDefinition, CommandTrigger } from "./types.ts";

export type CommandQueryLocation = "composer_start" | "token_boundary";

export interface CommandQuery {
	readonly location: CommandQueryLocation;
	readonly trigger: CommandTrigger;
	readonly query: string;
	readonly range: {
		readonly start: number;
		readonly end: number;
	};
}

export interface CommandInvocation {
	readonly command: CommandDefinition;
	readonly invokedName: string;
	readonly argument: string | undefined;
}

export function parseCommandQuery(text: string, cursor: number): CommandQuery | undefined {
	if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
		throw new RangeError("Command query cursor is outside the Composer text");
	}
	const prefix = text.slice(0, cursor);
	const skill = /(?:^|[\s([{])\$([^\s$]*)$/u.exec(prefix);
	const slash = /(?:^|\s)\/([^\s]*)$/u.exec(prefix);
	const match = skill ?? slash;
	if (!match) return undefined;
	const query = match[1]!;
	const start = cursor - query.length - 1;
	const trigger = text[start] as CommandTrigger;
	return Object.freeze({
		location: start === 0 ? "composer_start" : "token_boundary",
		trigger,
		query,
		range: Object.freeze({ start, end: cursor }),
	});
}

export function resolveCommandInvocation(registry: CommandRegistry, text: string): CommandInvocation | undefined {
	if (!text.startsWith("/") || text.includes("\n") || text.includes("\r")) return undefined;
	const match = /^\/([^\s]+)(?:[\t ]+(.*))?[\t ]*$/u.exec(text);
	if (!match) return undefined;
	const invokedName = match[1]!;
	const tail = match[2]?.trim();
	const command = registry
		.findExact(invokedName, { location: "composer_start", trigger: "/" })
		.find((candidate) => candidate.triggerScope === "composer_start" && candidate.kind !== "extension");
	if (!command) return undefined;
	if (command.arguments.kind === "none") {
		if (tail) return undefined;
		return Object.freeze({ command, invokedName, argument: undefined });
	}
	if (command.arguments.required && !tail) return undefined;
	return Object.freeze({ command, invokedName, argument: tail });
}
