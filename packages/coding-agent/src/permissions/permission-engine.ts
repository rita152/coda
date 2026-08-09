import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PolicyGate, ToolInvocationId, ToolPolicyDecision, ToolPolicyRequest } from "@coda/agent";
import type {
	CompiledSandboxPolicy,
	ManagedNetworkDecision,
	ManagedNetworkDestination,
	ManagedNetworkPolicy,
} from "@coda/sandbox";
import { normalizeNetworkHost, PROTECTED_METADATA_NAMES } from "@coda/sandbox";
import type { PathIntent, ResolvedWorkspacePath, Workspace } from "../workspace.ts";
import {
	type CommandRule,
	type CommandRuleDecision,
	type HostExecutable,
	matchingCommandRules,
} from "./command-policy.ts";

export type { CommandRule, CommandRuleDecision, CommandRulePatternToken, HostExecutable } from "./command-policy.ts";

const FILE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const BANNED_PREFIX_SUGGESTIONS = new Set(
	[
		["/bin/bash"],
		["/bin/bash", "-c"],
		["/bin/bash", "-lc"],
		["/bin/sh"],
		["/bin/sh", "-c"],
		["/bin/sh", "-lc"],
		["/bin/zsh"],
		["/bin/zsh", "-c"],
		["/bin/zsh", "-lc"],
		["Rscript"],
		["bash"],
		["bash", "-c"],
		["bash", "-lc"],
		["bun"],
		["bun", "-e"],
		["bun", "run"],
		["cmd"],
		["cmd", "/c"],
		["cmd", "/k"],
		["cmd.exe"],
		["cmd.exe", "/c"],
		["cmd.exe", "/k"],
		["dash"],
		["dash", "-c"],
		["deno"],
		["deno", "eval"],
		["env"],
		["fish"],
		["fish", "-c"],
		["git"],
		["julia"],
		["julia", "-e"],
		["ksh"],
		["ksh", "-c"],
		["lua"],
		["lua", "-e"],
		["node"],
		["node", "-e"],
		["nodejs"],
		["nodejs", "-e"],
		["npm", "run"],
		["osascript"],
		["perl"],
		["perl", "-e"],
		["php"],
		["php", "-r"],
		["pnpm", "run"],
		["powershell"],
		["powershell", "-Command"],
		["powershell", "-EncodedCommand"],
		["powershell", "-File"],
		["powershell", "-c"],
		["powershell.exe"],
		["powershell.exe", "-Command"],
		["powershell.exe", "-EncodedCommand"],
		["powershell.exe", "-File"],
		["powershell.exe", "-c"],
		["pwsh"],
		["pwsh", "-Command"],
		["pwsh", "-EncodedCommand"],
		["pwsh", "-File"],
		["pwsh", "-c"],
		["pwsh", "-e"],
		["pwsh", "-ec"],
		["pwsh", "-f"],
		["py"],
		["py", "-3"],
		["pypy"],
		["pypy3"],
		["python"],
		["python", "-"],
		["python", "-c"],
		["python3"],
		["python3", "-"],
		["python3", "-c"],
		["pythonw"],
		["pyw"],
		["rm"],
		["ruby"],
		["ruby", "-e"],
		["sh"],
		["sh", "-c"],
		["sh", "-lc"],
		["sudo"],
		["yarn", "run"],
		["zsh"],
		["zsh", "-c"],
		["zsh", "-lc"],
	].map((prefix) => JSON.stringify(prefix)),
);

export interface GranularApprovalPolicy {
	readonly mode: "granular";
	readonly sandboxApproval: boolean;
	readonly rules: boolean;
	readonly skillApproval: boolean;
	readonly requestPermissions: boolean;
	readonly mcpElicitations: boolean;
}

export type ApprovalPolicy = "unless-trusted" | "on-request" | "never" | GranularApprovalPolicy;
export type SandboxPermissions = "use_default" | "require_escalated" | "with_additional_permissions";

export interface AdditionalPermissionProfile {
	readonly network?: { readonly enabled?: boolean };
	readonly file_system?: {
		readonly read?: readonly string[];
		readonly write?: readonly string[];
	};
}

export type ApprovalDecision =
	| { readonly type: "approved" }
	| { readonly type: "approved-for-session" }
	| { readonly type: "approved-execpolicy-amendment"; readonly command: readonly string[] }
	| {
			readonly type: "network-policy-amendment";
			readonly host: string;
			readonly action: "allow" | "deny";
	  }
	| { readonly type: "denied"; readonly rejection: string }
	| { readonly type: "timed-out" }
	| { readonly type: "abort" };

export interface PermissionApprovalRequest {
	readonly kind: "command" | "filesystem" | "network" | "skill" | "mcp";
	readonly runId: ToolPolicyRequest["runId"];
	readonly turnId: ToolPolicyRequest["turnId"];
	readonly invocationId: ToolInvocationId;
	readonly command?: string;
	readonly commandWords?: readonly string[];
	readonly cwd: string;
	readonly reason: string;
	readonly toolName?: string;
	readonly operation?: "read" | "write";
	readonly requestedPath?: string;
	readonly canonicalPath?: string;
	readonly diff?: string;
	readonly justification?: string;
	readonly additionalPermissions?: AdditionalPermissionProfile;
	readonly sandboxPermissions?: SandboxPermissions;
	readonly proposedCommandRule?: readonly string[];
	readonly environmentId?: string;
	readonly host?: string;
	readonly protocol?: "http" | "https";
	readonly port?: number;
}

export interface PermissionApprovalHandler {
	decide(request: PermissionApprovalRequest): Promise<ApprovalDecision>;
}

export interface ShellAuthorization {
	readonly execution: "sandboxed" | "unsandboxed";
	readonly policy: Readonly<CompiledSandboxPolicy>;
	readonly sandboxPermissions: SandboxPermissions;
	readonly additionalPermissions?: AdditionalPermissionProfile;
	readonly commandWords: readonly string[];
	readonly managedNetwork?: ManagedNetworkPolicy;
}

export interface PermissionEngine extends PolicyGate {
	authorizationFor(invocationId: ToolInvocationId): ShellAuthorization | undefined;
	sandboxPolicyFor(invocationId: ToolInvocationId): Readonly<CompiledSandboxPolicy> | undefined;
	configuration(): PermissionConfiguration;
	update(configuration: PermissionConfiguration): void;
	consumeAbort(invocationId: ToolInvocationId): boolean;
	requestGenericApproval(request: GenericPermissionRequest): Promise<ToolPolicyDecision>;
}

