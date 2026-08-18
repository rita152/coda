import type { Immutable, RunBudget } from "@coda/agent";
import type { Api, AssistantMessage, Model, Models, ThinkingLevel } from "@coda/ai";
import type { ApprovalPolicy } from "@coda/permission";
import type { SandboxMode } from "@coda/sandbox";
import type { TerminalColorScheme } from "@coda/tui";
import type { ApplicationIO } from "../host/application-io.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import { REASONING_EFFORTS } from "../models/reasoning-effort.ts";
import type { RunControlConfiguration } from "../run-control/index.ts";
import { isApprovalPolicy, isSandboxMode } from "./approval-sandbox.ts";
import type { JsonEventStreamMode } from "./json-event-writer.ts";

const DEFAULT_CODING_AGENT_RUN_BUDGET: RunBudget = Object.freeze({
	limits: Object.freeze({
		maxTurns: 64,
		maxToolInvocations: 256,
		maxElapsedMs: 60 * 60 * 1_000,
		maxConsecutiveEquivalentToolBatches: 4,
	}),
});

export function codingAgentRunBudget(maxTurns: number | undefined, disabled: boolean): RunBudget | undefined {
	if (disabled) return undefined;
	if (maxTurns === undefined) return DEFAULT_CODING_AGENT_RUN_BUDGET;
	return Object.freeze({
		limits: Object.freeze({ ...DEFAULT_CODING_AGENT_RUN_BUDGET.limits, maxTurns }),
	});
}

export interface ParsedArguments {
	readonly action: "cleanup" | "help" | "run" | "sessions" | "skills-validate" | "version";
	readonly mode: "interactive" | "print";
	readonly output: "json" | "text";
	readonly jsonEventStream: JsonEventStreamMode;
	readonly reasoning?: ThinkingLevel | "off";
	readonly maxOutputTokens?: number;
	readonly maxTurns?: number;
	readonly disableRunBudget: boolean;
	readonly runControlWorkMs?: number;
	readonly runControlGraceMs?: number;
	readonly runControlStationaryTurns?: number;
	readonly apiKey?: string;
	readonly workspace?: string;
	readonly trustProject: boolean;
	readonly trustProjectMcp: boolean;
	readonly trustHooks: boolean;
	readonly sandboxMode?: SandboxMode;
	readonly noSandbox: boolean;
	readonly approvalPolicy?: ApprovalPolicy;
	readonly noPermission: boolean;
	readonly strictPermissions: boolean;
	readonly bypassApprovalsAndSandbox: boolean;
	readonly persistSession: boolean;
	readonly noSession: boolean;
	readonly noColor: boolean;
	readonly colorScheme?: TerminalColorScheme;
	readonly noAnimations: boolean;
	readonly includeMediaData: boolean;
	readonly resumeId?: string;
	readonly forceUnlock: boolean;
	readonly model?: ModelSelection;
	readonly prompt: string;
	readonly imagePaths: readonly string[];
	readonly skillsPath?: string;
}

function parseModel(value: string): ModelSelection {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`Model must use provider/model syntax; received "${value}"`);
	}
	return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

