import type { SkillId } from "@coda/skills";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Resolves a catalog name or exact Skill id against the frozen Run snapshot. */
export function resolveSkillSelector(snapshot: CodingSkillsSnapshot, value: string): ResolvedCodingSkill | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const byId = snapshot.byId.get(trimmed as SkillId);
	if (byId) return byId;
	const normalized = normalize(trimmed);
	const winners = snapshot.resolved.filter(
		(entry) => entry.winner && normalize(entry.candidate.metadata.name) === normalized,
	);
	if (winners.length === 1) return winners[0];
	const qualified = snapshot.resolved.filter(
		(entry) => entry.qualifiedName === trimmed || normalize(entry.qualifiedName) === normalized,
	);
	return qualified.length === 1 ? qualified[0] : undefined;
}
