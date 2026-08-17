import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInput } from "@coda/agent";
import type {
	HookContinueOutcome,
	LifecycleHookEventName,
	LifecycleHookHost,
	LifecycleHookSessionContext,
	LifecycleHookTurnContext,
	PostToolUseHookOutcome,
	PreToolUseHookOutcome,
	StopHookOutcome,
	UserPromptSubmitHookOutcome,
} from "@coda/runtime";
import type { ProcessRunner, ProcessRunResult } from "../host/process-runner.ts";
import type { ConfiguredCommandHook, HookConfigurationSnapshot, HookRuntimeSnapshot } from "./types.ts";
import { SUPPORTED_HOOK_EVENTS } from "./types.ts";

const MAX_ASYNC_HOOKS_PER_SESSION = 8;
const MAX_CAPTURE_BYTES = 2 * 1_024 * 1_024;
const MAX_CAPTURE_LINES = 20_000;
const DEFAULT_MODEL_OUTPUT_TOKEN_LIMIT = 2_500;

interface SessionMetadata extends LifecycleHookSessionContext {
	readonly pendingContext: string[];
	stoppedReason?: string;
}

interface CompletedHandler {
	readonly handler: ConfiguredCommandHook;
	readonly result: ProcessRunResult;
	readonly completionOrder: number;
}

interface AsyncHookJob {
	readonly handler: ConfiguredCommandHook;
	readonly context: Pick<LifecycleHookSessionContext, "sessionId" | "cwd">;
	readonly input: Record<string, unknown>;
}

interface ParsedOutput {
	readonly continue: boolean;
	readonly reason?: string;
	readonly additionalContext?: string;
	readonly updatedInput?: Readonly<Record<string, unknown>>;
	readonly feedback?: string;
	readonly continuation?: string;
	readonly warning?: string;
}

export interface CommandLifecycleHookHostOptions {
	readonly configuration: HookConfigurationSnapshot;
	readonly processRunner: ProcessRunner;
	readonly shellExecutable: string;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly diagnostic?: (diagnostic: { readonly code: string; readonly message: string }) => Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function inputText(input: AgentInput): string {
	if (typeof input === "string") return input;
	return input
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "skill") return `$${block.name}`;
			return `[image:${block.mimeType}]`;
		})
		.join("\n");
}

function matcherMatches(matcher: string | undefined, candidates: readonly string[]): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	if (candidates.length === 0) return false;
	if (/^[A-Za-z0-9_|]+$/u.test(matcher)) {
		const alternatives = new Set(matcher.split("|"));
		return candidates.some((candidate) => alternatives.has(candidate));
	}
	try {
		const expression = new RegExp(matcher, "u");
		return candidates.some((candidate) => expression.test(candidate));
	} catch {
		return false;
	}
}

function universal(value: Record<string, unknown>): {
	readonly continue: boolean;
	readonly reason?: string;
	readonly warning?: string;
} {
	return {
		continue: value.continue !== false,
		...(nonEmpty(value.stopReason) ? { reason: nonEmpty(value.stopReason) } : {}),
		...(nonEmpty(value.systemMessage) ? { warning: nonEmpty(value.systemMessage) } : {}),
	};
}

function warningFields(...warnings: readonly (string | undefined)[]): { readonly warning?: string } {
	const present = warnings.flatMap((warning) => (nonEmpty(warning) ? [nonEmpty(warning)!] : []));
	return present.length > 0 ? { warning: present.join("\n") } : {};
}

