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

const MENTION_NAME_PATTERN = /[A-Za-z0-9_:@-]/u;

export function isTriggerCompatibleName(name: string): boolean {
	return name.length > 0 && !/[\s$]/u.test(name);
}

export function isCommonEnvVar(name: string): boolean {
	return COMMON_ENV_VARS.has(name.toUpperCase());
}

/** Extracts `$name` tokens at Composer token boundaries, matching Codex-style mentions. */
export function extractDollarMentions(text: string): readonly DollarMention[] {
	const mentions: DollarMention[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "$") continue;
		if (!isMentionBoundary(text, index)) continue;
		const nameStart = index + 1;
		if (nameStart >= text.length || !MENTION_NAME_PATTERN.test(text[nameStart]!)) continue;
		let nameEnd = nameStart + 1;
		while (nameEnd < text.length && MENTION_NAME_PATTERN.test(text[nameEnd]!)) nameEnd++;
		const name = text.slice(nameStart, nameEnd);
		if (!isCommonEnvVar(name)) {
			mentions.push(Object.freeze({ name, start: index, end: nameEnd }));
		}
		index = nameEnd - 1;
	}
	return Object.freeze(mentions);
}

function isMentionBoundary(text: string, dollarIndex: number): boolean {
	if (dollarIndex === 0) return true;
	return /[\s([{]/u.test(text[dollarIndex - 1]!);
}
