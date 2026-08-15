import type { SkillId } from "@coda/skills";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import type { CommandRegistry } from "./registry.ts";
import { registerSlashExtension, type SlashExtensionEntry } from "./unified-registry.ts";

function slashCompatible(name: string): boolean {
	return name.length > 0 && !/[\s/]/u.test(name);
}

/** Projects Skills into stable Composer entries without coupling Skills state to Commands. */
export function skillExtensionEntries(snapshot: CodingSkillsSnapshot): readonly SlashExtensionEntry[] {
	const shortAliasByName = new Map<string, SkillId>();
	for (const entry of snapshot.resolved) {
		if (!shortAliasByName.has(entry.candidate.metadata.name)) {
			shortAliasByName.set(entry.candidate.metadata.name, entry.candidate.id);
		}
	}
	return Object.freeze(
		snapshot.resolved.flatMap((entry) => {
			const surfaceWinner = shortAliasByName.get(entry.candidate.metadata.name) === entry.candidate.id;
			const name = surfaceWinner ? entry.candidate.metadata.name : entry.qualifiedName;
			if (!slashCompatible(name)) return [];
			const id = String(entry.candidate.id).replace(/^skill:/u, "");
			return [
				Object.freeze({
					id,
					name,
					title: entry.candidate.metadata.name,
					description: entry.candidate.metadata.description,
				}),
			];
		}),
	);
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
				next.push(registerSlashExtension(this.#registry, "skill", entry));
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
