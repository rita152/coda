import { basename, isAbsolute } from "node:path";

export type CommandRuleDecision = "allow" | "prompt" | "forbidden";
export type CommandRulePatternToken = string | readonly string[];

export interface CommandRule {
	readonly pattern: readonly CommandRulePatternToken[];
	readonly decision: CommandRuleDecision;
	readonly justification?: string;
}

export interface HostExecutable {
	readonly name: string;
	readonly paths: readonly string[];
}

export interface CommandPolicy {
	readonly rules: readonly CommandRule[];
	readonly hostExecutables: readonly HostExecutable[];
}

function patternMatches(rule: CommandRule, words: readonly string[]): boolean {
	if (rule.pattern.length === 0 || words.length < rule.pattern.length) return false;
	return rule.pattern.every((token, index) => {
		const word = words[index];
		if (word === undefined) return false;
		return (typeof token === "string" ? [token] : token).includes(word);
	});
}

/** Mirrors Codex execpolicy's exact-program-first and reviewed-basename fallback behavior. */
export function matchingCommandRules(
	rules: readonly CommandRule[],
	hostExecutables: readonly HostExecutable[],
	words: readonly string[],
): readonly CommandRule[] {
	if (words.length === 0) return Object.freeze([]);
	const exact = rules.filter((rule) => patternMatches(rule, words));
	if (exact.length > 0) return Object.freeze(exact);
	const executable = words[0]!;
	if (!isAbsolute(executable)) return Object.freeze([]);
	const name = basename(executable);
	const reviewed = [...hostExecutables].reverse().find((entry) => entry.name === name);
	if (!reviewed || !reviewed.paths.includes(executable)) return Object.freeze([]);
	const resolvedWords = [name, ...words.slice(1)];
	return Object.freeze(rules.filter((rule) => patternMatches(rule, resolvedWords)));
}