function looksLikeJson(value: string): boolean {
	const trimmed = value.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function eventSpecific(
	value: Record<string, unknown>,
	event: LifecycleHookEventName,
): Record<string, unknown> | undefined {
	const output = value.hookSpecificOutput;
	if (!isRecord(output) || output.hookEventName !== event) return undefined;
	return output;
}

function parseSuccessfulOutput(event: LifecycleHookEventName, stdout: string): ParsedOutput {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return { continue: true };
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		if ((event === "SessionStart" || event === "UserPromptSubmit") && !looksLikeJson(trimmed)) {
			return { continue: true, additionalContext: trimmed };
		}
		return event === "Stop" || looksLikeJson(trimmed)
			? { continue: true, warning: `${event} hook returned invalid JSON output` }
			: { continue: true };
	}
	if (!isRecord(value)) {
		if ((event === "SessionStart" || event === "UserPromptSubmit") && !looksLikeJson(trimmed)) {
			return { continue: true, additionalContext: trimmed };
		}
		return event === "Stop" || looksLikeJson(trimmed)
			? { continue: true, warning: `${event} hook returned invalid JSON output` }
			: { continue: true };
	}
	const common = universal(value);
	const specific = eventSpecific(value, event);
	const rawSpecific = value.hookSpecificOutput;
	const invalidSpecific =
		rawSpecific !== undefined && specific === undefined
			? `${event} hook returned hookSpecificOutput for a different or missing hookEventName`
			: undefined;
	switch (event) {
		case "SessionStart": {
			const additionalContext = nonEmpty(specific?.additionalContext);
			return {
				...common,
				...(additionalContext ? { additionalContext } : {}),
				...warningFields(common.warning, invalidSpecific),
			};
		}
		case "UserPromptSubmit": {
			const blockReason = value.decision === "block" ? nonEmpty(value.reason) : undefined;
			const invalidBlock =
				value.decision === "block" && blockReason === undefined
					? "UserPromptSubmit hook returned decision:block without a non-empty reason"
					: undefined;
			const additionalContext = invalidBlock ? undefined : nonEmpty(specific?.additionalContext);
			if (!common.continue) {
				return {
					...common,
					...(additionalContext ? { additionalContext } : {}),
					...warningFields(common.warning, invalidSpecific),
				};
			}
			return {
				...common,
				...(blockReason ? { continue: false, reason: blockReason } : {}),
				...(additionalContext ? { additionalContext } : {}),
				...warningFields(common.warning, invalidSpecific, invalidBlock),
			};
		}
		case "PreToolUse": {
			const permissionDecision = specific?.permissionDecision;
			const hasSpecificDecision =
				specific !== undefined &&
				(Object.hasOwn(specific, "permissionDecision") ||
					Object.hasOwn(specific, "permissionDecisionReason") ||
					Object.hasOwn(specific, "updatedInput"));
			let invalid = invalidSpecific;
			if (value.continue === false) invalid ??= "PreToolUse hook returned unsupported continue:false";
			else if (value.stopReason !== undefined) invalid ??= "PreToolUse hook returned unsupported stopReason";
			else if (value.suppressOutput === true) invalid ??= "PreToolUse hook returned unsupported suppressOutput";

			let deniedReason: string | undefined;
			let updatedInput: Readonly<Record<string, unknown>> | undefined;
			if (!invalid && hasSpecificDecision) {
				if (Object.hasOwn(specific!, "updatedInput") && permissionDecision !== "allow") {
					invalid = "PreToolUse hook returned updatedInput without permissionDecision:allow";
				} else if (permissionDecision === "allow") {
					if (isRecord(specific?.updatedInput)) updatedInput = specific.updatedInput;
					else invalid = "PreToolUse hook returned permissionDecision:allow without an updatedInput object";
				} else if (permissionDecision === "deny") {
					deniedReason = nonEmpty(specific?.permissionDecisionReason);
					if (!deniedReason) {
						invalid = "PreToolUse hook returned permissionDecision:deny without a non-empty reason";
					}
				} else if (permissionDecision === "ask") {
					invalid = "PreToolUse hook returned unsupported permissionDecision:ask";
				} else if (permissionDecision !== undefined) {
					invalid = `PreToolUse hook returned unsupported permissionDecision:${String(permissionDecision)}`;
				} else if (specific?.permissionDecisionReason !== undefined) {
					invalid = "PreToolUse hook returned permissionDecisionReason without permissionDecision";
				}
			} else if (!invalid) {
				if (value.decision === "block") {
					deniedReason = nonEmpty(value.reason);
					if (!deniedReason) invalid = "PreToolUse hook returned decision:block without a non-empty reason";
				} else if (value.decision === "approve") {
					invalid = "PreToolUse hook returned unsupported decision:approve";
				} else if (value.decision !== undefined) {
					invalid = `PreToolUse hook returned unsupported decision:${String(value.decision)}`;
				} else if (value.reason !== undefined) {
					invalid = "PreToolUse hook returned reason without decision";
				}
			}
			const additionalContext = invalid ? undefined : nonEmpty(specific?.additionalContext);
			return {
				continue: deniedReason === undefined,
				...(deniedReason ? { reason: deniedReason } : {}),
				...(updatedInput ? { updatedInput } : {}),
				...(additionalContext ? { additionalContext } : {}),
				...warningFields(common.warning, invalid),
			};
		}
		case "PostToolUse": {
			const feedback = value.decision === "block" ? nonEmpty(value.reason) : undefined;
			let invalid = invalidSpecific;
			if (value.suppressOutput === true) invalid ??= "PostToolUse hook returned unsupported suppressOutput";
			else if (isRecord(specific) && specific.updatedMCPToolOutput !== undefined) {
				invalid ??= "PostToolUse hook returned unsupported updatedMCPToolOutput";
			} else if (value.decision === "block" && feedback === undefined) {
				invalid ??= "PostToolUse hook returned decision:block without a non-empty reason";
			} else if (value.decision !== undefined && value.decision !== "block") {
				invalid ??= `PostToolUse hook returned unsupported decision:${String(value.decision)}`;
			} else if (value.decision !== "block" && common.continue && value.reason !== undefined) {
				invalid ??= "PostToolUse hook returned reason without decision";
			}
			const additionalContext = invalid ? undefined : nonEmpty(specific?.additionalContext);
			if (!common.continue) {
				const replacement = nonEmpty(value.reason) ?? common.reason ?? "PostToolUse hook stopped execution";
				return {
					continue: false,
					reason: common.reason ?? replacement,
					feedback: replacement,
					...(additionalContext ? { additionalContext } : {}),
					...warningFields(common.warning),
				};
			}
			return {
				...common,
				...(!invalid && feedback ? { feedback } : {}),
				...(additionalContext ? { additionalContext } : {}),
				...warningFields(common.warning, invalid),
			};
		}
		case "Stop": {
			if (!common.continue) return { ...common, ...warningFields(common.warning, invalidSpecific) };
			const continuation = value.decision === "block" ? nonEmpty(value.reason) : undefined;
			const invalid =
				invalidSpecific ??
				(value.decision === "block" && continuation === undefined
					? "Stop hook returned decision:block without a non-empty reason"
					: value.decision !== undefined && value.decision !== "block"
						? `Stop hook returned unsupported decision:${String(value.decision)}`
						: undefined);
			return {
				...common,
				...(!invalid && continuation ? { continuation } : {}),
				...warningFields(common.warning, invalid),
			};
		}
		case "PreCompact":
		case "PostCompact":
			return { ...common, ...warningFields(common.warning, invalidSpecific) };
		case "SessionEnd":
			return { continue: true };
	}
}

