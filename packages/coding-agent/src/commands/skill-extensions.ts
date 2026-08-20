import type { SkillId } from "@coda/skills";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "../skills/types.ts";
import { extractDollarMentions, isTriggerCompatibleName } from "./mentions.ts";
import type { CommandRegistry } from "./registry.ts";
import { type CommandExtensionEntry, registerCommandExtension } from "./unified-registry.ts";

/** Projects Skills into stable Composer entries without coupling Skills state to Commands. */
export function skillExtensionEntries(snapshot: CodingSkillsSnapshot): readonly CommandExtensionEntry[] {
	return Object.freeze(
		snapshot.resolved.flatMap((entry) => {
			const name = skillComposerName(entry);
			if (!isTriggerCompatibleName(name)) return [];
			const id = String(entry.candidate.id).replace(/^skill:/u, "");
			return [
				Object.freeze({
					id,
					name,
					title: entry.interface?.displayName ?? entry.candidate.metadata.name,
					description: entry.interface?.shortDescription ?? entry.candidate.metadata.description,
					...(entry.interface?.defaultPrompt
						? {
								defaultPrompt: qualifiedDefaultPrompt(
									entry.interface.defaultPrompt,
									entry.candidate.metadata.name,
									name,
								),
							}
						: {}),
				}),
			];
		}),
	);
}

export function skillComposerName(entry: ResolvedCodingSkill): string {
	if (entry.origin.kind === "plugin") return entry.qualifiedName;
	return entry.winner ? entry.candidate.metadata.name : entry.qualifiedName;
}

function qualifiedDefaultPrompt(prompt: string, canonicalName: string, surfaceName: string): string {
	let result = prompt.trim();
	const canonicalMentions = extractDollarMentions(result).filter(({ name }) => name === canonicalName);
	for (const mention of [...canonicalMentions].reverse()) {
		result = `${result.slice(0, mention.start)}$${surfaceName}${result.slice(mention.end)}`;
	}
	if (!extractDollarMentions(result).some(({ name }) => name === surfaceName)) {
		result = `$${surfaceName} ${result}`;
	}
	return result;
}

export function skillIdFromCommandId(commandId: string): SkillId | undefined {
	return /^skill:[a-f0-9]{32}$/u.test(commandId) ? (commandId as SkillId) : undefined;
}

export class SkillCommandRegistryBinding {
	readonly #registry: CommandRegistry;
	#dispose: readonly (() => void)[] = [];

	constructor(registry: CommandRegistry) {
		this.#registry = registry;
	}

	sync(snapshot: CodingSkillsSnapshot): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
		const next: (() => void)[] = [];
		try {
			for (const entry of skillExtensionEntries(snapshot)) {
				next.push(registerCommandExtension(this.#registry, "skill", entry));
			}
			this.#dispose = Object.freeze(next);
		} catch (error) {
			for (const dispose of next.reverse()) dispose();
			throw error;
		}
	}

	dispose(): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
	}
}
