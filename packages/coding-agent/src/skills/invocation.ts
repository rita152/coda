import { join } from "node:path";
import type { SkillCandidate, SkillFileSystem, SkillId } from "@coda/skills";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

const OPENAI_POLICY = /^[ \t]*allow_implicit_invocation:[ \t]*(true|false)[ \t]*(?:#.*)?$/mu;

export function allowsImplicitInvocation(input: {
	readonly disableModelInvocation?: boolean;
	readonly sidecarAllowImplicit?: boolean;
}): boolean {
	if (input.disableModelInvocation === true) return false;
	if (input.sidecarAllowImplicit === false) return false;
	return true;
}

export function parseAllowImplicitInvocation(text: string): boolean | undefined {
	const match = OPENAI_POLICY.exec(text);
	if (!match) return undefined;
	return match[1] === "true";
}

export function modelVisibleSkills(snapshot: CodingSkillsSnapshot): readonly ResolvedCodingSkill[] {
	return snapshot.resolved.filter((entry) => entry.implicitInvocation);
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as Error & { readonly code?: unknown }).code)
		: undefined;
}

/** Reads Codex `agents/openai.yaml` policy without failing Skill discovery. */
export async function readSidecarImplicitInvocation(
	fileSystem: SkillFileSystem,
	candidates: readonly SkillCandidate[],
): Promise<ReadonlyMap<SkillId, boolean>> {
	const entries = await Promise.all(
		candidates.map(async (candidate) => {
			const path = join(candidate.directory, "agents", "openai.yaml");
			try {
				const text = new TextDecoder().decode(await fileSystem.readFile(path));
				const allow = parseAllowImplicitInvocation(text);
				return allow === undefined ? undefined : ([candidate.id, allow] as const);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return undefined;
				return undefined;
			}
		}),
	);
	return new Map(entries.filter((entry): entry is readonly [SkillId, boolean] => entry !== undefined));
}