export interface GenericPermissionRequest {
	readonly kind: "skill" | "mcp";
	readonly runId: ToolPolicyRequest["runId"];
	readonly turnId: ToolPolicyRequest["turnId"];
	readonly invocationId: ToolInvocationId;
	readonly reason: string;
	readonly toolName?: string;
	readonly justification?: string;
}

export interface PermissionConfiguration {
	readonly profile: Readonly<CompiledSandboxPolicy>;
	readonly approvalPolicy: ApprovalPolicy;
}

export interface PermissionEngineOptions {
	readonly cwd: string;
	/** Stable execution-environment identity included in Session approval keys. */
	readonly environmentId?: string;
	/** Exact shell executable used by the model Bash Tool. */
	readonly shellExecutable?: string;
	readonly workspace?: Workspace;
	readonly profile: Readonly<CompiledSandboxPolicy>;
	readonly approvalPolicy: ApprovalPolicy;
	readonly approval: PermissionApprovalHandler;
	readonly commandRules?: readonly CommandRule[];
	readonly hostExecutables?: readonly HostExecutable[];
	readonly persistCommandRule?: (rule: CommandRule) => Promise<void>;
	readonly networkRules?: readonly NetworkRule[];
	readonly persistNetworkRule?: (rule: NetworkRule) => Promise<void>;
	readonly onWarning?: (warning: string) => void | Promise<void>;
}

export interface NetworkRule {
	readonly host: string;
	readonly protocol: "http" | "https";
	readonly action: "allow" | "deny";
	readonly justification?: string;
}

interface ParsedShellRequest {
	readonly command: string;
	readonly commandWords: readonly string[];
	readonly approvalCommand: readonly string[];
	readonly commands: readonly (readonly string[])[];
	readonly complexParsing: boolean;
	readonly sandboxPermissions: SandboxPermissions;
	readonly justification?: string;
	readonly additionalPermissions?: AdditionalPermissionProfile;
	readonly proposedCommandRule?: readonly string[];
}

interface ParsedFileRequest {
	readonly requestedPath: string;
	readonly intent: PathIntent;
	readonly recursive: boolean;
	readonly resolved: ResolvedWorkspacePath;
}

function reject(reason: string): ToolPolicyDecision {
	return { decision: "reject", reason };
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function filePath(request: ToolPolicyRequest): string | undefined {
	if (!FILE_TOOLS.has(request.toolName)) return undefined;
	const path = request.arguments.path;
	if (typeof path === "string") return path;
	return request.toolName === "grep" || request.toolName === "find" || request.toolName === "ls" ? "." : undefined;
}

function fileIntent(toolName: string): PathIntent {
	return MUTATION_TOOLS.has(toolName) ? "write" : "read";
}

function recursiveFileAccess(toolName: string): boolean {
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

function protectedByPolicy(policy: Readonly<CompiledSandboxPolicy>, canonicalPath: string): boolean {
	if (policy.writableRoots === "full-disk") return false;
	return policy.protectedMetadataPaths.some((path) => isContained(path, canonicalPath));
}

async function materializeProtectedMetadataPolicy(
	policy: Readonly<CompiledSandboxPolicy>,
	workspace: Workspace,
): Promise<Readonly<CompiledSandboxPolicy>> {
	if (policy.writableRoots === "full-disk" || policy.protectedMetadataPaths.length === 0) return policy;
	const paths = new Set(policy.protectedMetadataPaths);
	for (const path of policy.protectedMetadataPaths) {
		paths.add((await workspace.resolvePath(path, "read")).canonicalPath);
	}
	if (paths.size === policy.protectedMetadataPaths.length) return policy;
	return Object.freeze({ ...policy, protectedMetadataPaths: Object.freeze([...paths]) });
}

function profileAllowsWrite(policy: Readonly<CompiledSandboxPolicy>, canonicalPath: string): boolean {
	if (policy.writableRoots === "full-disk") return true;
	return (
		policy.writableRoots.some((root) => isContained(root, canonicalPath)) && !protectedByPolicy(policy, canonicalPath)
	);
}

/**
 * File mutations run in a trusted, single-operation helper. The outer Sandbox therefore grants
 * the helper's target directory for its atomic temporary file while retaining every unrelated
 * restriction. An approved protected-metadata mutation removes only the containing Workspace's
 * blanket metadata exclusion for this invocation; the helper still accepts exactly one target.
 */
function exactMutationPolicy(
	policy: Readonly<CompiledSandboxPolicy>,
	canonicalPath: string,
	lexicalPath: string,
): Readonly<CompiledSandboxPolicy> {
	if (policy.writableRoots === "full-disk" || profileAllowsWrite(policy, canonicalPath)) return policy;
	const targetDirectory = dirname(canonicalPath);
	const protectedMetadataRoots = policy.protectedMetadataRoots.filter((root) =>
		policy.protectedMetadataNames.every(
			(name) => !isContained(join(root, name), canonicalPath) && !isContained(join(root, name), lexicalPath),
		),
	);
	const protectedMetadataPaths = policy.protectedMetadataPaths.filter(
		(path) =>
			!isContained(path, canonicalPath) && !isContained(path, targetDirectory) && !isContained(path, lexicalPath),
	);
	return Object.freeze({
		...policy,
		writableRoots: Object.freeze([...new Set([...policy.writableRoots, targetDirectory])]),
		protectedMetadataRoots: Object.freeze(protectedMetadataRoots),
		protectedMetadataPaths: Object.freeze(protectedMetadataPaths),
	});
}

function fileApprovalCacheKey(request: ToolPolicyRequest, parsed: ParsedFileRequest): string {
	return JSON.stringify([request.toolName, parsed.intent, parsed.resolved.canonicalPath, parsed.recursive]);
}

function shellWords(command: string, shellExecutable: string): readonly string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const character of command) {
		if (escaping) {
			word += character;
			escaping = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (word !== "") words.push(word);
			word = "";
			continue;
		}
		word += character;
	}
	if (escaping || quote) return Object.freeze([shellExecutable, "-c", command]);
	if (word !== "") words.push(word);
	return Object.freeze(words.length > 0 ? words : [shellExecutable, "-c", command]);
}

interface ParsedShellCommands {
	readonly commands: readonly (readonly string[])[];
	readonly literalCommands: readonly (readonly string[])[];
	readonly complex: boolean;
}

interface ParenthesizedShell {
	readonly body: string;
	readonly end: number;
}

