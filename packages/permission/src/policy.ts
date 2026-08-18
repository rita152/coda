import { isAbsolute, normalize, resolve, sep } from "node:path";
import { isDangerousCommand, isKnownSafeCommand, shellCommandForToolInput } from "./command-safety.ts";
import { sandboxPermissionRequestReason } from "./sandbox-permissions.ts";
import {
	type ApprovalPolicy,
	type CommandPermissionDecision,
	type CommandPermissionPolicy,
	type CommandPermissionPolicyOptions,
	type CommandPermissionRequest,
	type FilesystemAccess,
	type RememberedCommandPermission,
	requestsSandboxOverride,
} from "./types.ts";

const READ_ONLY_TOOLS = new Set(["read", "read_session_history", "read_tool_output", "grep", "find", "ls"]);

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

const TOOL_NAMES = new Map([
	["Bash", "bash"],
	["Write", "write"],
	["Edit", "edit"],
	["Process", "process"],
]);

export const NEVER_PROMPT_REASON = "approval required by policy, but AskForApproval is set to Never";
export const WRITE_REJECTED_OUTSIDE_PROJECT_REASON =
	"writing outside of the project; rejected by user approval settings";
export const WRITE_REJECTED_READ_ONLY_REASON =
	"writing is blocked by read-only sandbox; rejected by user approval settings";

function canonicalToolName(toolName: string): string {
	return TOOL_NAMES.get(toolName) ?? toolName;
}

