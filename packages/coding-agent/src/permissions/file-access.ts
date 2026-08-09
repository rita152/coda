import type { ToolInvocationId } from "@coda/agent";
import type { PathIntent, ResolvedWorkspacePath, Workspace } from "../workspace.ts";

/** File Tools fail closed unless the Permission Engine granted this exact invocation. */
export function hasPermissionedPathAccess(
	workspace: Workspace,
	resolved: ResolvedWorkspacePath,
	invocationId: ToolInvocationId,
	toolName: string,
	intent: PathIntent,
): boolean {
	return workspace.isPathGranted(invocationId, toolName, intent, resolved.canonicalPath);
}
