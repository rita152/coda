import type {
	SkillActivation,
	SkillCandidate,
	SkillDiagnostic,
	SkillId,
	SkillRevision,
	SkillRoot,
	SkillsSnapshot,
} from "@coda/skills";

export type CodingSkillScope = "workspace" | "user";

export interface CodingSkillOrigin {
	readonly scope: CodingSkillScope;
	readonly root: string;
	readonly priority: number;
	readonly sourceLabel?: string;
	readonly kind?: "direct" | "plugin";
	readonly pluginName?: string;
	readonly pluginRoot?: string;
}

export interface ResolvedCodingSkill {
	readonly candidate: SkillCandidate<CodingSkillOrigin>;
	readonly origin: CodingSkillOrigin;
	readonly precedence: number;
	readonly winner: boolean;
	readonly collisionCount: number;
	readonly sourceLabel: string;
	readonly qualifiedName: string;
	readonly implicitInvocation: boolean;
}

export interface CodingSkillDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
	readonly skillId?: SkillId;
	readonly path?: string;
}

export interface CodingSkillsSnapshot {
	readonly loader: SkillsSnapshot<CodingSkillOrigin>;
	readonly roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly candidates: readonly SkillCandidate<CodingSkillOrigin>[];
	readonly resolved: readonly ResolvedCodingSkill[];
	readonly byId: ReadonlyMap<SkillId, ResolvedCodingSkill>;
	readonly diagnostics: readonly (CodingSkillDiagnostic | SkillDiagnostic<CodingSkillOrigin>)[];
	activate(
		id: SkillId,
		options?: { readonly arguments?: string; readonly signal?: AbortSignal },
	): Promise<SkillActivation<CodingSkillOrigin>>;
}

export interface SkillActivationProvenance {
	readonly id: SkillId;
	readonly revision: SkillRevision;
	readonly name: string;
	readonly source: string;
	readonly path: string;
}
