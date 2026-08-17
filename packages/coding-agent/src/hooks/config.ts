import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LifecycleHookEventName } from "@coda/runtime";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { UserSettings } from "../settings/types.ts";
import type { ConfiguredCommandHook, HookConfigurationSnapshot, HookDiagnostic, HookTrustRecord } from "./types.ts";
import { SUPPORTED_HOOK_EVENTS } from "./types.ts";

const EVENT_NAMES = new Set<string>(SUPPORTED_HOOK_EVENTS);
const DEFERRED_EVENTS = new Set(["PermissionRequest", "SubagentStart", "SubagentStop", "SubagentEnd"]);
const EVENTS_WITHOUT_MATCHERS = new Set<LifecycleHookEventName>(["UserPromptSubmit", "Stop"]);
const EVENTS_WITH_ADDITIONAL_CONTEXT = new Set<LifecycleHookEventName>([
	"PreToolUse",
	"PostToolUse",
	"SessionStart",
	"UserPromptSubmit",
]);
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CONTEXT_LIMIT = 2_500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

async function readJson(path: string, fileSystem: FileSystem): Promise<unknown | undefined> {
	let bytes: Uint8Array;
	try {
		bytes = await fileSystem.readFile(path);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${path} is not valid UTF-8`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${path} is not valid JSON`);
	}
}

function positiveNumber(value: unknown, fallback: number, multiplier = 1): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.max(1, Math.round(value * multiplier))
		: fallback;
}

function additionalContextLimit(value: unknown): number {
	if (value === 0) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_LIMIT;
}

function parseSource(input: {
	readonly value: unknown;
	readonly path: string;
	readonly source: "user" | "workspace";
	readonly trust: ReadonlyMap<string, string>;
	readonly diagnostics: HookDiagnostic[];
}): ConfiguredCommandHook[] {
	if (!isRecord(input.value)) {
		input.diagnostics.push({
			code: "hooks.invalid-config",
			message: "Hook configuration must be a JSON object",
			path: input.path,
		});
		return [];
	}
	if (input.value.hooks === undefined) return [];
	if (!isRecord(input.value.hooks)) {
		input.diagnostics.push({
			code: "hooks.invalid-config",
			message: "Hook configuration hooks field must be an object",
			path: input.path,
		});
		return [];
	}
	const handlers: ConfiguredCommandHook[] = [];
	for (const [eventName, groups] of Object.entries(input.value.hooks)) {
		if (DEFERRED_EVENTS.has(eventName)) {
			input.diagnostics.push({
				code: "hooks.event-deferred",
				message: `${eventName} is intentionally unavailable until its owning runtime capability exists`,
				path: input.path,
			});
			continue;
		}
		if (!EVENT_NAMES.has(eventName)) {
			input.diagnostics.push({
				code: "hooks.unknown-event",
				message: `Unknown hook event: ${eventName}`,
				path: input.path,
			});
			continue;
		}
		if (!Array.isArray(groups)) {
			input.diagnostics.push({
				code: "hooks.invalid-group-list",
				message: `${eventName} must be an array of matcher groups`,
				path: input.path,
			});
			continue;
		}
		for (const [groupIndex, group] of groups.entries()) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) {
				input.diagnostics.push({
					code: "hooks.invalid-group",
					message: `${eventName}[${groupIndex}] must contain a hooks array`,
					path: input.path,
				});
				continue;
			}
			const configuredMatcher = typeof group.matcher === "string" ? group.matcher : undefined;
			const matcher = EVENTS_WITHOUT_MATCHERS.has(eventName as LifecycleHookEventName)
				? undefined
				: configuredMatcher;
			if (matcher !== undefined && matcher !== "" && matcher !== "*" && !/^[A-Za-z0-9_|]+$/u.test(matcher)) {
				try {
					new RegExp(matcher, "u");
				} catch {
					input.diagnostics.push({
						code: "hooks.invalid-matcher",
						message: `${eventName}[${groupIndex}] has an invalid regular expression matcher`,
						path: input.path,
					});
					continue;
				}
			}
			for (const [handlerIndex, handler] of group.hooks.entries()) {
				if (!isRecord(handler)) {
					input.diagnostics.push({
						code: "hooks.invalid-handler",
						message: `${eventName}[${groupIndex}].hooks[${handlerIndex}] must be an object`,
						path: input.path,
					});
					continue;
				}
				if (handler.type !== "command") {
					input.diagnostics.push({
						code: "hooks.unsupported-handler",
						message: `${eventName} handler type ${String(handler.type)} was skipped; only command handlers execute`,
						path: input.path,
					});
					continue;
				}
				if (typeof handler.command !== "string" || handler.command.trim().length === 0) {
					input.diagnostics.push({
						code: "hooks.invalid-command",
						message: `${eventName} command handler must contain a non-empty command`,
						path: input.path,
					});
					continue;
				}
				const trustKey = `${input.path}\0${eventName}\0${groupIndex}\0${handlerIndex}`;
				const supportsAdditionalContext = EVENTS_WITH_ADDITIONAL_CONTEXT.has(eventName as LifecycleHookEventName);
				if (handler.additionalContextLimit !== undefined && !supportsAdditionalContext) {
					input.diagnostics.push({
						code: "hooks.additional-context-limit-ignored",
						message: `Ignoring additionalContextLimit for ${eventName}; this event cannot emit additionalContext`,
						path: input.path,
					});
				}
				const contextLimit = supportsAdditionalContext
					? additionalContextLimit(handler.additionalContextLimit)
					: DEFAULT_CONTEXT_LIMIT;
				const definition = {
					event: eventName,
					matcher: matcher ?? null,
					command: handler.command,
					commandWindows: typeof handler.commandWindows === "string" ? handler.commandWindows : null,
					timeout: handler.timeout ?? null,
					async: handler.async === true,
					statusMessage: typeof handler.statusMessage === "string" ? handler.statusMessage : null,
					additionalContextLimit: supportsAdditionalContext ? (handler.additionalContextLimit ?? null) : null,
				};
				const hash = sha256(canonical(definition));
				const timeoutMs =
					eventName === "SessionEnd"
						? Math.min(3_000, positiveNumber(handler.timeout, 1_000, 1_000))
						: positiveNumber(handler.timeout, DEFAULT_TIMEOUT_MS, 1_000);
				handlers.push(
					Object.freeze({
						id: sha256(trustKey).slice(0, 24),
						event: eventName as LifecycleHookEventName,
						source: input.source,
						sourcePath: input.path,
						...(matcher === undefined ? {} : { matcher }),
						command: handler.command,
						...(typeof handler.commandWindows === "string" ? { commandWindows: handler.commandWindows } : {}),
						timeoutMs,
						async: eventName === "SessionEnd" ? false : handler.async === true,
						...(typeof handler.statusMessage === "string" ? { statusMessage: handler.statusMessage } : {}),
						additionalContextLimit: contextLimit,
						trustKey,
						sha256: hash,
						trust: input.trust.get(trustKey) === hash ? "trusted" : "untrusted",
					}),
				);
			}
		}
	}
	return handlers;
}