function parenthesizedShell(script: string, start: number): ParenthesizedShell | undefined {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (let index = start; index < script.length; index++) {
		const character = script[index]!;
		if (escaping) {
			escaping = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "(") depth++;
		if (character === ")" && --depth === 0) return { body: script.slice(start, index), end: index };
	}
	return undefined;
}

function normalizedCommandWords(words: readonly string[]): readonly string[] {
	let index = 0;
	while (words[index] === "!" || ["then", "do", "else", "elif"].includes(words[index] ?? "")) index++;
	while (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index] ?? "")) index++;
	const executableWord = basename(words[index] ?? "");
	if (executableWord === "env") {
		index++;
		while ((words[index] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index] ?? "")) {
			index++;
		}
	}
	if (["command", "builtin", "nohup"].includes(basename(words[index] ?? ""))) index++;
	return Object.freeze(words.slice(index));
}

function parseShellCommands(script: string, shellExecutable = "/bin/sh", depth = 0): ParsedShellCommands {
	if (depth > 8) {
		const fallback = Object.freeze([shellExecutable, "-c", script]);
		return { commands: Object.freeze([fallback]), literalCommands: Object.freeze([fallback]), complex: true };
	}
	const segments: string[][] = [];
	const substitutions: string[] = [];
	let words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let complex = false;
	let requiresFollowingCommand = false;
	const flushWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const flushSegment = () => {
		flushWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};
	for (let index = 0; index < script.length; index++) {
		const character = script[index]!;
		if (escaping) {
			word += character;
			escaping = false;
			requiresFollowingCommand = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote === "'") {
			if (character === quote) quote = undefined;
			else {
				word += character;
				requiresFollowingCommand = false;
			}
			continue;
		}
		if (character === "$" && script[index + 1] === "(") {
			const nested = parenthesizedShell(script, index + 2);
			complex = true;
			if (!nested) {
				word += character;
				continue;
			}
			substitutions.push(nested.body);
			word += "$(...)";
			requiresFollowingCommand = false;
			index = nested.end;
			continue;
		}
		if (character === "$") {
			complex = true;
			word += character;
			requiresFollowingCommand = false;
			continue;
		}
		if (character === "`") {
			const end = script.indexOf("`", index + 1);
			complex = true;
			if (end < 0) {
				word += character;
				continue;
			}
			substitutions.push(script.slice(index + 1, end));
			word += "`...`";
			requiresFollowingCommand = false;
			index = end;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else {
				word += character;
				requiresFollowingCommand = false;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			requiresFollowingCommand = false;
			continue;
		}
		if (character === "#") complex = true;
		if (character === "\n" || character === ";" || character === "|" || character === "&") {
			const hadCommand = word !== "" || words.length > 0;
			if (!hadCommand && (requiresFollowingCommand || character !== "\n")) complex = true;
			flushSegment();
			const doubled = script[index + 1] === character;
			if (doubled) index++;
			if (character === "&" && !doubled) complex = true;
			if (character === ";" && doubled) complex = true;
			requiresFollowingCommand = character === "|" || (character === "&" && doubled);
			continue;
		}
		if (character === "(" || character === ")" || character === "{" || character === "}") {
			complex = true;
			flushSegment();
			continue;
		}
		if (character === ">" || character === "<") complex = true;
		if (/\s/u.test(character)) {
			flushWord();
			continue;
		}
		word += character;
		requiresFollowingCommand = false;
	}
	if (escaping || quote || requiresFollowingCommand) complex = true;
	flushSegment();

	const controlWords = new Set([
		"case",
		"coproc",
		"do",
		"done",
		"elif",
		"else",
		"esac",
		"fi",
		"for",
		"function",
		"if",
		"select",
		"then",
		"time",
		"until",
		"while",
	]);
	const literalCommands: Array<readonly string[]> = [];
	for (const segment of segments) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(segment[0] ?? "") || controlWords.has(segment[0] ?? "")) {
			complex = true;
		}
		const normalized = normalizedCommandWords(segment);
		if (normalized.length === 0) continue;
		literalCommands.push(normalized);
		const shell = basename(normalized[0] ?? "");
		const commandFlag = ["sh", "bash", "zsh", "dash", "ksh"].includes(shell)
			? normalized.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(token))
			: -1;
		if (commandFlag > 0 && normalized[commandFlag + 1] !== undefined) {
			const nested = parseShellCommands(normalized[commandFlag + 1]!, normalized[0]!, depth + 1);
			literalCommands.push(...nested.literalCommands);
		}
	}
	for (const substitution of substitutions) {
		const nested = parseShellCommands(substitution, shellExecutable, depth + 1);
		literalCommands.push(...nested.literalCommands);
	}
	const fallback = Object.freeze([shellExecutable, "-c", script]);
	const commands = complex
		? Object.freeze([fallback])
		: Object.freeze(segments.map((segment) => Object.freeze([...segment])));
	return {
		commands: commands.length > 0 ? commands : Object.freeze([fallback]),
		literalCommands: Object.freeze(literalCommands.length > 0 ? literalCommands : [fallback]),
		complex,
	};
}

function executable(words: readonly string[]): string | undefined {
	const first = words[0];
	return first ? basename(first) : undefined;
}

function forcedRm(words: readonly string[], depth = 0): boolean {
	if (depth > 8) return false;
	const command = executable(words);
	if (command === "rm") {
		return words
			.slice(1, words.indexOf("--") < 0 ? undefined : words.indexOf("--"))
			.some(
				(argument) =>
					argument === "--force" ||
					(argument.startsWith("-") && !argument.startsWith("--") && argument.slice(1).includes("f")),
			);
	}
	if (command === "sudo") return forcedRm(words.slice(1), depth + 1);
	if (command === "env") return forcedRm(normalizedCommandWords(words), depth + 1);
	if (command === "trap") {
		const actionIndex = words[1] === "--" ? 2 : 1;
		const action = words[actionIndex];
		return action !== undefined && !action.startsWith("-")
			? parseShellCommands(action, "/bin/sh", depth + 1).literalCommands.some((nested) =>
					forcedRm(nested, depth + 1),
				)
			: false;
	}
	if (["sh", "bash", "zsh", "dash", "ksh"].includes(command ?? "")) {
		const commandFlag = words.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(token));
		const script = words[commandFlag + 1];
		return commandFlag > 0 && script !== undefined
			? parseShellCommands(script, words[0] ?? "/bin/sh", depth + 1).literalCommands.some((nested) =>
					forcedRm(nested, depth + 1),
				)
			: false;
	}
	return false;
}

