import { isAbsolute, join, normalize } from "node:path";

export const PROTECTED_METADATA_NAMES = Object.freeze([".git", ".agents", ".codex", ".coda"] as const);
const SYSTEM_TEMPORARY_DIRECTORY = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const COMPILED_SANDBOX_POLICY = Symbol("@coda/sandbox compiled policy");

export type PermissionProfile = "read-only" | "workspace" | "full-access";
export type NetworkAccess = "restricted" | "enabled";

export interface SandboxPolicyInput {
	readonly profile: PermissionProfile;
	readonly workspaceRoots: readonly string[];
	readonly temporaryDirectory: string;
	readonly additionalWritableRoots?: readonly string[];
}

export interface CompiledSandboxPolicy {
	readonly [COMPILED_SANDBOX_POLICY]: true;
	readonly profile: PermissionProfile;
	readonly readAccess: "full-disk";
	/** Exact path roots that remain unreadable even when the profile otherwise permits full-disk reads. */
	readonly deniedReadRoots: readonly string[];
	readonly writableRoots: readonly string[] | "full-disk";
	readonly protectedMetadataRoots: readonly string[];
	readonly protectedMetadataNames: readonly string[];
	/** Lexical protected paths plus any canonical targets materialized immediately before launch. */
	readonly protectedMetadataPaths: readonly string[];
	readonly networkAccess: NetworkAccess;
}

function canonicalAbsolute(path: string, label: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new SandboxPolicyError(`${label} must be a canonical absolute path: ${JSON.stringify(path)}`);
	}
	return path;
}

function uniqueRoots(roots: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(roots)]);
}

export class SandboxPolicyError extends Error {
	readonly code = "invalid_policy";

	constructor(message: string) {
		super(message);
		this.name = "SandboxPolicyError";
	}
}

export function isCompiledSandboxPolicy(value: unknown): value is Readonly<CompiledSandboxPolicy> {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { readonly [COMPILED_SANDBOX_POLICY]?: unknown })[COMPILED_SANDBOX_POLICY] === true
	);
}

export function compileSandboxPolicy(input: SandboxPolicyInput): Readonly<CompiledSandboxPolicy> {
	const workspaceRoots = input.workspaceRoots.map((root) => canonicalAbsolute(root, "workspace root"));
	const temporaryDirectory = canonicalAbsolute(input.temporaryDirectory, "temporary directory");
	const additionalRoots = (input.additionalWritableRoots ?? []).map((root) =>
		canonicalAbsolute(root, "additional writable root"),
	);
	const writableRoots =
		input.profile === "full-access"
			? "full-disk"
			: input.profile === "workspace"
				? uniqueRoots([...workspaceRoots, SYSTEM_TEMPORARY_DIRECTORY, temporaryDirectory, ...additionalRoots])
				: Object.freeze([]);
	// Every restricted writable root gets the same protected-name carve-outs.
	// A more specific reviewed write root can reopen an exact descendant later,
	// matching Codex's shallow-to-deep filesystem rule precedence.
	const protectedMetadataRoots = writableRoots === "full-disk" ? Object.freeze([]) : uniqueRoots(writableRoots);
	const protectedMetadataPaths = uniqueRoots(
		protectedMetadataRoots.flatMap((root) => PROTECTED_METADATA_NAMES.map((name) => join(root, name))),
	);

	return Object.freeze({
		[COMPILED_SANDBOX_POLICY]: true as const,
		profile: input.profile,
		readAccess: "full-disk",
		deniedReadRoots: Object.freeze([]),
		writableRoots,
		protectedMetadataRoots,
		protectedMetadataNames: PROTECTED_METADATA_NAMES,
		protectedMetadataPaths,
		networkAccess: input.profile === "full-access" ? "enabled" : "restricted",
	});
}
