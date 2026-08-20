declare const skillIdBrand: unique symbol;
declare const skillRevisionBrand: unique symbol;

export type SkillId = string & { readonly [skillIdBrand]: "SkillId" };
export type SkillRevision = string & { readonly [skillRevisionBrand]: "SkillRevision" };

export type SkillFileKind = "directory" | "file" | "other" | "symbolic-link";

export interface SkillFileStatus {
	readonly kind: SkillFileKind;
	readonly size: number;
	readonly modifiedAt?: number;
	readonly device?: string;
	readonly inode?: string;
}

export interface SkillDirectoryEntry {
	readonly name: string;
	readonly kind: SkillFileKind;
}

export interface SkillFileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<SkillFileStatus>;
	lstat(path: string): Promise<SkillFileStatus>;
	readFile(path: string): Promise<Uint8Array>;
	readDirectory(path: string): Promise<readonly SkillDirectoryEntry[]>;
}

export interface SkillLimits {
	readonly maxDepth: number;
	readonly maxDirectories: number;
	readonly maxEntries: number;
	readonly maxSkills: number;
	readonly maxSkillFileBytes: number;
	readonly maxFrontmatterBytes: number;
	readonly maxYamlDepth: number;
	readonly maxResourceDepth: number;
	readonly maxResourceEntries: number;
	readonly maxConcurrentReads: number;
}

export const DEFAULT_SKILL_LIMITS: Readonly<SkillLimits> = Object.freeze({
	maxDepth: 6,
	maxDirectories: 2_000,
	maxEntries: 20_000,
	maxSkills: 1_000,
	maxSkillFileBytes: 256 * 1024,
	maxFrontmatterBytes: 32 * 1024,
	maxYamlDepth: 32,
	maxResourceDepth: 4,
	maxResourceEntries: 50,
	maxConcurrentReads: 16,
});

export type SkillSymlinkPolicy =
	| { readonly mode: "ignore" }
	| { readonly mode: "follow"; readonly containmentRoot: string }
	| { readonly mode: "follow"; readonly allowOutsideRoot: true };

export interface SkillRoot<Origin = unknown> {
	readonly path: string;
	readonly origin: Origin;
	readonly symlinks?: SkillSymlinkPolicy;
}

export type SkillLoadProfile = "compatible" | "strict";

export type SkillDiagnosticPhase = "discover" | "parse" | "validate" | "activate" | "resource";
export type SkillDiagnosticSeverity = "info" | "warning" | "error";

export type SkillDiagnosticCode =
	| "root-not-found"
	| "root-not-directory"
	| "root-read-failed"
	| "scan-depth-exceeded"
	| "scan-directory-limit-exceeded"
	| "scan-entry-limit-exceeded"
	| "skill-limit-exceeded"
	| "symlink-skipped"
	| "symlink-broken"
	| "symlink-outside-boundary"
	| "symlink-cycle"
	| "duplicate-canonical-path"
	| "skill-file-not-regular"
	| "skill-file-too-large"
	| "skill-read-failed"
	| "invalid-utf8"
	| "nul-byte"
	| "frontmatter-missing"
	| "frontmatter-unterminated"
	| "frontmatter-too-large"
	| "frontmatter-invalid"
	| "frontmatter-not-mapping"
	| "frontmatter-repaired-unquoted-colon"
	| "yaml-depth-exceeded"
	| "missing-name"
	| "invalid-name"
	| "name-directory-mismatch"
	| "missing-description"
	| "description-too-long"
	| "compatibility-too-long"
	| "invalid-field"
	| "invalid-metadata"
	| "unknown-field"
	| "activation-not-found"
	| "snapshot-stale"
	| "activation-read-failed"
	| "resource-limit-exceeded"
	| "resource-depth-exceeded"
	| "resource-read-failed"
	| "resource-symlink-skipped";