function safeGit(words: readonly string[]): boolean {
	if (executable(words) !== "git") return false;
	const unsafeGlobal = [
		"-C",
		"-c",
		"-p",
		"--config-env",
		"--exec-path",
		"--git-dir",
		"--namespace",
		"--paginate",
		"--super-prefix",
		"--work-tree",
	];
	const subcommandIndex = words.findIndex((word, index) => index > 0 && !word.startsWith("-"));
	if (subcommandIndex < 0) return false;
	const globalArguments = words.slice(1, subcommandIndex);
	if (
		globalArguments.some((argument) =>
			unsafeGlobal.some(
				(option) =>
					argument === option ||
					(["-C", "-c"].includes(option) && argument.startsWith(option) && argument.length > option.length) ||
					(option.startsWith("--") && argument.startsWith(`${option}=`)),
			),
		)
	) {
		return false;
	}
	const subcommand = words[subcommandIndex];
	if (!subcommand || !["status", "log", "diff", "show", "branch"].includes(subcommand)) return false;
	const subcommandArguments = words.slice(subcommandIndex + 1);
	if (
		subcommandArguments.some(
			(argument) =>
				["--output", "--ext-diff", "--textconv", "--exec"].includes(argument) ||
				argument.startsWith("--output=") ||
				argument.startsWith("--exec="),
		)
	) {
		return false;
	}
	if (subcommand !== "branch") return true;
	const after = subcommandArguments;
	return (
		after.length === 0 ||
		after.every(
			(word) =>
				["--list", "-l", "--show-current", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose"].includes(
					word,
				) || word.startsWith("--format="),
		)
	);
}

function knownSafe(words: readonly string[]): boolean {
	const command = executable(words);
	if (
		command &&
		[
			"cat",
			"cd",
			"cut",
			"echo",
			"expr",
			"false",
			"grep",
			"head",
			"id",
			"ls",
			"nl",
			"paste",
			"pwd",
			"rev",
			"seq",
			"stat",
			"tail",
			"tr",
			"true",
			"uname",
			"uniq",
			"wc",
			"which",
			"whoami",
		].includes(command)
	) {
		return true;
	}
	if (command === "base64") {
		return !words
			.slice(1)
			.some(
				(argument) =>
					argument === "-o" ||
					argument === "--output" ||
					argument.startsWith("--output=") ||
					(argument.startsWith("-o") && argument !== "-o"),
			);
	}
	if (command === "find") {
		return !words.some((argument) =>
			["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"].includes(
				argument,
			),
		);
	}
	if (command === "rg") {
		return !words.some(
			(argument) =>
				["--search-zip", "-z", "--pre", "--hostname-bin"].includes(argument) ||
				argument.startsWith("--pre=") ||
				argument.startsWith("--hostname-bin="),
		);
	}
	if (command === "sed") {
		return words.length <= 4 && words[1] === "-n" && /^(?:\d+,)?\d+p$/u.test(words[2] ?? "");
	}
	if (process.platform === "linux" && (command === "numfmt" || command === "tac")) return true;
	return safeGit(words);
}

function parseAdditionalPermissions(value: unknown): AdditionalPermissionProfile | string | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return "additional_permissions must be an object";
	const input = value as Record<string, unknown>;
	const unknownProfileKey = Object.keys(input).find((key) => key !== "network" && key !== "file_system");
	if (unknownProfileKey !== undefined) {
		return `unknown additional_permissions field: ${unknownProfileKey}`;
	}
	let network: AdditionalPermissionProfile["network"];
	if (input.network !== undefined) {
		if (!input.network || typeof input.network !== "object" || Array.isArray(input.network)) {
			return "additional_permissions.network must be an object";
		}
		const networkInput = input.network as Record<string, unknown>;
		const unknownNetworkKey = Object.keys(networkInput).find((key) => key !== "enabled");
		if (unknownNetworkKey !== undefined) {
			return `unknown additional_permissions.network field: ${unknownNetworkKey}`;
		}
		const enabled = networkInput.enabled;
		if (enabled !== undefined && typeof enabled !== "boolean") {
			return "additional_permissions.network.enabled must be a boolean";
		}
		network = Object.freeze({ ...(enabled === undefined ? {} : { enabled }) });
	}
	let fileSystem: AdditionalPermissionProfile["file_system"];
	if (input.file_system !== undefined) {
		if (!input.file_system || typeof input.file_system !== "object" || Array.isArray(input.file_system)) {
			return "additional_permissions.file_system must be an object";
		}
		const fileSystemInput = input.file_system as Record<string, unknown>;
		const unknownFileSystemKey = Object.keys(fileSystemInput).find((key) => key !== "read" && key !== "write");
		if (unknownFileSystemKey !== undefined) {
			return `unknown additional_permissions.file_system field: ${unknownFileSystemKey}`;
		}
		const parsePaths = (access: "read" | "write"): readonly string[] | string | undefined => {
			const paths = fileSystemInput[access];
			if (paths === undefined) return undefined;
			if (!Array.isArray(paths)) return `additional_permissions.file_system.${access} must be an array`;
			if (paths.some((path) => typeof path !== "string" || path.length === 0 || path.includes("\0"))) {
				return `additional_permissions.file_system.${access} must contain non-empty paths`;
			}
			return Object.freeze([...(paths as string[])]);
		};
		const read = parsePaths("read");
		if (typeof read === "string") return read;
		const write = parsePaths("write");
		if (typeof write === "string") return write;
		fileSystem = Object.freeze({ ...(read ? { read } : {}), ...(write ? { write } : {}) });
	}
	return Object.freeze({ ...(network ? { network } : {}), ...(fileSystem ? { file_system: fileSystem } : {}) });
}

async function canonicalizeAdditionalPermissions(
	cwd: string,
	workspace: Workspace | undefined,
	permissions: AdditionalPermissionProfile | undefined,
): Promise<AdditionalPermissionProfile | undefined> {
	if (!permissions?.file_system) return permissions;
	const canonicalize = async (
		paths: readonly string[] | undefined,
		intent: PathIntent,
	): Promise<readonly string[] | undefined> => {
		if (!paths) return undefined;
		const canonical = await Promise.all(
			paths.map(async (path) =>
				workspace ? (await workspace.resolvePath(path, intent)).canonicalPath : resolve(cwd, path),
			),
		);
		return Object.freeze([...new Set(canonical)]);
	};
	const read = await canonicalize(permissions.file_system.read, "read");
	const write = await canonicalize(permissions.file_system.write, "write");
	return Object.freeze({
		...(permissions.network ? { network: permissions.network } : {}),
		file_system: Object.freeze({ ...(read ? { read } : {}), ...(write ? { write } : {}) }),
	});
}

