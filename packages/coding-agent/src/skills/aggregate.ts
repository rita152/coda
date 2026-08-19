import type {
	SkillActivationOptions,
	SkillActivationResult,
	SkillCandidate,
	SkillDiagnostic,
	SkillId,
	SkillsSnapshot,
} from "@coda/skills";
import type { CodingSkillOrigin } from "./types.ts";

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function candidatePriority(candidate: SkillCandidate<CodingSkillOrigin>): number {
	return candidate.provenance.reduce(
		(minimum, { origin }) => Math.min(minimum, origin.priority),
		Number.POSITIVE_INFINITY,
	);
}

function activationNotFound(id: SkillId): SkillActivationResult<CodingSkillOrigin> {
	const diagnostic: SkillDiagnostic<CodingSkillOrigin> = Object.freeze({
		code: "activation-not-found",
		severity: "error",
		phase: "activate",
		message: `Skill is not available in this snapshot: ${String(id)}`,
	});
	return Object.freeze({ ok: false, diagnostic, diagnostics: Object.freeze([diagnostic]) });
}

/** Combines immutable loader snapshots while retaining the activation owner for every selected candidate. */
export function aggregateSkillsSnapshots(
	snapshots: readonly SkillsSnapshot<CodingSkillOrigin>[],
	options: { readonly maxSkills: number },
): SkillsSnapshot<CodingSkillOrigin> {
	if (!Number.isSafeInteger(options.maxSkills) || options.maxSkills <= 0) {
		throw new TypeError("maxSkills must be a positive safe integer");
	}
	const selected = new Map<
		SkillId,
		{
			readonly candidate: SkillCandidate<CodingSkillOrigin>;
			readonly owner: SkillsSnapshot<CodingSkillOrigin>;
			readonly snapshotIndex: number;
		}
	>();
	for (const [snapshotIndex, snapshot] of snapshots.entries()) {
		for (const candidate of snapshot.candidates) {
			const current = selected.get(candidate.id);
			if (
				!current ||
				candidatePriority(candidate) < candidatePriority(current.candidate) ||
				(candidatePriority(candidate) === candidatePriority(current.candidate) &&
					(compareText(candidate.skillFile, current.candidate.skillFile) < 0 ||
						(candidate.skillFile === current.candidate.skillFile && snapshotIndex < current.snapshotIndex)))
			) {
				selected.set(candidate.id, { candidate, owner: snapshot, snapshotIndex });
			}
		}
	}
	const ordered = [...selected.values()].sort(
		(left, right) =>
			candidatePriority(left.candidate) - candidatePriority(right.candidate) ||
			compareText(left.candidate.skillFile, right.candidate.skillFile) ||
			left.snapshotIndex - right.snapshotIndex,
	);
	const entries = ordered
		.slice(0, options.maxSkills)
		.sort((left, right) => compareText(String(left.candidate.id), String(right.candidate.id)));
	const limitDiagnostic: SkillDiagnostic<CodingSkillOrigin> | undefined =
		ordered.length > entries.length
			? Object.freeze({
					code: "skill-limit-exceeded",
					severity: "error" as const,
					phase: "discover" as const,
					message: `Combined Skill Inventory exceeds ${options.maxSkills} Skills`,
				})
			: undefined;
	const ownerById = new Map(entries.map(({ candidate, owner }) => [candidate.id, owner] as const));
	return Object.freeze({
		candidates: Object.freeze(entries.map(({ candidate }) => candidate)),
		diagnostics: Object.freeze([
			...snapshots.flatMap(({ diagnostics }) => diagnostics),
			...(limitDiagnostic ? [limitDiagnostic] : []),
		]),
		activate: (id: SkillId, options?: SkillActivationOptions) =>
			ownerById.get(id)?.activate(id, options) ?? Promise.resolve(activationNotFound(id)),
	});
}
