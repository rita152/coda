import type {
	SkillActivation,
	SkillCandidate,
	SkillDiagnostic,
	SkillId,
	SkillRevision,
	SkillsSnapshot,
} from "@coda/skills";

export type CodingSkillScope = "workspace" | "user";

/** Product-owned provenance and precedence; the format loader treats this as opaque. */
export interface CodingSkillOrigin {
	readonly scope: CodingSkillScope;
	readonly root: string;
	readonly priority: number;
}

export interface WorkspaceSkillInventoryItem {
	readonly id: string;
	readonly path: string;
	readonly revision: string;
}

export interface WorkspaceSkillsTrustRecord {
	readonly workspace: string;
	readonly sha256: string;
	readonly inventory: readonly WorkspaceSkillInventoryItem[];
}

export interface WorkspaceSkillsInventoryDiff {
	readonly added: readonly WorkspaceSkillInventoryItem[];
	readonly removed: readonly WorkspaceSkillInventoryItem[];
	readonly changed: readonly {
		readonly before: WorkspaceSkillInventoryItem;
		readonly after: WorkspaceSkillInventoryItem;
	}[];
}

export interface WorkspaceSkillsInventory {
	readonly workspace: string;
	readonly sha256: string;
	readonly complete: boolean;
	readonly items: readonly WorkspaceSkillInventoryItem[];
	readonly trust: "not-required" | "trusted" | "untrusted" | "incomplete";
	readonly diff: WorkspaceSkillsInventoryDiff;
}

export interface ResolvedCodingSkill {
	readonly candidate: SkillCandidate<CodingSkillOrigin>;
	readonly origin: CodingSkillOrigin;
	readonly precedence: number;
	readonly winner: boolean;
	readonly collisionCount: number;
	readonly sourceLabel: string;
	readonly qualifiedName: string;
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
	readonly inventory: WorkspaceSkillsInventory;
	readonly candidates: readonly SkillCandidate<CodingSkillOrigin>[];
	readonly admitted: readonly ResolvedCodingSkill[];
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
