import type { PromptSkillCatalog } from "../prompt/prompt-builder.ts";
import type { CodingSkillsSnapshot } from "./types.ts";

export function promptSkillCatalog(
	snapshot: CodingSkillsSnapshot,
	contextWindow: number | undefined,
): PromptSkillCatalog {
	const fullEntryByName = new Map<string, string>();
	for (const entry of snapshot.admitted) {
		if (!fullEntryByName.has(entry.candidate.metadata.name)) {
			fullEntryByName.set(entry.candidate.metadata.name, String(entry.candidate.id));
		}
	}
	return Object.freeze({
		...(contextWindow === undefined ? {} : { contextWindow }),
		entries: Object.freeze(
			snapshot.admitted.map((entry) => {
				const surfaceWinner = fullEntryByName.get(entry.candidate.metadata.name) === String(entry.candidate.id);
				return Object.freeze({
					id: String(entry.candidate.id),
					name: entry.candidate.metadata.name,
					description: entry.candidate.metadata.description,
					source: entry.sourceLabel,
					priority: entry.precedence,
					winner: surfaceWinner,
					qualifiedName: surfaceWinner ? entry.candidate.metadata.name : entry.qualifiedName,
				});
			}),
		),
	});
}