export interface SkillDiagnostic<Origin = unknown> {
	readonly code: SkillDiagnosticCode;
	readonly severity: SkillDiagnosticSeverity;
	readonly phase: SkillDiagnosticPhase;
	readonly message: string;
	readonly path?: string;
	readonly field?: string;
	readonly origin?: Origin;
	readonly recovered?: boolean;
}

export interface AgentSkillMetadata {
	readonly name: string;
	readonly description: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata: Readonly<Record<string, string>>;
	readonly allowedTools?: string;
	/** Retained non-standard field; still reported as `unknown-field`. */
	readonly disableModelInvocation?: boolean;
	/** Retained non-standard field; still reported as `unknown-field`. */
	readonly userInvocable?: boolean;
}

export interface ParsedAgentSkill {
	readonly metadata: AgentSkillMetadata;
	readonly body: string;
	readonly frontmatter: string;
	readonly conformant: boolean;
}

export interface SkillParseInput {
	readonly text: string;
	readonly directoryName: string;
	readonly path?: string;
	readonly maxFrontmatterBytes?: number;
	readonly maxYamlDepth?: number;
}

export interface SkillParseResult {
	readonly skill?: ParsedAgentSkill;
	readonly diagnostics: readonly SkillDiagnostic[];
}

export interface AgentSkillValidationInput {
	readonly text: string;
	readonly directoryName: string;
	readonly path?: string;
	readonly maxFrontmatterBytes?: number;
	readonly maxYamlDepth?: number;
}

export interface AgentSkillValidationResult {
	readonly valid: boolean;
	readonly skill?: ParsedAgentSkill;
	readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillProvenance<Origin = unknown> {
	readonly root: string;
	readonly origin: Origin;
	readonly depth: number;
}

export interface SkillCandidate<Origin = unknown> {
	readonly id: SkillId;
	readonly revision: SkillRevision;
	readonly directory: string;
	readonly skillFile: string;
	readonly metadata: AgentSkillMetadata;
	readonly conformant: boolean;
	readonly provenance: readonly SkillProvenance<Origin>[];
	readonly diagnostics: readonly SkillDiagnostic<Origin>[];
}

export interface SkillActivation<Origin = unknown> {
	readonly candidate: SkillCandidate<Origin>;
	readonly revision: SkillRevision;
	/** Exact, revision-bound SKILL.md text, including YAML frontmatter. */
	readonly contents: string;
	readonly body: string;
	readonly baseDirectory: string;
	readonly arguments?: string;
	readonly resources: readonly string[];
	readonly diagnostics: readonly SkillDiagnostic<Origin>[];
}

export type SkillActivationResult<Origin = unknown> =
	| {
			readonly ok: true;
			readonly activation: SkillActivation<Origin>;
			readonly diagnostics: readonly SkillDiagnostic<Origin>[];
	  }
	| {
			readonly ok: false;
			readonly diagnostic: SkillDiagnostic<Origin>;
			readonly diagnostics: readonly SkillDiagnostic<Origin>[];
	  };

export interface SkillActivationOptions {
	readonly arguments?: string;
	readonly signal?: AbortSignal;
}

export interface SkillsSnapshotRequest<Origin = unknown> {
	readonly roots: readonly SkillRoot<Origin>[];
	readonly profile?: SkillLoadProfile;
	readonly signal?: AbortSignal;
}

export interface SkillsSnapshot<Origin = unknown> {
	readonly candidates: readonly SkillCandidate<Origin>[];
	readonly diagnostics: readonly SkillDiagnostic<Origin>[];
	activate(id: SkillId, options?: SkillActivationOptions): Promise<SkillActivationResult<Origin>>;
}

export interface CreateSkillsOptions {
	readonly fileSystem: SkillFileSystem;
	readonly limits?: Partial<SkillLimits>;
}

export interface Skills<Origin = unknown> {
	snapshot(request: SkillsSnapshotRequest<Origin>): Promise<SkillsSnapshot<Origin>>;
}