function effectiveSandboxPolicy(
	base: Readonly<CompiledSandboxPolicy>,
	permissions: AdditionalPermissionProfile | undefined,
): Readonly<CompiledSandboxPolicy> {
	if (!permissions) return base;
	const additionalWrites = permissions.file_system?.write ?? [];
	const writableRoots =
		base.writableRoots === "full-disk"
			? "full-disk"
			: Object.freeze([...new Set([...base.writableRoots, ...additionalWrites])]);
	const protectedMetadataRoots =
		writableRoots === "full-disk"
			? Object.freeze([])
			: Object.freeze([...new Set([...base.protectedMetadataRoots, ...additionalWrites])]);
	const protectedMetadataPaths = Object.freeze([
		...new Set([
			...base.protectedMetadataPaths,
			...protectedMetadataRoots.flatMap((root) => PROTECTED_METADATA_NAMES.map((name) => join(root, name))),
		]),
	]);
	return Object.freeze({
		...base,
		writableRoots,
		protectedMetadataRoots,
		protectedMetadataPaths,
		networkAccess: permissions.network?.enabled ? "enabled" : base.networkAccess,
	});
}

function fullAccessPolicy(base: Readonly<CompiledSandboxPolicy>): Readonly<CompiledSandboxPolicy> {
	if (base.profile === "full-access") return base;
	return Object.freeze({
		...base,
		profile: "full-access",
		writableRoots: "full-disk",
		protectedMetadataRoots: Object.freeze([]),
		protectedMetadataPaths: Object.freeze([]),
		networkAccess: "enabled",
	});
}

function parseShellRequest(request: ToolPolicyRequest, shellExecutable: string): ParsedShellRequest | string {
	const command = request.arguments.command;
	if (typeof command !== "string" || command.trim() === "") return "bash command must be a non-empty string";
	const rawPermissions = request.arguments.sandbox_permissions;
	const sandboxPermissions: SandboxPermissions =
		rawPermissions === undefined ? "use_default" : (rawPermissions as SandboxPermissions);
	if (!["use_default", "require_escalated", "with_additional_permissions"].includes(sandboxPermissions)) {
		return `unknown sandbox_permissions value: ${String(rawPermissions)}`;
	}
	const justification = request.arguments.justification;
	if (justification !== undefined && typeof justification !== "string") {
		return "justification must be a string";
	}
	if (justification !== undefined && rawPermissions === undefined) {
		return '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.';
	}
	const additionalPermissions = parseAdditionalPermissions(request.arguments.additional_permissions);
	if (typeof additionalPermissions === "string") return additionalPermissions;
	if (sandboxPermissions === "with_additional_permissions" && !additionalPermissions) {
		return "with_additional_permissions requires additional_permissions";
	}
	if (
		sandboxPermissions === "with_additional_permissions" &&
		additionalPermissions &&
		additionalPermissions.network?.enabled === undefined &&
		(additionalPermissions.file_system?.read?.length ?? 0) === 0 &&
		(additionalPermissions.file_system?.write?.length ?? 0) === 0
	) {
		return "additional_permissions must include at least one network or filesystem permission";
	}
	if (sandboxPermissions !== "with_additional_permissions" && additionalPermissions) {
		return "additional_permissions requires with_additional_permissions";
	}
	const rawPrefix = request.arguments.prefix_rule;
	let proposedCommandRule: readonly string[] | undefined;
	if (rawPrefix !== undefined) {
		if (!Array.isArray(rawPrefix) || rawPrefix.some((token) => typeof token !== "string")) {
			return "prefix_rule must be an array of strings";
		}
	}
	const commandWords = shellWords(command, shellExecutable);
	const parsedCommands = parseShellCommands(command, shellExecutable);
	const approvalCommand =
		!parsedCommands.complex && parsedCommands.commands.length === 1
			? parsedCommands.commands[0]!
			: Object.freeze(["__coda_shell_script__", "-c", command]);
	if (
		Array.isArray(rawPrefix) &&
		rawPrefix.length > 0 &&
		!parsedCommands.complex &&
		!BANNED_PREFIX_SUGGESTIONS.has(JSON.stringify(rawPrefix)) &&
		parsedCommands.commands.every((candidate) => amendmentMatches(rawPrefix as string[], candidate))
	) {
		proposedCommandRule = Object.freeze([...(rawPrefix as string[])]);
	}
	return {
		command,
		commandWords,
		approvalCommand,
		commands: parsedCommands.commands,
		complexParsing: parsedCommands.complex,
		sandboxPermissions,
		justification,
		additionalPermissions,
		proposedCommandRule,
	};
}

function granularAllowsSandbox(policy: ApprovalPolicy): boolean {
	return typeof policy !== "object" || policy.sandboxApproval;
}

function approvalPolicyName(policy: ApprovalPolicy): string {
	return typeof policy === "object" ? policy.mode : policy;
}

function matchingRuleDecision(
	rules: readonly CommandRule[],
	hostExecutables: readonly HostExecutable[],
	words: readonly string[],
): { readonly decision: CommandRuleDecision; readonly rules: readonly CommandRule[] } | undefined {
	const matching = matchingCommandRules(rules, hostExecutables, words);
	if (matching.length === 0) return undefined;
	const severity: Readonly<Record<CommandRuleDecision, number>> = { allow: 0, prompt: 1, forbidden: 2 };
	const decision = matching.reduce<CommandRuleDecision>(
		(strictest, rule) => (severity[rule.decision] > severity[strictest] ? rule.decision : strictest),
		"allow",
	);
	return { decision, rules: matching };
}

interface AggregateRuleEvaluation {
	readonly decision?: CommandRuleDecision;
	readonly rules: readonly CommandRule[];
	readonly allExplicitlyAllowed: boolean;
	readonly fallbackCommands: readonly (readonly string[])[];
}