export async function inspectHookConfiguration(input: {
	readonly workspace: string;
	readonly homeDirectory: string;
	readonly fileSystem: FileSystem;
	readonly trust: readonly HookTrustRecord[];
}): Promise<HookConfigurationSnapshot> {
	const sources = [
		{ path: join(input.homeDirectory, ".coda", "hooks.json"), source: "user" as const },
		{ path: join(input.workspace, ".coda", "hooks.json"), source: "workspace" as const },
	].filter((candidate, index, entries) => entries.findIndex(({ path }) => path === candidate.path) === index);
	const trust = new Map(input.trust.map((entry) => [entry.key, entry.sha256] as const));
	const diagnostics: HookDiagnostic[] = [];
	const handlers: ConfiguredCommandHook[] = [];
	for (const source of sources) {
		let value: unknown | undefined;
		try {
			value = await readJson(source.path, input.fileSystem);
		} catch (error) {
			diagnostics.push({
				code: "hooks.config-read-failed",
				message: error instanceof Error ? error.message : String(error),
				path: source.path,
			});
			continue;
		}
		if (value === undefined) continue;
		handlers.push(...parseSource({ value, ...source, trust, diagnostics }));
	}
	const revision = sha256(
		handlers.map(({ trustKey, sha256: hash, trust: status }) => `${trustKey}\0${hash}\0${status}`).join("\n"),
	);
	return Object.freeze({
		revision,
		paths: Object.freeze(sources.map(({ path }) => path)),
		handlers: Object.freeze(handlers),
		diagnostics: Object.freeze(diagnostics),
	});
}

export function trustAllHooks(settings: UserSettings, snapshot: HookConfigurationSnapshot): UserSettings {
	const records = new Map((settings.hookTrust ?? []).map((entry) => [entry.key, entry] as const));
	for (const handler of snapshot.handlers) {
		records.set(handler.trustKey, { key: handler.trustKey, sha256: handler.sha256 });
	}
	return {
		...settings,
		hookTrust: Object.freeze([...records.values()].sort((left, right) => left.key.localeCompare(right.key))),
	};
}

export function hookReviewText(snapshot: HookConfigurationSnapshot): string {
	const pending = snapshot.handlers.filter(({ trust }) => trust === "untrusted");
	return [
		"Trust these lifecycle hook commands?",
		"Each exact handler definition is SHA-256 bound. Any change requires review again.",
		"",
		...pending.flatMap((handler) => [
			`${handler.event} • ${handler.source}`,
			`Path: ${handler.sourcePath}`,
			`SHA-256: ${handler.sha256}`,
			`Command: ${handler.command}`,
			"",
		]),
	].join("\n");
}