function isReadOnlyProcess(tool: string, toolInput: Readonly<Record<string, unknown>>): boolean {
	return tool === "process" && toolInput.action === "poll";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function commandPermissionKey(request: Pick<CommandPermissionRequest, "toolName" | "toolInput">): string {
	return `${canonicalToolName(request.toolName)}\0${canonical(request.toolInput)}`;
}

function summarize(request: CommandPermissionRequest): string {
	const command = request.toolInput.command;
	if (typeof command === "string" && command.trim().length > 0) return command.trim();
	const path = request.toolInput.path;
	if (typeof path === "string" && path.trim().length > 0) return path.trim();
	return canonical(request.toolInput);
}

export function commandPermissionPrompt(request: CommandPermissionRequest): string {
	const prompt = `Allow ${request.toolName}?\n${summarize(request)}`;
	const justification = request.toolInput.justification;
	if (typeof justification === "string" && justification.length > 0) {
		return `${prompt}\n${justification}`;
	}
	return prompt;
}

function applies(record: RememberedCommandPermission, request: CommandPermissionRequest, key: string): boolean {
	if (record.key !== key) return false;
	if (record.scope === "session") return true;
	return record.workspace === request.workspace;
}

function ask(request: CommandPermissionRequest): CommandPermissionDecision {
	return { kind: "ask", prompt: commandPermissionPrompt(request) };
}

function resolveCandidate(workspace: string, path: string): string {
	return normalize(isAbsolute(path) ? path : resolve(workspace, path));
}

function pathEqualsOrInside(root: string, path: string): boolean {
	const normalizedRoot = normalize(root);
	if (path === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return path.startsWith(prefix);
}

function isWritablePath(
	path: string,
	workspace: string,
	writableRoots: readonly string[],
	denyWrite: readonly string[],
): boolean {
	const resolved = resolveCandidate(workspace, path);
	if (denyWrite.some((root) => pathEqualsOrInside(root, resolved))) return false;
	return writableRoots.some((root) => pathEqualsOrInside(root, resolved));
}

function fileWritePaths(request: CommandPermissionRequest): string[] {
	const tool = canonicalToolName(request.toolName);
	if (tool === "write" || tool === "edit") {
		return typeof request.toolInput.path === "string" && request.toolInput.path.length > 0
			? [request.toolInput.path]
			: [];
	}
	return [];
}

function assessFileWrite(
	request: CommandPermissionRequest,
	approvalPolicy: ApprovalPolicy,
	filesystemAccess: FilesystemAccess,
	writableRoots: readonly string[],
	denyWrite: readonly string[],
	filesystemEnforced: boolean,
): CommandPermissionDecision {
	const paths = fileWritePaths(request);
	if (paths.length === 0) return { kind: "deny", reason: "empty write path" };
	if (approvalPolicy === "untrusted") return ask(request);
	const constrained =
		filesystemAccess === "unrestricted" ||
		paths.every((path) => isWritablePath(path, request.workspace, writableRoots, denyWrite));
	if (constrained) {
		if (filesystemAccess === "restricted" && filesystemEnforced === false) {
			return approvalPolicy === "never"
				? {
						kind: "deny",
						reason:
							writableRoots.length === 0
								? WRITE_REJECTED_READ_ONLY_REASON
								: WRITE_REJECTED_OUTSIDE_PROJECT_REASON,
					}
				: ask(request);
		}
		return { kind: "allow" };
	}
	if (approvalPolicy === "never") {
		return {
			kind: "deny",
			reason: writableRoots.length === 0 ? WRITE_REJECTED_READ_ONLY_REASON : WRITE_REJECTED_OUTSIDE_PROJECT_REASON,
		};
	}
	return ask(request);
}

function assessExec(
	request: CommandPermissionRequest,
	approvalPolicy: ApprovalPolicy,
	filesystemAccess: FilesystemAccess,
	filesystemEnforced: boolean,
): CommandPermissionDecision {
	const invalid = sandboxPermissionRequestReason(request.toolInput, approvalPolicy);
	if (invalid) return { kind: "deny", reason: invalid };
	const command = shellCommandForToolInput(request.toolInput);
	const knownSafe = command !== undefined && isKnownSafeCommand(command);
	const dangerous = command !== undefined && isDangerousCommand(command);
	const override = request.sandboxOverride === true || requestsSandboxOverride(request.toolInput);
	if (knownSafe && !override) return { kind: "allow" };
	if (dangerous) {
		return approvalPolicy === "never" ? { kind: "deny", reason: NEVER_PROMPT_REASON } : ask(request);
	}
	if (approvalPolicy === "never") {
		if (override) return { kind: "deny", reason: NEVER_PROMPT_REASON };
		if (filesystemAccess === "restricted" && filesystemEnforced === false) {
			return { kind: "deny", reason: NEVER_PROMPT_REASON };
		}
		return { kind: "allow" };
	}
	if (approvalPolicy === "untrusted") return ask(request);
	if (filesystemAccess === "unrestricted") return { kind: "allow" };
	if (override) return ask(request);
	if (filesystemEnforced === false) return ask(request);
	return { kind: "allow" };
}

export function createCommandPermissionPolicy(options: CommandPermissionPolicyOptions = {}): CommandPermissionPolicy {
	let approvalPolicy = options.approvalPolicy ?? "on-request";
	let filesystemAccess = options.filesystemAccess ?? "unrestricted";
	let writableRoots = options.writableRoots ?? [];
	let denyWrite = options.denyWrite ?? [];
	let filesystemEnforced = options.filesystemEnforced ?? true;
	const records = [...(options.remembered ?? [])];
	return {
		decide(request) {
			const key = commandPermissionKey(request);
			const remembered = [...records].reverse().find((record) => applies(record, request, key));
			if (remembered?.decision === "allow") return { kind: "allow" };
			if (remembered?.decision === "deny") {
				return { kind: "deny", reason: remembered.reason ?? "Command Permission denied this Tool Invocation" };
			}
			const tool = canonicalToolName(request.toolName);
			if (READ_ONLY_TOOLS.has(tool) || isReadOnlyProcess(tool, request.toolInput)) return { kind: "allow" };
			if (FILE_WRITE_TOOLS.has(tool)) {
				return assessFileWrite(
					request,
					approvalPolicy,
					filesystemAccess,
					writableRoots,
					denyWrite,
					filesystemEnforced,
				);
			}
			return assessExec(request, approvalPolicy, filesystemAccess, filesystemEnforced);
		},
		remember(request, decision) {
			const record: RememberedCommandPermission = Object.freeze({
				key: commandPermissionKey(request),
				decision: decision.kind,
				...(decision.kind === "deny" ? { reason: decision.reason } : {}),
				scope: decision.remember ?? "session",
				...((decision.remember === "workspace" || decision.remember === "user") && request.workspace
					? { workspace: request.workspace }
					: {}),
			});
			records.push(record);
			return record;
		},
		remembered() {
			return Object.freeze([...records]);
		},
		configure(next) {
			if (next.approvalPolicy !== undefined) approvalPolicy = next.approvalPolicy;
			if (next.filesystemAccess !== undefined) filesystemAccess = next.filesystemAccess;
			if (next.writableRoots !== undefined) writableRoots = next.writableRoots;
			if (next.denyWrite !== undefined) denyWrite = next.denyWrite;
			if (next.filesystemEnforced !== undefined) filesystemEnforced = next.filesystemEnforced;
		},
		snapshot() {
			return Object.freeze({
				approvalPolicy,
				filesystemAccess,
				writableRoots: Object.freeze([...writableRoots]),
				denyWrite: Object.freeze([...denyWrite]),
				filesystemEnforced,
			});
		},
	};
}
