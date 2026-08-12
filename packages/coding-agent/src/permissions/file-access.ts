import type { ToolInvocationId } from "@coda/agent";
import type { PathIntent, ResolvedWorkspacePath, Workspace } from "../workspace.ts";
import type { PermissionEngine } from "./permission-engine.ts";

/** File Tools fail closed unless the Permission Engine granted this exact invocation. */
export function hasPermissionedPathAccess(
	workspace: Workspace,
	resolved: ResolvedWorkspacePath,
	invocationId: ToolInvocationId,
	toolName: string,
	intent: PathIntent,
	permissions?: Pick<PermissionEngine, "readAccessPolicyFor">,
): boolean {
	if (!workspace.isPathGranted(invocationId, toolName, intent, resolved.canonicalPath)) return false;
	if (intent === "write") return true;
	return permissions?.readAccessPolicyFor(invocationId)?.evaluate(resolved.canonicalPath).decision === "allow";
}