function parseCompleted(event: LifecycleHookEventName, result: ProcessRunResult): ParsedOutput {
	if (result.timedOut) return { continue: true, warning: `${event} hook timed out` };
	if (result.exitCode === 0)
		return event === "SessionEnd" ? { continue: true } : parseSuccessfulOutput(event, result.stdout);
	if (result.exitCode === 2) {
		const reason = nonEmpty(result.stderr);
		if (event === "Stop") {
			return reason
				? { continue: true, continuation: reason }
				: { continue: true, warning: "Stop hook exited 2 without a continuation prompt" };
		}
		if (event === "PostToolUse") {
			return reason
				? { continue: true, feedback: reason }
				: { continue: true, warning: "PostToolUse hook exited 2 without feedback" };
		}
		if (event === "PreToolUse" || event === "UserPromptSubmit") {
			return reason
				? { continue: false, reason }
				: { continue: true, warning: `${event} hook exited 2 without a reason` };
		}
	}
	return {
		continue: true,
		warning: `${event} hook failed${result.exitCode === null ? "" : ` with exit code ${result.exitCode}`}${
			nonEmpty(result.stderr) ? `: ${nonEmpty(result.stderr)}` : ""
		}`,
	};
}

function commonInput(
	context: Pick<LifecycleHookSessionContext, "sessionId" | "transcriptPath" | "cwd">,
	event: LifecycleHookEventName,
): Record<string, unknown> {
	return {
		session_id: context.sessionId,
		transcript_path: context.transcriptPath ?? null,
		cwd: context.cwd,
		hook_event_name: event,
	};
}

