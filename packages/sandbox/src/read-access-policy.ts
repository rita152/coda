import { isAbsolute, normalize, relative, sep } from "node:path";
import type { CompiledSandboxPolicy } from "./policy.ts";

export type ReadAccessDecision =
	| {
			readonly decision: "allow";
			readonly source: "full-access" | "readable-root" | "approved-root";
	  }
	| {
			readonly decision: "deny";
			readonly reason: "outside-readable-roots" | "denied-read-root" | "invalid-path";
	  };

/**
 * The single read-authority projection shared by native File Tools and model-started processes.
 * Callers must evaluate canonical absolute paths. The wrapped Sandbox policy is the exact process
 * policy corresponding to the same decision rules.
 */
export interface ReadAccessPolicy {
	readonly sandboxPolicy: Readonly<CompiledSandboxPolicy>;
	evaluate(canonicalPath: string): ReadAccessDecision;
	withApprovedRoots(canonicalRoots: readonly string[]): ReadAccessPolicy;
}

function isCanonicalAbsolute(path: string): boolean {
	return isAbsolute(path) && normalize(path) === path && !path.includes("\0");
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function evaluate(policy: Readonly<CompiledSandboxPolicy>, canonicalPath: string): ReadAccessDecision {
	if (!isCanonicalAbsolute(canonicalPath)) return { decision: "deny", reason: "invalid-path" };
	if (policy.readAccess === "full-disk") return { decision: "allow", source: "full-access" };
	const containingDeniedRoot = policy.deniedReadRoots.find((root) => isContained(root, canonicalPath));
	const containingApprovedRoot = policy.approvedReadRoots.find((root) => isContained(root, canonicalPath));
	if (
		containingDeniedRoot &&
		(!containingApprovedRoot || !isContained(containingDeniedRoot, containingApprovedRoot))
	) {
		return { decision: "deny", reason: "denied-read-root" };
	}
	if (containingApprovedRoot) return { decision: "allow", source: "approved-root" };
	if (!policy.readableRoots.some((root) => isContained(root, canonicalPath))) {
		return { decision: "deny", reason: "outside-readable-roots" };
	}
	return { decision: "allow", source: "readable-root" };
}

export function createReadAccessPolicy(policy: Readonly<CompiledSandboxPolicy>): ReadAccessPolicy {
	const readAccessPolicy: ReadAccessPolicy = {
		sandboxPolicy: policy,
		evaluate: (canonicalPath) => evaluate(policy, canonicalPath),
		withApprovedRoots: (canonicalRoots) => {
			if (canonicalRoots.length === 0 || policy.readAccess === "full-disk") return readAccessPolicy;
			for (const root of canonicalRoots) {
				if (!isCanonicalAbsolute(root)) {
					throw new Error(`approved read root must be a canonical absolute path: ${JSON.stringify(root)}`);
				}
			}
			const approvedReadRoots = Object.freeze([...new Set([...policy.approvedReadRoots, ...canonicalRoots])]);
			if (approvedReadRoots.length === policy.approvedReadRoots.length) return readAccessPolicy;
			return createReadAccessPolicy(Object.freeze({ ...policy, approvedReadRoots }));
		},
	};
	return Object.freeze(readAccessPolicy);
}