export async function parseArguments(args: readonly string[], io: ApplicationIO): Promise<ParsedArguments> {
	let action: ParsedArguments["action"] = "run";
	let explicitMode: ParsedArguments["mode"] | undefined;
	let output: ParsedArguments["output"] = "text";
	let jsonEventStream: JsonEventStreamMode = "raw";
	let jsonEventStreamExplicit = false;
	let reasoning: ThinkingLevel | "off" | undefined;
	let maxOutputTokens: number | undefined;
	let maxTurns: number | undefined;
	let disableRunBudget = false;
	let runControlWorkMs: number | undefined;
	let runControlGraceMs: number | undefined;
	let runControlStationaryTurns: number | undefined;
	let apiKey: string | undefined;
	let workspace: string | undefined;
	let trustProject = false;
	let trustProjectMcp = false;
	let trustHooks = false;
	let sandboxMode: SandboxMode | undefined;
	let noSandbox = false;
	let approvalPolicy: ApprovalPolicy | undefined;
	let noPermission = false;
	let strictPermissions = false;
	let bypassApprovalsAndSandbox = false;
	let persistSession = false;
	let noSession = false;
	let noColor = false;
	let colorScheme: TerminalColorScheme | undefined;
	let noAnimations = false;
	let includeMediaData = false;
	let resumeId: string | undefined;
	let forceUnlock = false;
	let model: ModelSelection | undefined;
	const promptParts: string[] = [];
	const imagePaths: string[] = [];
	let skillsPath: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (index === 0 && (argument === "cleanup" || argument === "sessions")) {
			action = argument;
			continue;
		}
		if (index === 0 && argument === "skills") {
			if (args[index + 1] !== "validate") throw new Error("skills requires: validate <path>");
			action = "skills-validate";
			index++;
			continue;
		}
		if (argument === "--print" || argument === "-p" || argument === "--no-tui") {
			if (explicitMode === "interactive") throw new Error("--print and --interactive cannot be combined");
			explicitMode = "print";
			continue;
		}
		if (argument === "--interactive" || argument === "-i") {
			if (explicitMode === "print") throw new Error("--print and --interactive cannot be combined");
			explicitMode = "interactive";
			continue;
		}
		if (argument === "--json") {
			output = "json";
			continue;
		}
		if (argument === "--json-mode") {
			const value = args[++index];
			if (value !== "raw" && value !== "semantic") {
				throw new Error("--json-mode requires raw or semantic");
			}
			jsonEventStream = value;
			jsonEventStreamExplicit = true;
			continue;
		}
		if (argument === "--no-color") {
			noColor = true;
			continue;
		}
		if (argument === "--color-scheme") {
			const value = args[++index];
			if (value !== "auto" && value !== "light" && value !== "dark") {
				throw new Error("--color-scheme requires auto, light, or dark");
			}
			colorScheme = value;
			continue;
		}
		if (argument === "--no-animations") {
			noAnimations = true;
			continue;
		}
		if (argument === "--include-media-data") {
			includeMediaData = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			action = "help";
			continue;
		}
		if (argument === "--version" || argument === "-v") {
			action = "version";
			continue;
		}
		if (argument === "--reasoning") {
			const value = args[++index];
			if (!value || !REASONING_EFFORTS.includes(value as ThinkingLevel | "off")) {
				throw new Error("--reasoning requires off, minimal, low, medium, high, xhigh, or max");
			}
			reasoning = value as ThinkingLevel | "off";
			continue;
		}
		if (argument === "--max-output-tokens") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--max-output-tokens requires a positive integer");
			}
			maxOutputTokens = value;
			continue;
		}
		if (argument === "--max-turns") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--max-turns requires a positive integer");
			}
			maxTurns = value;
			continue;
		}
		if (argument === "--no-run-budget") {
			disableRunBudget = true;
			continue;
		}
		if (argument === "--run-control-work-ms") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-work-ms requires a positive integer");
			}
			runControlWorkMs = value;
			continue;
		}
		if (argument === "--run-control-grace-ms") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-grace-ms requires a positive integer");
			}
			runControlGraceMs = value;
			continue;
		}
		if (argument === "--run-control-stationary-turns") {
			const value = Number(args[++index]);
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new Error("--run-control-stationary-turns requires a positive integer");
			}
			runControlStationaryTurns = value;
			continue;
		}
		if (argument === "--api-key") {
			const value = args[++index];
			if (!value) throw new Error("--api-key requires a non-empty value");
			apiKey = value;
			continue;
		}
		if (argument === "--workspace") {
			const value = args[++index];
			if (!value) throw new Error("--workspace requires a path");
			workspace = value;
			continue;
		}
		if (argument === "--trust-project") {
			trustProject = true;
			continue;
		}
		if (argument === "--trust-project-mcp") {
			trustProjectMcp = true;
			continue;
		}
		if (argument === "--trust-hooks") {
			trustHooks = true;
			continue;
		}
		if (argument === "--sandbox" || argument === "-s") {
			if (noSandbox) throw new Error("--sandbox and --no-sandbox cannot be combined");
			if (bypassApprovalsAndSandbox) {
				throw new Error("--sandbox cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			const value = args[index + 1];
			if (value && isSandboxMode(value)) {
				index++;
				sandboxMode = value;
			} else {
				sandboxMode = "workspace-write";
			}
			continue;
		}
		if (argument === "--no-sandbox") {
			if (sandboxMode !== undefined) throw new Error("--sandbox and --no-sandbox cannot be combined");
			if (bypassApprovalsAndSandbox) {
				throw new Error("--no-sandbox cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			noSandbox = true;
			continue;
		}
		if (argument === "--ask-for-approval" || argument === "--approval-mode" || argument === "-a") {
			if (noPermission) throw new Error("--ask-for-approval and --no-permission cannot be combined");
			if (bypassApprovalsAndSandbox) {
				throw new Error("--ask-for-approval cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			const value = args[++index];
			if (!value || !isApprovalPolicy(value)) {
				throw new Error("--ask-for-approval requires untrusted, on-request, or never");
			}
			approvalPolicy = value;
			continue;
		}
		if (argument === "--no-permission") {
			if (approvalPolicy !== undefined) throw new Error("--ask-for-approval and --no-permission cannot be combined");
			if (strictPermissions) throw new Error("--no-permission and --strict-permissions cannot be combined");
			if (bypassApprovalsAndSandbox) {
				throw new Error("--no-permission cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			noPermission = true;
			continue;
		}
		if (argument === "--strict-permissions") {
			if (noPermission) throw new Error("--no-permission and --strict-permissions cannot be combined");
			if (bypassApprovalsAndSandbox) {
				throw new Error("--strict-permissions cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			strictPermissions = true;
			continue;
		}
		if (argument === "--dangerously-bypass-approvals-and-sandbox" || argument === "--yolo") {
			if (sandboxMode !== undefined || noSandbox) {
				throw new Error("--sandbox cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			if (approvalPolicy !== undefined || noPermission || strictPermissions) {
				throw new Error("--ask-for-approval cannot be combined with --dangerously-bypass-approvals-and-sandbox");
			}
			bypassApprovalsAndSandbox = true;
			continue;
		}
		if (argument === "--session") {
			if (noSession) throw new Error("--session and --no-session cannot be combined");
			persistSession = true;
			continue;
		}
		if (argument === "--no-session") {
			if (persistSession || resumeId) throw new Error("--no-session cannot be combined with --session or --resume");
			noSession = true;
			continue;
		}
		if (argument === "--resume") {
			const value = args[++index];
			if (!value) throw new Error("--resume requires a Session identity");
			if (noSession) throw new Error("--resume cannot be combined with --no-session");
			resumeId = value;
			persistSession = true;
			continue;
		}
		if (argument === "--force-unlock") {
			forceUnlock = true;
			continue;
		}
		if (argument === "--model") {
			const value = args[++index];
			if (!value) throw new Error("--model requires provider/model");
			model = parseModel(value);
			continue;
		}
		if (argument === "--image") {
			const value = args[++index];
			if (!value) throw new Error("--image requires a path");
			imagePaths.push(value);
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (action === "skills-validate") {
			if (skillsPath !== undefined) throw new Error("skills validate accepts exactly one path");
			skillsPath = argument;
			continue;
		}
		promptParts.push(argument);
	}

	if (output === "json" && explicitMode === "interactive") throw new Error("--json cannot be used with --interactive");
	if (jsonEventStreamExplicit && output !== "json") throw new Error("--json-mode requires --json");
	if (includeMediaData && output !== "json") throw new Error("--include-media-data requires --json");
	if (disableRunBudget && maxTurns !== undefined) {
		throw new Error("--no-run-budget and --max-turns cannot be combined");
	}
	if ((runControlWorkMs === undefined) !== (runControlGraceMs === undefined)) {
		throw new Error("--run-control-work-ms and --run-control-grace-ms must be configured together");
	}
	if (runControlStationaryTurns !== undefined && runControlWorkMs === undefined) {
		throw new Error("--run-control-stationary-turns requires RunControl work and grace deadlines");
	}
	const mode = explicitMode ?? (output === "json" || !io.stdin.isTTY || !io.stdout.isTTY ? "print" : "interactive");
	let prompt = promptParts.join(" ").trim();
	if (action !== "run" && (prompt.length > 0 || imagePaths.length > 0)) {
		throw new Error(`${action} does not accept a prompt or image`);
	}
	if (action === "skills-validate" && !skillsPath) throw new Error("skills validate requires a path");
	if (action === "run" && prompt.length === 0 && !io.stdin.isTTY) prompt = (await io.stdin.readAll()).trim();
	return {
		action,
		mode,
		output,
		jsonEventStream,
		reasoning,
		maxOutputTokens,
		maxTurns,
		disableRunBudget,
		runControlWorkMs,
		runControlGraceMs,
		runControlStationaryTurns,
		apiKey,
		workspace,
		trustProject,
		trustProjectMcp,
		trustHooks,
		sandboxMode,
		noSandbox,
		approvalPolicy,
		noPermission,
		strictPermissions,
		bypassApprovalsAndSandbox,
		persistSession,
		noSession,
		noColor,
		colorScheme,
		noAnimations,
		includeMediaData,
		resumeId,
		forceUnlock,
		model,
		prompt,
		imagePaths: Object.freeze([...imagePaths]),
		...(skillsPath ? { skillsPath } : {}),
	};
}

export function findModel(models: Models, selection: ModelSelection): Model<Api> {
	const model = models.getModel(selection.provider, selection.id);
	if (!model) throw new Error(`Model not found: ${selection.provider}/${selection.id}`);
	return model;
}

export function finalText(message: Immutable<AssistantMessage>): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export const HELP = `Usage: coda [options] [prompt]

Modes:
  -p, --print                    Run once and print the final answer
  -i, --interactive              Start the interactive terminal UI
      --no-tui                   Alias for --print
      --no-color                 Disable color in this Coda invocation
      --color-scheme <scheme>    Terminal appearance: auto, light, or dark
      --no-animations            Disable periodic TUI motion
      --json                     Emit stable JSONL Agent events
      --json-mode <mode>         raw|semantic (default: raw)
      --include-media-data       Include base64 in JSON media descriptors

Model:
      --model <provider/model>   Select an exact Model
      --reasoning <level>        off|minimal|low|medium|high|xhigh|max
      --max-output-tokens <n>    Reserve at most n output tokens (default: 16384)
      --max-turns <n>            Limit one Run to n model Turns (default: 64)
	  --no-run-budget            Disable economic RunBudget limits for this invocation
      --run-control-work-ms <n>  Request finalization after this work duration
      --run-control-grace-ms <n> Abort after this additional finalization grace
      --run-control-stationary-turns <n>
                                 Request finalization after n no-progress Turns
      --api-key <key>            Use a request-scoped API key
      --image <path>             Attach an image (repeatable)

Workspace:
      --workspace <path>         Select the Workspace root
      --trust-project            Trust the current root AGENTS.md hash
      --trust-project-mcp        Trust the exact current Workspace MCP configuration
      --trust-hooks              Trust all exact Hook handler hashes after review
      --sandbox, -s [mode]       Process Confinement: read-only|workspace-write|danger-full-access
      --no-sandbox               Alias for --sandbox danger-full-access
      --ask-for-approval, -a     Command Permission: untrusted|on-request|never
      --approval-mode            Alias for --ask-for-approval
      --no-permission            Alias for --ask-for-approval never
      --strict-permissions       Deny unresolved Command Permission asks when not interactive
      --yolo                     Never ask and disable Process Confinement
      --dangerously-bypass-approvals-and-sandbox
                                 Alias for --yolo

Session:
      --session                  Persist this Session (print mode is memory-only by default)
      --no-session               Disable default interactive persistence
      --resume <id>              Resume a linear Session
      --force-unlock             Archive a definitely dead lock in print mode

Commands:
  sessions                       List Sessions for the selected Workspace
  cleanup                        Remove expired, unreferenced temporary logs
  skills validate <path>         Strictly validate one Agent Skill without starting a Session

Other:
  -h, --help                     Show this help
  -v, --version                  Show the Coda version
`;

export function runControlConfiguration(parsed: ParsedArguments): RunControlConfiguration | undefined {
	if (parsed.runControlWorkMs === undefined || parsed.runControlGraceMs === undefined) return undefined;
	return Object.freeze({
		workDurationMs: parsed.runControlWorkMs,
		graceDurationMs: parsed.runControlGraceMs,
		...(parsed.runControlStationaryTurns !== undefined
			? { maxStationaryTurns: parsed.runControlStationaryTurns }
			: {}),
	});
}