/** Command-backed implementation of the Codex lifecycle-hook wire protocol. */
export class CommandLifecycleHookHost implements LifecycleHookHost {
	readonly #configuration: HookConfigurationSnapshot;
	readonly #runner: ProcessRunner;
	readonly #shellExecutable: string;
	readonly #platform: NodeJS.Platform;
	readonly #environment: Readonly<Record<string, string>>;
	readonly #diagnostic?: CommandLifecycleHookHostOptions["diagnostic"];
	readonly #sessions = new Map<string, SessionMetadata>();
	readonly #asyncCounts = new Map<string, number>();
	readonly #asyncQueues = new Map<string, AsyncHookJob[]>();
	readonly #asyncTasks = new Set<Promise<void>>();
	readonly #asyncControllers = new Map<AbortController, string>();
	#closed = false;

	constructor(options: CommandLifecycleHookHostOptions) {
		this.#configuration = options.configuration;
		this.#runner = options.processRunner;
		this.#shellExecutable = options.shellExecutable;
		this.#platform = options.platform;
		this.#environment = Object.freeze(
			Object.fromEntries(
				Object.entries(options.environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
		);
		this.#diagnostic = options.diagnostic;
	}

	snapshot(): HookRuntimeSnapshot {
		return Object.freeze({
			...this.#configuration,
			events: Object.freeze(
				SUPPORTED_HOOK_EVENTS.map((event) => {
					const handlers = this.#configuration.handlers.filter((handler) => handler.event === event);
					return Object.freeze({
						event,
						installed: handlers.length,
						active: handlers.filter(({ trust }) => trust === "trusted").length,
					});
				}),
			),
		});
	}

	async sessionStart(
		context: LifecycleHookSessionContext & { readonly source: "startup" | "resume" | "clear" | "compact" },
	): Promise<HookContinueOutcome> {
		const existing = this.#sessions.get(context.sessionId);
		const resolved = {
			...context,
			...((context.transcriptPath ?? existing?.transcriptPath)
				? { transcriptPath: context.transcriptPath ?? existing?.transcriptPath }
				: {}),
		};
		const session: SessionMetadata = existing ?? { ...resolved, pendingContext: [] };
		Object.assign(session, resolved);
		this.#sessions.set(context.sessionId, session);
		const parsed = await this.#dispatch("SessionStart", resolved, [context.source], {
			...commonInput(resolved, "SessionStart"),
			model: context.model,
			permission_mode: "bypassPermissions",
			source: context.source,
		});
		this.#queueContext(context.sessionId, parsed);
		const stopped = parsed.find((output) => !output.continue);
		if (context.source !== "compact") {
			if (stopped) session.stoppedReason = stopped.reason ?? "SessionStart hook stopped the next turn";
			else session.stoppedReason = undefined;
		}
		return stopped ? { continue: false, ...(stopped.reason ? { reason: stopped.reason } : {}) } : { continue: true };
	}

	async sessionEnd(context: Omit<LifecycleHookSessionContext, "model"> & { readonly reason: "other" }): Promise<void> {
		this.#sessions.delete(context.sessionId);
		this.#asyncQueues.delete(context.sessionId);
		this.#asyncCounts.delete(context.sessionId);
		for (const [controller, sessionId] of this.#asyncControllers) {
			if (sessionId === context.sessionId) controller.abort();
		}
		await this.#dispatch("SessionEnd", context, [context.reason], {
			...commonInput(context, "SessionEnd"),
			reason: context.reason,
		});
	}

	async userPromptSubmit(
		context: LifecycleHookTurnContext & { readonly prompt: AgentInput },
	): Promise<UserPromptSubmitHookOutcome> {
		const resolved = this.#resolved(context);
		const session = this.#sessions.get(context.sessionId);
		const stoppedReason = session?.stoppedReason;
		if (stoppedReason) {
			session.stoppedReason = undefined;
			return { continue: false, reason: stoppedReason };
		}
		const parsed = await this.#dispatch("UserPromptSubmit", resolved, [], {
			...commonInput(resolved, "UserPromptSubmit"),
			turn_id: context.turnId,
			model: context.model,
			permission_mode: "bypassPermissions",
			prompt: inputText(context.prompt),
		});
		this.#queueContext(context.sessionId, parsed);
		const stopped = parsed.find((output) => !output.continue);
		return {
			continue: stopped === undefined,
			...(stopped?.reason ? { reason: stopped.reason } : {}),
			additionalContext: Object.freeze(
				parsed.flatMap((output) => (output.additionalContext ? [output.additionalContext] : [])),
			),
		};
	}

	async preToolUse(
		context: LifecycleHookTurnContext & {
			readonly toolName: string;
			readonly matcherAliases?: readonly string[];
			readonly toolUseId: string;
			readonly toolInput: Readonly<Record<string, unknown>>;
		},
	): Promise<PreToolUseHookOutcome> {
		const resolved = this.#resolved(context);
		const parsed = await this.#dispatch(
			"PreToolUse",
			resolved,
			[context.toolName, ...(context.matcherAliases ?? [])],
			{
				...commonInput(resolved, "PreToolUse"),
				turn_id: context.turnId,
				model: context.model,
				permission_mode: "bypassPermissions",
				tool_name: context.toolName,
				tool_input: context.toolInput,
				tool_use_id: context.toolUseId,
			},
		);
		this.#queueContext(context.sessionId, parsed);
		const stopped = parsed.find((output) => !output.continue);
		const updated = [...parsed]
			.filter((output) => output.updatedInput !== undefined)
			.sort((left, right) => left.completionOrder - right.completionOrder)
			.at(-1);
		return {
			continue: stopped === undefined,
			...(stopped?.reason ? { reason: stopped.reason } : {}),
			...(updated?.updatedInput ? { updatedInput: updated.updatedInput } : {}),
			additionalContext: Object.freeze(
				parsed.flatMap((output) => (output.additionalContext ? [output.additionalContext] : [])),
			),
		};
	}

	async postToolUse(context: Parameters<LifecycleHookHost["postToolUse"]>[0]): Promise<PostToolUseHookOutcome> {
		const resolved = this.#resolved(context);
		const parsed = await this.#dispatch(
			"PostToolUse",
			resolved,
			[context.toolName, ...(context.matcherAliases ?? [])],
			{
				...commonInput(resolved, "PostToolUse"),
				turn_id: context.turnId,
				model: context.model,
				permission_mode: "bypassPermissions",
				tool_name: context.toolName,
				tool_input: context.toolInput,
				tool_response: context.toolResponse,
				tool_use_id: context.toolUseId,
			},
		);
		this.#queueContext(context.sessionId, parsed);
		const stopped = parsed.find((output) => !output.continue);
		const feedback = parsed.flatMap((output) => (output.feedback ? [output.feedback] : []));
		return {
			continue: stopped === undefined,
			...(stopped?.reason ? { reason: stopped.reason } : {}),
			feedback: Object.freeze(feedback),
			additionalContext: Object.freeze(
				parsed.flatMap((output) => (output.additionalContext ? [output.additionalContext] : [])),
			),
		};
	}

	async preCompact(
		context: LifecycleHookTurnContext & { readonly trigger: "manual" | "auto" },
	): Promise<HookContinueOutcome> {
		return this.#compact("PreCompact", context);
	}

	async postCompact(
		context: LifecycleHookTurnContext & { readonly trigger: "manual" | "auto" },
	): Promise<HookContinueOutcome> {
		return this.#compact("PostCompact", context);
	}

	async stop(context: Parameters<LifecycleHookHost["stop"]>[0]): Promise<StopHookOutcome> {
		const resolved = this.#resolved(context);
		const parsed = await this.#dispatch("Stop", resolved, [], {
			...commonInput(resolved, "Stop"),
			turn_id: context.turnId,
			model: context.model,
			permission_mode: "bypassPermissions",
			stop_hook_active: context.stopHookActive,
			last_assistant_message: context.lastAssistantMessage ?? null,
		});
		const stopped = parsed.find((output) => !output.continue);
		const continuations = parsed.flatMap((output) => (output.continuation ? [output.continuation] : []));
		return {
			continue: stopped === undefined,
			...(stopped?.reason ? { reason: stopped.reason } : {}),
			...(continuations.length > 0 ? { continuation: continuations.join("\n\n") } : {}),
		};
	}

	takeAdditionalContext(sessionId: string): readonly string[] {
		const pending = this.#sessions.get(sessionId)?.pendingContext;
		if (!pending || pending.length === 0) return [];
		return Object.freeze(pending.splice(0, pending.length));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#asyncQueues.clear();
		this.#sessions.clear();
		for (const controller of this.#asyncControllers.keys()) controller.abort();
		await Promise.allSettled([...this.#asyncTasks]);
		this.#asyncControllers.clear();
		this.#asyncCounts.clear();
	}

	async #compact(
		event: "PreCompact" | "PostCompact",
		context: LifecycleHookTurnContext & { readonly trigger: "manual" | "auto" },
	): Promise<HookContinueOutcome> {
		const resolved = this.#resolved(context);
		const parsed = await this.#dispatch(event, resolved, [context.trigger], {
			...commonInput(resolved, event),
			turn_id: context.turnId,
			model: context.model,
			trigger: context.trigger,
		});
		const stopped = parsed.find((output) => !output.continue);
		return stopped ? { continue: false, ...(stopped.reason ? { reason: stopped.reason } : {}) } : { continue: true };
	}

	#resolved<T extends LifecycleHookSessionContext>(context: T): T {
		const session = this.#sessions.get(context.sessionId);
		if (!session) return context;
		return {
			...context,
			transcriptPath: context.transcriptPath ?? session.transcriptPath,
			cwd: context.cwd || session.cwd,
			model: context.model || session.model,
		};
	}

	#queueContext(sessionId: string, outputs: readonly (ParsedOutput & { readonly completionOrder: number })[]): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		for (const output of outputs) {
			if (output.additionalContext) session.pendingContext.push(output.additionalContext);
		}
	}

	async #dispatch(
		event: LifecycleHookEventName,
		context: Pick<LifecycleHookSessionContext, "sessionId" | "cwd">,
		matcherInputs: readonly string[],
		input: Record<string, unknown>,
	): Promise<readonly (ParsedOutput & { readonly completionOrder: number })[]> {
		if (this.#closed) return [];
		const matcherIsSupported = event !== "UserPromptSubmit" && event !== "Stop";
		const selected = this.#configuration.handlers.filter(
			(handler) =>
				handler.event === event &&
				handler.trust === "trusted" &&
				(!matcherIsSupported || matcherMatches(handler.matcher, matcherInputs)),
		);
		const synchronous = selected.filter((handler) => !handler.async || event === "SessionEnd");
		for (const handler of selected) {
			if (handler.async && event !== "SessionEnd") this.#scheduleAsync(handler, context, input);
		}
		let completionOrder = 0;
		const completed = await Promise.all(
			synchronous.map(async (handler): Promise<CompletedHandler> => {
				const result = await this.#run(handler, context.cwd, input, new AbortController().signal);
				return { handler, result, completionOrder: completionOrder++ };
			}),
		);
		const parsed = await Promise.all(
			completed.map(async ({ handler, result, completionOrder: order }) => {
				const output = parseCompleted(event, result);
				const [reason, additionalContext, feedback, continuation] = await Promise.all([
					output.reason
						? this.#boundedModelText(
								handler.event,
								context.sessionId,
								output.reason,
								DEFAULT_MODEL_OUTPUT_TOKEN_LIMIT,
							)
						: undefined,
					output.additionalContext
						? this.#boundedModelText(
								handler.event,
								context.sessionId,
								output.additionalContext,
								handler.additionalContextLimit,
							)
						: undefined,
					output.feedback
						? this.#boundedModelText(
								handler.event,
								context.sessionId,
								output.feedback,
								DEFAULT_MODEL_OUTPUT_TOKEN_LIMIT,
							)
						: undefined,
					output.continuation
						? this.#boundedModelText(
								handler.event,
								context.sessionId,
								output.continuation,
								DEFAULT_MODEL_OUTPUT_TOKEN_LIMIT,
							)
						: undefined,
				]);
				return {
					...output,
					...(reason ? { reason } : {}),
					...(additionalContext ? { additionalContext } : {}),
					...(feedback ? { feedback } : {}),
					...(continuation ? { continuation } : {}),
					completionOrder: order,
				};
			}),
		);
		for (const output of parsed) if (output.warning) await this.#warn(event, output.warning);
		return parsed;
	}

	#scheduleAsync(
		handler: ConfiguredCommandHook,
		context: Pick<LifecycleHookSessionContext, "sessionId" | "cwd">,
		input: Record<string, unknown>,
	): void {
		if (this.#closed || !this.#sessions.has(context.sessionId)) return;
		const queue = this.#asyncQueues.get(context.sessionId) ?? [];
		queue.push({ handler, context, input });
		this.#asyncQueues.set(context.sessionId, queue);
		this.#drainAsync(context.sessionId);
	}

	#drainAsync(sessionId: string): void {
		if (this.#closed || !this.#sessions.has(sessionId)) {
			this.#asyncQueues.delete(sessionId);
			return;
		}
		const queue = this.#asyncQueues.get(sessionId);
		if (!queue) return;
		let active = this.#asyncCounts.get(sessionId) ?? 0;
		while (active < MAX_ASYNC_HOOKS_PER_SESSION) {
			const job = queue.shift();
			if (!job) break;
			active += 1;
			this.#asyncCounts.set(sessionId, active);
			this.#startAsync(job);
		}
		if (queue.length === 0) this.#asyncQueues.delete(sessionId);
	}

	#startAsync(job: AsyncHookJob): void {
		const { handler, context, input } = job;
		const controller = new AbortController();
		this.#asyncControllers.set(controller, context.sessionId);
		const task = this.#run(handler, context.cwd, input, controller.signal)
			.then(async (result) => {
				const output = parseCompleted(handler.event, result);
				if (output.warning) await this.#warn(handler.event, output.warning);
				const session = this.#sessions.get(context.sessionId);
				if (session && output.additionalContext) {
					const bounded = await this.#boundedModelText(
						handler.event,
						context.sessionId,
						output.additionalContext,
						handler.additionalContextLimit,
					);
					this.#sessions.get(context.sessionId)?.pendingContext.push(bounded);
				}
			})
			.catch((error: unknown) => this.#warn(handler.event, error instanceof Error ? error.message : String(error)))
			.finally(() => {
				this.#asyncControllers.delete(controller);
				this.#asyncTasks.delete(task);
				const remaining = (this.#asyncCounts.get(context.sessionId) ?? 1) - 1;
				if (remaining > 0) this.#asyncCounts.set(context.sessionId, remaining);
				else this.#asyncCounts.delete(context.sessionId);
				this.#drainAsync(context.sessionId);
			});
		this.#asyncTasks.add(task);
	}

	async #boundedModelText(
		event: LifecycleHookEventName,
		sessionId: string,
		value: string,
		tokenLimit: number,
	): Promise<string> {
		if (tokenLimit === 0 || Math.ceil(Buffer.byteLength(value, "utf8") / 4) <= tokenLimit) return value;
		let outputPath: string | undefined;
		try {
			const encodedSession = Buffer.from(sessionId, "utf8").toString("base64url");
			const directory = join(tmpdir(), "hook_outputs", encodedSession);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			outputPath = join(directory, `${randomUUID()}.txt`);
			await writeFile(outputPath, value, { flag: "wx", mode: 0o600 });
		} catch (error) {
			await this.#warn(
				event,
				`could not preserve complete Hook output: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const notice = outputPath
			? `Full hook output saved to: ${outputPath}`
			: `[Hook output truncated from approximately ${Math.ceil(Buffer.byteLength(value, "utf8") / 4)} tokens]`;
		const maximumCharacters = tokenLimit * 4;
		const available = Math.max(0, maximumCharacters - notice.length - 4);
		const headLength = Math.ceil(available / 2);
		const tailLength = Math.floor(available / 2);
		return `${value.slice(0, headLength)}\n\n${notice}\n\n${tailLength > 0 ? value.slice(-tailLength) : ""}`;
	}

	async #run(
		handler: ConfiguredCommandHook,
		cwd: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ProcessRunResult> {
		const command = this.#platform === "win32" ? (handler.commandWindows ?? handler.command) : handler.command;
		try {
			return await this.#runner.run({
				executable: this.#platform === "win32" ? (this.#environment.ComSpec ?? "cmd.exe") : this.#shellExecutable,
				args: this.#platform === "win32" ? ["/C", command] : ["-lc", command],
				cwd,
				environment: this.#environment,
				signal,
				timeoutMs: handler.timeoutMs,
				maxOutputBytes: MAX_CAPTURE_BYTES,
				maxOutputLines: MAX_CAPTURE_LINES,
				stdin: JSON.stringify(input),
			});
		} catch (error) {
			return {
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				timedOut: false,
				truncated: false,
			};
		}
	}

	async #warn(event: LifecycleHookEventName, message: string): Promise<void> {
		try {
			await this.#diagnostic?.({ code: `hooks.${event}`, message });
		} catch {}
	}
}