function evaluateCommandRules(
	rules: readonly CommandRule[],
	hostExecutables: readonly HostExecutable[],
	commands: readonly (readonly string[])[],
): AggregateRuleEvaluation {
	const evaluations = commands.map((command) => matchingRuleDecision(rules, hostExecutables, command));
	const matchedRules = [...new Set(evaluations.flatMap((evaluation) => evaluation?.rules ?? []))];
	const severity: Readonly<Record<CommandRuleDecision, number>> = { allow: 0, prompt: 1, forbidden: 2 };
	const decisions = evaluations.flatMap((evaluation) => (evaluation ? [evaluation.decision] : []));
	const decision = decisions.reduce<CommandRuleDecision | undefined>(
		(strictest, candidate) =>
			strictest === undefined || severity[candidate] > severity[strictest] ? candidate : strictest,
		undefined,
	);
	return Object.freeze({
		decision,
		rules: Object.freeze(matchedRules),
		allExplicitlyAllowed: commands.length > 0 && evaluations.every((evaluation) => evaluation?.decision === "allow"),
		fallbackCommands: Object.freeze(commands.filter((_command, index) => evaluations[index]?.decision !== "allow")),
	});
}

function rulesAllowPrompt(policy: ApprovalPolicy): boolean {
	if (policy === "never") return false;
	return typeof policy !== "object" || policy.rules;
}

function approvalCacheKey(environmentId: string, cwd: string, request: ParsedShellRequest): string {
	return JSON.stringify([
		environmentId,
		cwd,
		request.approvalCommand,
		request.sandboxPermissions,
		request.additionalPermissions ?? null,
	]);
}

function amendmentMatches(command: readonly string[], words: readonly string[]): boolean {
	if (command.length === 0 || words.length < command.length) return false;
	return command.every((token, index) => {
		const word = words[index];
		return word !== undefined && (index === 0 ? token === word || token === basename(word) : token === word);
	});
}

function networkHost(host: string): string {
	return normalizeNetworkHost(host);
}

function hostApprovalKey(destination: ManagedNetworkDestination): string {
	return JSON.stringify([
		destination.environmentId,
		networkHost(destination.host),
		destination.protocol,
		destination.port,
	]);
}

function promptRequirement(
	request: ParsedShellRequest,
	profile: Readonly<CompiledSandboxPolicy>,
	approvalPolicy: ApprovalPolicy,
	fallbackCommands: readonly (readonly string[])[],
): { readonly prompt: false } | { readonly prompt: true; readonly reason: string } | { readonly forbidden: string } {
	const dangerous = fallbackCommands.some(forcedRm);
	if (dangerous && approvalPolicy === "never") {
		return { forbidden: "rm -f style commands are not permitted. Use a safer approach" };
	}
	if (dangerous) {
		if (!granularAllowsSandbox(approvalPolicy)) {
			return { forbidden: "approval policy disallowed sandbox approval prompt" };
		}
		return { prompt: true, reason: "command matched the dangerous command classifier" };
	}
	if (request.sandboxPermissions !== "use_default") {
		if (profile.profile === "full-access") return { prompt: false };
		return { prompt: true, reason: "command requested additional Sandbox permissions" };
	}
	const knownSafeFallback = !request.complexParsing && fallbackCommands.every(knownSafe);
	if (approvalPolicy === "unless-trusted" && !knownSafeFallback) {
		return { prompt: true, reason: "command is not in the known read-only allowlist" };
	}
	if (
		profile.profile === "full-access" ||
		approvalPolicy === "never" ||
		approvalPolicy === "on-request" ||
		typeof approvalPolicy === "object" ||
		knownSafeFallback
	) {
		return { prompt: false };
	}
	return { prompt: true, reason: "command requires approval" };
}

