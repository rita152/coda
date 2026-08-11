import type {
	CommandDefinition,
	CommandMatch,
	CommandMatchKind,
	CommandSearchOptions,
	CommandSource,
} from "./types.ts";

const SOURCE_PRIORITY: Readonly<Record<CommandSource, number>> = Object.freeze({
	core: 0,
	skill: 1,
	mcp: 2,
});

const MATCH_PRIORITY: Readonly<Record<CommandMatchKind, number>> = Object.freeze({
	exact: 0,
	prefix: 1,
	fuzzy: 2,
});

interface RegisteredCommand {
	readonly command: CommandDefinition;
	readonly order: number;
}

export class CommandRegistry {
	readonly #commands = new Map<string, RegisteredCommand>();
	#nextOrder = 0;

	register(command: CommandDefinition): () => void {
		if (this.#commands.has(command.id)) throw new Error(`Command is already registered: ${command.id}`);
		const registered = Object.freeze({ command, order: this.#nextOrder++ });
		this.#commands.set(command.id, registered);
		return () => {
			if (this.#commands.get(command.id) === registered) this.#commands.delete(command.id);
		};
	}

	findById(id: string): CommandDefinition | undefined {
		return this.#commands.get(id)?.command;
	}

	search(query: string, options: CommandSearchOptions = { location: "composer_start" }): readonly CommandMatch[] {
		const normalizedQuery = normalize(query);
		const matches = [...this.#commands.values()]
			.filter(
				(registered) => registered.command.visibleInPalette !== false && isEligible(registered.command, options),
			)
			.flatMap((registered) => {
				const kind = matchKind(registered.command.name, normalizedQuery);
				return kind ? [{ ...registered, kind }] : [];
			});
		matches.sort(
			(left, right) =>
				MATCH_PRIORITY[left.kind] - MATCH_PRIORITY[right.kind] ||
				SOURCE_PRIORITY[left.command.source] - SOURCE_PRIORITY[right.command.source] ||
				left.order - right.order,
		);
		return matches.map(({ command, kind }) => Object.freeze({ command, kind }));
	}

	findExact(
		name: string,
		options: CommandSearchOptions = { location: "composer_start" },
	): readonly CommandDefinition[] {
		const normalizedName = normalize(name);
		return [...this.#commands.values()]
			.filter(
				(registered) =>
					isEligible(registered.command, options) &&
					[registered.command.name, ...(registered.command.aliases ?? [])].some(
						(candidate) => normalize(candidate) === normalizedName,
					),
			)
			.sort(
				(left, right) =>
					SOURCE_PRIORITY[left.command.source] - SOURCE_PRIORITY[right.command.source] || left.order - right.order,
			)
			.map(({ command }) => command);
	}
}

function isEligible(command: CommandDefinition, options: CommandSearchOptions): boolean {
	return options.location === "composer_start" || command.triggerScope === "token_boundary";
}

function matchKind(value: string, query: string): CommandMatchKind | undefined {
	const normalized = normalize(value);
	if (normalized === query) return "exact";
	if (normalized.startsWith(query)) return "prefix";
	return isSubsequence(query, normalized) ? "fuzzy" : undefined;
}

function isSubsequence(query: string, value: string): boolean {
	let queryIndex = 0;
	for (const character of value) {
		if (character === query[queryIndex]) queryIndex++;
		if (queryIndex === query.length) return true;
	}
	return query.length === 0;
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}
