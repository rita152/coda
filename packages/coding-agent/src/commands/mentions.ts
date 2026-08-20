export interface DollarMention {
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

const COMMON_ENV_VARS = new Set([
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"PWD",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"TERM",
	"XDG_CONFIG_HOME",
]);

const MENTION_NAME_CHARACTER = /^[\p{L}\p{N}\p{M}_:@.-]$/u;

export function isTriggerCompatibleName(name: string): boolean {
	return name.length > 0 && Array.from(name).every((character) => MENTION_NAME_CHARACTER.test(character));
}

export function isCommonEnvVar(name: string): boolean {
	return COMMON_ENV_VARS.has(name.toUpperCase());
}

/**
 * Extracts catalog-shaped `$name` tokens. Installation and environment-variable
 * disambiguation belong to the resolver, which has the relevant Skill/MCP catalog.
 */
export function extractDollarMentions(text: string): readonly DollarMention[] {
	const mentions: DollarMention[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "$") continue;
		const nameStart = index + 1;
		const first = codePointAt(text, nameStart);
		if (!first || !MENTION_NAME_CHARACTER.test(first)) continue;
		let nameEnd = nameStart + first.length;
		while (nameEnd < text.length) {
			const next = codePointAt(text, nameEnd);
			if (!next || !MENTION_NAME_CHARACTER.test(next)) break;
			nameEnd += next.length;
		}
		const name = text.slice(nameStart, nameEnd);
		mentions.push(Object.freeze({ name, start: index, end: nameEnd }));
		index = nameEnd - 1;
	}
	return Object.freeze(mentions);
}

function codePointAt(text: string, index: number): string | undefined {
	const point = text.codePointAt(index);
	return point === undefined ? undefined : String.fromCodePoint(point);
}