export function createPermissionEngine(options: PermissionEngineOptions): PermissionEngine {
	const shellExecutable = options.shellExecutable ?? "/bin/sh";
	const environmentId = options.environmentId ?? "local";
	if (environmentId.length === 0 || environmentId.includes("\0")) {
		throw new Error("Permission Engine environmentId must be non-empty and must not contain NUL bytes");
	}
	if (!isAbsolute(shellExecutable) || shellExecutable.includes("\0")) {
		throw new Error("Permission Engine shellExecutable must be an absolute path without NUL bytes");
	}
	let activeProfile = options.profile;
	let activeApprovalPolicy = options.approvalPolicy;
	const authorizations = new Map<ToolInvocationId, ShellAuthorization>();
	const sandboxPolicies = new Map<ToolInvocationId, Readonly<CompiledSandboxPolicy>>();
	const aborts = new Set<ToolInvocationId>();
	const sessionApprovals = new Set<string>();
	const commandRules = [...(options.commandRules ?? [])];
	const hostExecutables = [...(options.hostExecutables ?? [])];
	const networkRules = [...(options.networkRules ?? [])];
	const sessionApprovedHosts = new Set<string>();
	const pendingHostApprovals = new Map<string, Promise<ManagedNetworkDecision>>();
	const warnBestEffort = async (message: string): Promise<void> => {
		try {
			await options.onWarning?.(message);
		} catch {
			// A secondary presentation or audit failure must not revoke the approval being reported.
		}
	};
	const requestGenericApproval = async (request: GenericPermissionRequest): Promise<ToolPolicyDecision> => {
		if (activeApprovalPolicy === "never") return reject("approval policy is never");
		if (typeof activeApprovalPolicy === "object") {
			const enabled =
				request.kind === "skill" ? activeApprovalPolicy.skillApproval : activeApprovalPolicy.mcpElicitations;
			if (!enabled) return reject(`approval policy disallowed ${request.kind} approval prompt`);
		}
		const cacheKey = JSON.stringify([
			request.kind,
			request.toolName ?? null,
			request.reason,
			request.justification ?? null,
		]);
		if (sessionApprovals.has(cacheKey)) return { decision: "allow" };
		let decision: ApprovalDecision;
		try {
			decision = await options.approval.decide({
				kind: request.kind,
				runId: request.runId,
				turnId: request.turnId,
				invocationId: request.invocationId,
				cwd: options.cwd,
				reason: request.reason,
				toolName: request.toolName,
				justification: request.justification,
			});
		} catch {
			return reject("approval reviewer failed");
		}
		switch (decision.type) {
			case "approved":
				return { decision: "allow" };
			case "approved-for-session":
				sessionApprovals.add(cacheKey);
				return { decision: "allow" };
			case "abort":
				aborts.add(request.invocationId);
				return reject("approval request aborted");
			case "denied":
				return reject(decision.rejection);
			case "timed-out":
				return reject("approval request timed out");
			case "approved-execpolicy-amendment":
				return reject("Command Rule cannot approve a generic permission request");
			case "network-policy-amendment":
				return reject("Network Rule cannot approve a generic permission request");
		}
	};
	const decideNetwork = (
		toolRequest: ToolPolicyRequest,
		destination: ManagedNetworkDestination,
	): Promise<ManagedNetworkDecision> => {
		const normalizedHost = networkHost(destination.host);
		const normalizedDestination = Object.freeze({ ...destination, host: normalizedHost });
		const key = hostApprovalKey(normalizedDestination);
		const pendingKey = JSON.stringify([key, toolRequest.turnId, toolRequest.invocationId]);
		const persistent = [...networkRules]
			.reverse()
			.find((rule) => rule.host === normalizedHost && rule.protocol === destination.protocol);
		if (persistent) {
			return Promise.resolve(
				persistent.action === "allow"
					? { action: "allow", source: "persistent" }
					: {
							action: "deny",
							source: "persistent",
							reason: persistent.justification ?? "host is denied by a persistent Network Rule",
						},
			);
		}
		if (sessionApprovedHosts.has(key)) return Promise.resolve({ action: "allow", source: "session" });
		if (activeApprovalPolicy === "never") {
			return Promise.resolve({ action: "deny", source: "policy", reason: "approval policy is never" });
		}
		const pending = pendingHostApprovals.get(pendingKey);
		if (pending) return pending;
		const review = (async (): Promise<ManagedNetworkDecision> => {
			let decision: ApprovalDecision;
			try {
				decision = await options.approval.decide({
					kind: "network",
					runId: toolRequest.runId,
					turnId: toolRequest.turnId,
					invocationId: toolRequest.invocationId,
					command: typeof toolRequest.arguments.command === "string" ? toolRequest.arguments.command : undefined,
					cwd: options.cwd,
					reason: "managed network blocked an unlisted host",
					environmentId: destination.environmentId,
					host: normalizedHost,
					protocol: destination.protocol,
					port: destination.port,
				});
			} catch {
				return { action: "deny", source: "reviewer", reason: "approval reviewer failed" };
			}
			switch (decision.type) {
				case "approved":
					return { action: "allow", source: "user" };
				case "approved-for-session":
					sessionApprovedHosts.add(key);
					return { action: "allow", source: "session" };
				case "network-policy-amendment": {
					if (networkHost(decision.host) !== normalizedHost) {
						return { action: "deny", source: "reviewer", reason: "Network Rule host did not match the request" };
					}
					const rule = Object.freeze({
						host: normalizedHost,
						protocol: destination.protocol,
						action: decision.action,
					});
					try {
						if (!options.persistNetworkRule) throw new Error("persistent Network Rule storage is unavailable");
						await options.persistNetworkRule(rule);
						networkRules.push(rule);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						await warnBestEffort(`Could not persist Network Rule for ${normalizedHost}: ${message}`);
					}
					return decision.action === "allow"
						? { action: "allow", source: "user" }
						: { action: "deny", source: "user", reason: "host was denied by the user" };
				}
				case "abort":
					aborts.add(toolRequest.invocationId);
					return { action: "deny", source: "user", reason: "approval request aborted" };
				case "denied":
					return { action: "deny", source: "user", reason: decision.rejection };
				case "timed-out":
					return { action: "deny", source: "reviewer", reason: "approval request timed out" };
				case "approved-execpolicy-amendment":
					return { action: "deny", source: "reviewer", reason: "Command Rule cannot approve network access" };
			}
		})();
		pendingHostApprovals.set(pendingKey, review);
		const clearPending = () => {
			if (pendingHostApprovals.get(pendingKey) === review) pendingHostApprovals.delete(pendingKey);
		};
		void review.then(clearPending, clearPending);
		return review;
	};
	const checkFile = async (toolRequest: ToolPolicyRequest): Promise<ToolPolicyDecision> => {
		const workspace = options.workspace;
		if (!workspace) return reject("filesystem permission checking requires a Workspace");
		const requestedPath = filePath(toolRequest);
		if (requestedPath === undefined) return reject(`${toolRequest.toolName} path must be a non-empty string`);
		try {
			const intent = fileIntent(toolRequest.toolName);
			const resolved = await workspace.resolvePath(requestedPath, intent);
			const invocationProfile = await materializeProtectedMetadataPolicy(activeProfile, workspace);
			const parsed: ParsedFileRequest = {
				requestedPath,
				intent,
				recursive: recursiveFileAccess(toolRequest.toolName),
				resolved,
			};
			const grant = () => {
				workspace.grantPath({
					invocationId: toolRequest.invocationId,
					toolName: toolRequest.toolName,
					intent,
					canonicalPath: resolved.canonicalPath,
					recursive: parsed.recursive,
				});
				sandboxPolicies.set(
					toolRequest.invocationId,
					intent === "write"
						? exactMutationPolicy(invocationProfile, resolved.canonicalPath, resolved.lexicalPath)
						: invocationProfile,
				);
			};
			if (intent === "read" || profileAllowsWrite(invocationProfile, resolved.canonicalPath)) {
				grant();
				return { decision: "allow" };
			}

			const protectedMetadata = protectedByPolicy(invocationProfile, resolved.canonicalPath);
			const reason = protectedMetadata
				? "protected metadata is read-only in this permission profile"
				: activeProfile.profile === "read-only"
					? "Read Only does not permit writes"
					: "path is outside the configured writable roots";
			if (activeApprovalPolicy === "never") return reject(`${reason}; approval policy is never`);
			if (!granularAllowsSandbox(activeApprovalPolicy)) {
				return reject(`${reason}; approval policy disallowed sandbox approval prompt`);
			}
			const cacheKey = fileApprovalCacheKey(toolRequest, parsed);
			if (!sessionApprovals.has(cacheKey)) {
				let decision: ApprovalDecision;
				try {
					decision = await options.approval.decide({
						kind: "filesystem",
						runId: toolRequest.runId,
						turnId: toolRequest.turnId,
						invocationId: toolRequest.invocationId,
						cwd: options.cwd,
						reason,
						toolName: toolRequest.toolName,
						operation: intent,
						requestedPath,
						canonicalPath: resolved.canonicalPath,
						diff: mutationPreview(toolRequest),
					});
				} catch {
					decision = { type: "denied", rejection: "approval reviewer failed" };
				}
				switch (decision.type) {
					case "approved":
						break;
					case "approved-for-session":
						sessionApprovals.add(cacheKey);
						break;
					case "abort":
						aborts.add(toolRequest.invocationId);
						return reject("approval request aborted");
					case "denied":
						return reject(decision.rejection);
					case "timed-out":
						return reject("approval request timed out");
					case "approved-execpolicy-amendment":
						return reject("Command Rule cannot approve filesystem access");
					case "network-policy-amendment":
						return reject("Network Rule cannot approve filesystem access");
				}
			}
			grant();
			return { decision: "allow" };
		} catch (error) {
			return reject(error instanceof Error ? error.message : String(error));
		}
	};
	return {
		check: async (toolRequest) => {
			if (FILE_TOOLS.has(toolRequest.toolName)) return checkFile(toolRequest);
			if (toolRequest.toolName !== "bash") {
				sandboxPolicies.set(toolRequest.invocationId, activeProfile);
				return { decision: "allow" };
			}
			const parsedResult = parseShellRequest(toolRequest, shellExecutable);
			if (typeof parsedResult === "string") return reject(parsedResult);
			let parsed: ParsedShellRequest = parsedResult;
			try {
				parsed = Object.freeze({
					...parsed,
					additionalPermissions: await canonicalizeAdditionalPermissions(
						options.cwd,
						options.workspace,
						parsed.additionalPermissions,
					),
				});
			} catch (error) {
				return reject(error instanceof Error ? error.message : String(error));
			}
			if (parsed.sandboxPermissions !== "use_default" && activeApprovalPolicy !== "on-request") {
				return reject(
					`approval policy is ${approvalPolicyName(activeApprovalPolicy)}; reject command — the model cannot ask for escalated permissions under this policy`,
				);
			}
			const ruleEvaluation = evaluateCommandRules(commandRules, hostExecutables, parsed.commands);
			if (ruleEvaluation?.decision === "forbidden") {
				const justification = ruleEvaluation.rules.find((rule) => rule.decision === "forbidden")?.justification;
				return reject(justification ?? `Command rejected by rule: ${parsed.commandWords.join(" ")}`);
			}
			if (ruleEvaluation?.decision === "prompt" && !rulesAllowPrompt(activeApprovalPolicy)) {
				return reject(
					typeof activeApprovalPolicy === "object"
						? "approval policy disallowed rules approval prompt"
						: "approval policy is never",
				);
			}
			const requirement = ruleEvaluation.allExplicitlyAllowed
				? ({ prompt: false } as const)
				: ruleEvaluation.decision === "prompt"
					? ({ prompt: true, reason: "command matched a prompt rule" } as const)
					: promptRequirement(parsed, activeProfile, activeApprovalPolicy, ruleEvaluation.fallbackCommands);
			if ("forbidden" in requirement) return reject(requirement.forbidden);
			const reviewedCommandRule =
				ruleEvaluation.rules.length === 0
					? parsed.proposedCommandRule
					: ruleEvaluation.decision === "prompt"
						? ruleEvaluation.rules
								.find((rule) => rule.decision === "prompt")
								?.pattern.flatMap((token) => (typeof token === "string" ? [token] : [token[0] ?? ""]))
						: undefined;
			const cacheKey = approvalCacheKey(environmentId, options.cwd, parsed);
			if (requirement.prompt && !sessionApprovals.has(cacheKey)) {
				let decision: ApprovalDecision;
				try {
					decision = await options.approval.decide({
						kind: "command",
						runId: toolRequest.runId,
						turnId: toolRequest.turnId,
						invocationId: toolRequest.invocationId,
						command: parsed.command,
						commandWords: parsed.commandWords,
						cwd: options.cwd,
						reason: requirement.reason,
						justification: parsed.justification,
						additionalPermissions: parsed.additionalPermissions,
						sandboxPermissions: parsed.sandboxPermissions,
						proposedCommandRule: reviewedCommandRule,
					});
				} catch {
					decision = { type: "denied", rejection: "approval reviewer failed" };
				}
				if (decision.type === "abort") {
					aborts.add(toolRequest.invocationId);
					return reject("approval request aborted");
				}
				if (decision.type === "denied") return reject(decision.rejection);
				if (decision.type === "timed-out") return reject("approval request timed out");
				if (decision.type === "network-policy-amendment") {
					return reject("network policy decision cannot approve a command request");
				}
				if (decision.type === "approved-for-session") sessionApprovals.add(cacheKey);
				if (decision.type === "approved-execpolicy-amendment") {
					if (
						!reviewedCommandRule ||
						!parsed.commands.some((command) => amendmentMatches(decision.command, command)) ||
						JSON.stringify(decision.command) !== JSON.stringify(reviewedCommandRule)
					) {
						return reject("approved Command Rule must exactly match the reviewed rule proposal");
					}
					const rule = Object.freeze({
						pattern: Object.freeze([...decision.command]),
						decision: "allow" as const,
					});
					try {
						if (!options.persistCommandRule) throw new Error("persistent Command Rule storage is unavailable");
						await options.persistCommandRule(rule);
						commandRules.push(rule);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						await warnBestEffort(`Could not persist Command Rule for ${decision.command.join(" ")}: ${message}`);
					}
				}
			}
			const requestedPolicy = effectiveSandboxPolicy(activeProfile, parsed.additionalPermissions);
			const requestedBypass =
				activeProfile.profile === "full-access" ||
				parsed.sandboxPermissions === "require_escalated" ||
				ruleEvaluation.allExplicitlyAllowed;
			const bypassSandbox = requestedBypass && requestedPolicy.deniedReadRoots.length === 0;
			const effectivePolicy = bypassSandbox ? fullAccessPolicy(requestedPolicy) : requestedPolicy;
			authorizations.set(
				toolRequest.invocationId,
				Object.freeze({
					execution: bypassSandbox ? "unsandboxed" : "sandboxed",
					sandboxPermissions: parsed.sandboxPermissions,
					additionalPermissions: parsed.additionalPermissions,
					policy: effectivePolicy,
					commandWords: parsed.commandWords,
					managedNetwork:
						effectivePolicy.networkAccess === "restricted"
							? Object.freeze({
									environmentId,
									decide: (destination: ManagedNetworkDestination) => decideNetwork(toolRequest, destination),
								})
							: undefined,
				}),
			);
			return { decision: "allow" };
		},
		authorizationFor: (invocationId) => authorizations.get(invocationId),
		sandboxPolicyFor: (invocationId) => sandboxPolicies.get(invocationId),
		configuration: () => Object.freeze({ profile: activeProfile, approvalPolicy: activeApprovalPolicy }),
		update: (configuration) => {
			activeProfile = configuration.profile;
			activeApprovalPolicy = configuration.approvalPolicy;
		},
		consumeAbort: (invocationId) => aborts.delete(invocationId),
		requestGenericApproval,
	};
}
