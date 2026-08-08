import { basename, relative, sep } from "node:path";
import type { PolicyGate, ToolInvocationId, ToolPolicyRequest } from "@coda/agent";
import type { PathIntent, ResolvedWorkspacePath, Workspace } from "./workspace.ts";

const FILE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

export interface WorkspacePolicyOptions {
	readonly mode: "interactive" | "print";
	readonly allowWorkspaceWrite: boolean;
	readonly allowBash: boolean;
	readonly approval?: ApprovalHandler;
}

export type ApprovalDecision = "allow_once" | "allow_run" | "deny" | "deny_and_abort";
export type ApprovalReason = "outside_workspace" | "protected_path" | "shell";

export interface ApprovalRequest {
	readonly runId: ToolPolicyRequest["runId"];
	readonly invocationId: ToolInvocationId;
	readonly toolName: string;
	readonly operation: "read" | "write" | "bash";
	readonly reason: ApprovalReason;
	readonly requestedPath?: string;
	readonly canonicalPath?: string;
	readonly command?: string;
	readonly diff?: string;
	readonly cwd: string;
	readonly grantScope: "operation" | "run";
	readonly hostAuthority: boolean;
}

export interface ApprovalHandler {
	decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface CodingPolicyGate extends PolicyGate {
	consumeAbort(invocationId: ToolInvocationId): boolean;
}

function requestedPath(request: ToolPolicyRequest): string | undefined {
	if (!FILE_TOOLS.has(request.toolName)) return undefined;
	const value = request.arguments.path;
	return typeof value === "string" ? value : undefined;
}

const PRIVATE_KEY_NAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const SENSITIVE_EXTENSIONS = [".cer", ".crt", ".key", ".p12", ".pem", ".pfx"];

export function isSensitivePath(workspace: Workspace, canonicalPath: string): boolean {
	const workspaceRelative = relative(workspace.root, canonicalPath);
	const segments = workspaceRelative.split(sep).map((segment) => segment.toLowerCase());
	if (segments.includes(".git") || segments.includes(".coda") || segments.includes(".ssh")) return true;
	const name = basename(canonicalPath).toLowerCase();
	if (name === ".env.example") return false;
	if (name === ".env" || name.startsWith(".env.")) return true;
	if (PRIVATE_KEY_NAMES.has(name)) return true;
	return SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function hasWorkspacePathAccess(
	workspace: Workspace,
	resolved: ResolvedWorkspacePath,
	invocationId: ToolInvocationId,
	toolName: string,
	intent: PathIntent,
): boolean {
	if (resolved.insideWorkspace && !isSensitivePath(workspace, resolved.canonicalPath)) return true;
	return workspace.isPathGranted(invocationId, toolName, intent, resolved.canonicalPath);
}

function fileIntent(toolName: string): PathIntent {
	return MUTATION_TOOLS.has(toolName) ? "write" : "read";
}

function recursiveAccess(toolName: string): boolean {
	return toolName === "grep" || toolName === "find" || toolName === "ls";
}

function mutationPreview(request: ToolPolicyRequest): string | undefined {
	if (request.toolName === "edit") {
		const oldText = typeof request.arguments.oldText === "string" ? request.arguments.oldText : "";
		const newText = typeof request.arguments.newText === "string" ? request.arguments.newText : "";
		return `--- current\n+++ proposed\n-${oldText}\n+${newText}`.slice(0, 4_096);
	}
	if (request.toolName === "write") {
		const content = typeof request.arguments.content === "string" ? request.arguments.content : "";
		return `Write ${content.length} characters${content ? `:\n${content}` : ""}`.slice(0, 4_096);
	}
	return undefined;
}

function protectedGrantKey(request: ToolPolicyRequest, intent: PathIntent, canonicalPath: string): string {
	return `${request.runId}\0${request.toolName}\0${intent}\0${canonicalPath}`;
}

export function createWorkspacePolicy(workspace: Workspace, options: WorkspacePolicyOptions): CodingPolicyGate {
	const shellRunGrants = new Set<string>();
	const protectedRunGrants = new Set<string>();
	const abortInvocations = new Set<ToolInvocationId>();

	const reject = (request: ToolPolicyRequest, reason: string, abort: boolean) => {
		if (abort) abortInvocations.add(request.invocationId);
		return { decision: "reject" as const, reason };
	};
	const decide = async (approval: ApprovalRequest): Promise<ApprovalDecision | undefined> => {
		if (options.mode !== "interactive" || !options.approval) return undefined;
		try {
			return await options.approval.decide(Object.freeze(approval));
		} catch {
			return "deny";
		}
	};

	return {
		check: async (request) => {
			if (request.toolName === "bash") {
				if (options.mode === "print") {
					return options.allowBash
						? { decision: "allow" }
						: { decision: "reject", reason: "Bash requires --allow-bash in print mode" };
				}
				if (shellRunGrants.has(request.runId)) return { decision: "allow" };
				const command = typeof request.arguments.command === "string" ? request.arguments.command : undefined;
				const decision = await decide({
					runId: request.runId,
					invocationId: request.invocationId,
					toolName: request.toolName,
					operation: "bash",
					reason: "shell",
					command,
					cwd: workspace.root,
					grantScope: "run",
					hostAuthority: true,
				});
				if (decision === "allow_run") shellRunGrants.add(request.runId);
				if (decision === "allow_once" || decision === "allow_run") return { decision: "allow" };
				return reject(
					request,
					decision ? "Bash was denied by the user" : "Bash requires interactive approval",
					decision === "deny_and_abort",
				);
			}
			const path = requestedPath(request);
			if (path === undefined) return { decision: "allow" };
			try {
				const intent = fileIntent(request.toolName);
				const resolved = await workspace.resolvePath(path, intent);
				if (MUTATION_TOOLS.has(request.toolName) && options.mode === "print" && !options.allowWorkspaceWrite) {
					return {
						decision: "reject",
						reason: "Workspace mutation requires --allow-workspace-write in print mode",
					};
				}
				const approvalReason: ApprovalReason | undefined = !resolved.insideWorkspace
					? "outside_workspace"
					: isSensitivePath(workspace, resolved.canonicalPath)
						? "protected_path"
						: undefined;
				if (!approvalReason) return { decision: "allow" };

				const grantKey = protectedGrantKey(request, intent, resolved.canonicalPath);
				if (approvalReason === "protected_path" && protectedRunGrants.has(grantKey)) {
					workspace.grantPath({
						invocationId: request.invocationId,
						toolName: request.toolName,
						intent,
						canonicalPath: resolved.canonicalPath,
						recursive: recursiveAccess(request.toolName),
					});
					return { decision: "allow" };
				}
				const decision = await decide({
					runId: request.runId,
					invocationId: request.invocationId,
					toolName: request.toolName,
					operation: intent,
					reason: approvalReason,
					requestedPath: path,
					canonicalPath: resolved.canonicalPath,
					diff: mutationPreview(request),
					cwd: workspace.root,
					grantScope: approvalReason === "outside_workspace" ? "operation" : "run",
					hostAuthority: true,
				});
				if (decision !== "allow_once" && decision !== "allow_run") {
					const reason =
						approvalReason === "outside_workspace"
							? `Path is outside the Workspace: ${resolved.canonicalPath}`
							: `Protected path requires explicit approval: ${resolved.canonicalPath}`;
					return reject(request, decision ? `${reason} (denied)` : reason, decision === "deny_and_abort");
				}
				if (approvalReason === "protected_path" && decision === "allow_run") {
					protectedRunGrants.add(grantKey);
				}
				workspace.grantPath({
					invocationId: request.invocationId,
					toolName: request.toolName,
					intent,
					canonicalPath: resolved.canonicalPath,
					recursive: recursiveAccess(request.toolName),
				});
				return { decision: "allow" };
			} catch (error) {
				return { decision: "reject", reason: error instanceof Error ? error.message : String(error) };
			}
		},
		consumeAbort: (invocationId) => abortInvocations.delete(invocationId),
	};
}
