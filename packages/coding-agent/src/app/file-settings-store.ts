import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import type { ThinkingLevel } from "@coda/ai";
import { APPROVAL_POLICIES, type ApprovalPolicy, type RememberedCommandPermission } from "@coda/permission";
import { SANDBOX_MODES, type SandboxMode } from "@coda/sandbox";
import { withFileMutex } from "../host/file-mutex.ts";
import type { FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { parseMcpServerConfigurations } from "../mcp/config.ts";
import { parseCustomProviderModelConfig } from "../models/custom-model-metadata.ts";
import { AUTH_API_PROTOCOLS } from "../models/types.ts";
import {
	type SettingsStore,
	type UserSettings,
	WEB_SEARCH_PROVIDER_IDS,
	type WebSearchProviderId,
} from "../settings/types.ts";

const REASONING_LEVELS = new Set<ThinkingLevel | "off">(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface SettingsFile extends UserSettings {
	readonly version: 1;
}

export interface FileSettingsStoreOptions {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly idGenerator: IdGenerator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function workspaceMcpTrustKey(value: { readonly workspace: string; readonly path: string }): string {
	return `${value.workspace}\0${value.path}`;
}

function validNetworkDomainPattern(value: string, allowDenyAll: boolean): boolean {
	let host = value.trim().toLowerCase();
	if (!host) return false;
	if (host.startsWith("[")) {
		const match = /^\[([^\]]+)\](?::([1-9]\d{0,4}))?$/u.exec(host);
		if (!match?.[1] || isIP(match[1]) !== 6 || (match[2] && Number(match[2]) > 65_535)) return false;
		return true;
	}
	const colons = host.match(/:/gu)?.length ?? 0;
	if (colons > 1) return false;
	if (colons === 1) {
		const match = /^(.*):([1-9]\d{0,4})$/u.exec(host);
		if (!match?.[1] || !match[2] || Number(match[2]) > 65_535) return false;
		host = match[1];
	}
	if (host === "*") return allowDenyAll;
	if (host.includes("://") || host.includes("/") || host.includes(":")) return false;
	if (host === "localhost" || isIP(host) === 4) return true;
	if (host.startsWith("*.")) {
		const parts = host.slice(2).split(".");
		return parts.length >= 2 && parts.every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part));
	}
	const parts = host.split(".");
	return parts.length >= 2 && parts.every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part));
}

function validateSettings(value: unknown): UserSettings {
	if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported or invalid Coda settings format");
	if (
		!hasOnlyKeys(value, [
			"version",
			"defaultModel",
			"defaultReasoning",
			"plugins",
			"customProviders",
			"projectTrust",
			"mcpServers",
			"workspaceMcpTrust",
			"hookTrust",
			"permission",
			"sandbox",
			"ui",
			"web",
		])
	) {
		throw new Error("Coda settings contain an unknown field");
	}
	let defaultModel: UserSettings["defaultModel"];
	if (value.defaultModel !== undefined) {
		if (
			!isRecord(value.defaultModel) ||
			!hasOnlyKeys(value.defaultModel, ["provider", "id"]) ||
			typeof value.defaultModel.provider !== "string" ||
			value.defaultModel.provider.length === 0 ||
			typeof value.defaultModel.id !== "string" ||
			value.defaultModel.id.length === 0
		) {
			throw new Error("Coda settings contain an invalid default Model");
		}
		defaultModel = { provider: value.defaultModel.provider, id: value.defaultModel.id };
	}
	let defaultReasoning: UserSettings["defaultReasoning"];
	if (value.defaultReasoning !== undefined) {
		if (
			typeof value.defaultReasoning !== "string" ||
			!REASONING_LEVELS.has(value.defaultReasoning as ThinkingLevel)
		) {
			throw new Error("Coda settings contain an invalid default reasoning level");
		}
		defaultReasoning = value.defaultReasoning as ThinkingLevel | "off";
	}
	let plugins: UserSettings["plugins"];
	if (value.plugins !== undefined) {
		if (!isRecord(value.plugins)) throw new Error("Coda settings contain invalid Plugin settings");
		const entries = Object.entries(value.plugins).sort(([left], [right]) => compareText(left, right));
		const normalized: [string, { readonly enabled: boolean }][] = [];
		for (const [pluginId, entry] of entries) {
			const separator = pluginId.lastIndexOf("@");
			const pluginName = pluginId.slice(0, separator);
			const source = pluginId.slice(separator + 1);
			if (
				separator <= 0 ||
				pluginName.length > 64 ||
				!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(pluginName) ||
				!/^[A-Za-z0-9_-]+$/u.test(source) ||
				!isRecord(entry) ||
				!hasOnlyKeys(entry, ["enabled"]) ||
				typeof entry.enabled !== "boolean"
			) {
				throw new Error("Coda settings contain invalid Plugin settings");
			}
			normalized.push([pluginId, { enabled: entry.enabled }]);
		}
		plugins = Object.fromEntries(normalized);
	}
	let customProviders: UserSettings["customProviders"];
	if (value.customProviders !== undefined) {
		if (!Array.isArray(value.customProviders)) {
			throw new Error("Coda settings contain invalid custom Providers");
		}
		const providerIds = new Set<string>();
		customProviders = value.customProviders.map((entry) => {
			if (
				!isRecord(entry) ||
				!hasOnlyKeys(entry, ["id", "name", "apiProtocol", "baseUrl", "discovery", "models"]) ||
				typeof entry.id !== "string" ||
				!/^custom-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entry.id) ||
				providerIds.has(entry.id) ||
				typeof entry.name !== "string" ||
				entry.name.trim().length === 0 ||
				typeof entry.apiProtocol !== "string" ||
				!AUTH_API_PROTOCOLS.includes(entry.apiProtocol as (typeof AUTH_API_PROTOCOLS)[number]) ||
				typeof entry.baseUrl !== "string" ||
				!validProviderBaseUrl(entry.baseUrl) ||
				(entry.discovery !== "ready" && entry.discovery !== "needs_attention") ||
				!Array.isArray(entry.models)
			) {
				throw new Error("Coda settings contain invalid custom Providers");
			}
			providerIds.add(entry.id);
			const modelIds = new Set<string>();
			const models = entry.models.map((model) => {
				let parsed: ReturnType<typeof parseCustomProviderModelConfig>;
				try {
					parsed = parseCustomProviderModelConfig(model);
				} catch {
					throw new Error("Coda settings contain invalid custom Provider models");
				}
				if (modelIds.has(parsed.id)) throw new Error("Coda settings contain invalid custom Provider models");
				modelIds.add(parsed.id);
				return parsed;
			});
			return {
				id: entry.id,
				name: entry.name,
				apiProtocol: entry.apiProtocol as (typeof AUTH_API_PROTOCOLS)[number],
				baseUrl: entry.baseUrl,
				discovery: entry.discovery,
				models,
			};
		});
	}
	let projectTrust: UserSettings["projectTrust"];
	if (value.projectTrust !== undefined) {
		if (
			!Array.isArray(value.projectTrust) ||
			value.projectTrust.some(
				(entry) =>
					!isRecord(entry) ||
					!hasOnlyKeys(entry, ["workspace", "path", "sha256"]) ||
					typeof entry.workspace !== "string" ||
					typeof entry.path !== "string" ||
					typeof entry.sha256 !== "string" ||
					!/^[a-f0-9]{64}$/.test(entry.sha256),
			)
		) {
			throw new Error("Coda settings contain invalid Project Trust records");
		}
		projectTrust = (value.projectTrust as UserSettings["projectTrust"])?.map((entry) => ({ ...entry }));
		projectTrust = projectTrust
			? [...projectTrust].sort((left, right) => left.workspace.localeCompare(right.workspace))
			: [];
		if (new Set(projectTrust.map((entry) => entry.workspace)).size !== projectTrust.length) {
			throw new Error("Coda settings contain duplicate Project Trust records");
		}
	}
	let ui: UserSettings["ui"];
	let mcpServers: UserSettings["mcpServers"];
	if (value.mcpServers !== undefined) {
		mcpServers = parseMcpServerConfigurations(value.mcpServers, "Coda settings MCP Servers");
	}
	let workspaceMcpTrust: UserSettings["workspaceMcpTrust"];
	if (value.workspaceMcpTrust !== undefined) {
		if (!Array.isArray(value.workspaceMcpTrust)) {
			throw new Error("Coda settings contain invalid Workspace MCP Trust records");
		}
		workspaceMcpTrust = value.workspaceMcpTrust.map((entry) => {
			if (
				!isRecord(entry) ||
				!hasOnlyKeys(entry, ["workspace", "path", "sha256"]) ||
				typeof entry.workspace !== "string" ||
				!isAbsolute(entry.workspace) ||
				typeof entry.path !== "string" ||
				!isAbsolute(entry.path) ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/u.test(entry.sha256)
			) {
				throw new Error("Coda settings contain invalid Workspace MCP Trust records");
			}
			return { workspace: entry.workspace, path: entry.path, sha256: entry.sha256 };
		});
		workspaceMcpTrust = [...workspaceMcpTrust].sort(
			(left, right) => compareText(left.workspace, right.workspace) || compareText(left.path, right.path),
		);
		if (new Set(workspaceMcpTrust.map(workspaceMcpTrustKey)).size !== workspaceMcpTrust.length) {
			throw new Error("Coda settings contain duplicate Workspace MCP Trust records");
		}
	}
	let permission: UserSettings["permission"];
	if (value.permission !== undefined) {
		if (!isRecord(value.permission) || !hasOnlyKeys(value.permission, ["approvalPolicy", "enabled", "remembered"])) {
			throw new Error("Coda settings contain invalid Command Permission settings");
		}
		if (value.permission.enabled !== undefined && typeof value.permission.enabled !== "boolean") {
			throw new Error("Coda settings contain invalid Command Permission settings");
		}
		if (
			value.permission.approvalPolicy !== undefined &&
			(typeof value.permission.approvalPolicy !== "string" ||
				!(APPROVAL_POLICIES as readonly string[]).includes(value.permission.approvalPolicy))
		) {
			throw new Error("Coda settings contain invalid Command Permission settings");
		}
		let remembered: readonly RememberedCommandPermission[] | undefined;
		if (value.permission.remembered !== undefined) {
			if (!Array.isArray(value.permission.remembered)) {
				throw new Error("Coda settings contain invalid Command Permission settings");
			}
			remembered = value.permission.remembered.map((entry) => {
				if (
					!isRecord(entry) ||
					!hasOnlyKeys(entry, ["key", "decision", "reason", "scope", "workspace"]) ||
					typeof entry.key !== "string" ||
					entry.key.length === 0 ||
					(entry.decision !== "allow" && entry.decision !== "deny") ||
					(entry.reason !== undefined && typeof entry.reason !== "string") ||
					(entry.scope !== "session" && entry.scope !== "workspace" && entry.scope !== "user") ||
					(entry.workspace !== undefined && typeof entry.workspace !== "string")
				) {
					throw new Error("Coda settings contain invalid Command Permission settings");
				}
				return {
					key: entry.key,
					decision: entry.decision,
					...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
					scope: entry.scope,
					...(typeof entry.workspace === "string" ? { workspace: entry.workspace } : {}),
				};
			});
		}
		permission = {
			...(value.permission.approvalPolicy !== undefined
				? { approvalPolicy: value.permission.approvalPolicy as ApprovalPolicy }
				: {}),
			...(value.permission.enabled !== undefined ? { enabled: value.permission.enabled } : {}),
			...(remembered ? { remembered } : {}),
		};
	}
	let sandbox: UserSettings["sandbox"];
	if (value.sandbox !== undefined) {
		if (
			!isRecord(value.sandbox) ||
			!hasOnlyKeys(value.sandbox, ["mode", "enabled", "allowedDomains", "deniedDomains"]) ||
			(value.sandbox.mode !== undefined &&
				(typeof value.sandbox.mode !== "string" ||
					!(SANDBOX_MODES as readonly string[]).includes(value.sandbox.mode))) ||
			(value.sandbox.enabled !== undefined && typeof value.sandbox.enabled !== "boolean") ||
			(value.sandbox.allowedDomains !== undefined &&
				(!Array.isArray(value.sandbox.allowedDomains) ||
					value.sandbox.allowedDomains.some(
						(entry) => typeof entry !== "string" || !validNetworkDomainPattern(entry, false),
					))) ||
			(value.sandbox.deniedDomains !== undefined &&
				(!Array.isArray(value.sandbox.deniedDomains) ||
					value.sandbox.deniedDomains.some(
						(entry) => typeof entry !== "string" || !validNetworkDomainPattern(entry, true),
					)))
		) {
			throw new Error("Coda settings contain invalid Process Confinement settings");
		}
		sandbox = {
			...(value.sandbox.mode !== undefined ? { mode: value.sandbox.mode as SandboxMode } : {}),
			...(value.sandbox.enabled !== undefined ? { enabled: value.sandbox.enabled } : {}),
			...(value.sandbox.allowedDomains
				? { allowedDomains: [...(value.sandbox.allowedDomains as readonly string[])] }
				: {}),
			...(value.sandbox.deniedDomains
				? { deniedDomains: [...(value.sandbox.deniedDomains as readonly string[])] }
				: {}),
		};
	}
	let hookTrust: UserSettings["hookTrust"];
	if (value.hookTrust !== undefined) {
		if (!Array.isArray(value.hookTrust)) {
			throw new Error("Coda settings contain invalid Hook Trust records");
		}
		hookTrust = value.hookTrust.map((entry) => {
			if (
				!isRecord(entry) ||
				!hasOnlyKeys(entry, ["key", "sha256"]) ||
				typeof entry.key !== "string" ||
				entry.key.length === 0 ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/u.test(entry.sha256)
			) {
				throw new Error("Coda settings contain invalid Hook Trust records");
			}
			return { key: entry.key, sha256: entry.sha256 };
		});
		hookTrust = [...hookTrust].sort((left, right) => left.key.localeCompare(right.key));
		if (new Set(hookTrust.map(({ key }) => key)).size !== hookTrust.length) {
			throw new Error("Coda settings contain duplicate Hook Trust records");
		}
	}
	let web: UserSettings["web"];
	if (value.web !== undefined) {
		if (!isRecord(value.web) || !hasOnlyKeys(value.web, ["search", "cache", "fetch"])) {
			throw new Error("Coda settings contain invalid Web settings");
		}
		let search: NonNullable<UserSettings["web"]>["search"];
		if (value.web.search !== undefined) {
			const candidate = value.web.search;
			if (
				!isRecord(candidate) ||
				!hasOnlyKeys(candidate, ["providers", "timeoutMs", "maxResults", "maxCharacters", "searxngEndpoint"]) ||
				(candidate.providers !== undefined &&
					(!Array.isArray(candidate.providers) ||
						candidate.providers.length === 0 ||
						candidate.providers.some(
							(provider) =>
								typeof provider !== "string" ||
								!(WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(provider),
						) ||
						new Set(candidate.providers).size !== candidate.providers.length)) ||
				!validOptionalInteger(candidate.timeoutMs, 1, 120_000) ||
				!validOptionalInteger(candidate.maxResults, 1, 20) ||
				!validOptionalInteger(candidate.maxCharacters, 1, 100_000) ||
				(candidate.searxngEndpoint !== undefined &&
					(typeof candidate.searxngEndpoint !== "string" || !validProviderBaseUrl(candidate.searxngEndpoint)))
			) {
				throw new Error("Coda settings contain invalid Web settings");
			}
			search = {
				...(candidate.providers ? { providers: [...candidate.providers] as WebSearchProviderId[] } : {}),
				...(candidate.timeoutMs !== undefined ? { timeoutMs: candidate.timeoutMs as number } : {}),
				...(candidate.maxResults !== undefined ? { maxResults: candidate.maxResults as number } : {}),
				...(candidate.maxCharacters !== undefined ? { maxCharacters: candidate.maxCharacters as number } : {}),
				...(candidate.searxngEndpoint !== undefined
					? { searxngEndpoint: candidate.searxngEndpoint as string }
					: {}),
			};
		}
		let cache: NonNullable<UserSettings["web"]>["cache"];
		if (value.web.cache !== undefined) {
			const candidate = value.web.cache;
			if (
				!isRecord(candidate) ||
				!hasOnlyKeys(candidate, ["ttlMs", "maxEntries", "maxBytes"]) ||
				!validOptionalInteger(candidate.ttlMs, 1, 24 * 60 * 60_000) ||
				!validOptionalInteger(candidate.maxEntries, 1, 1_024) ||
				!validOptionalInteger(candidate.maxBytes, 1, 64 * 1024 * 1024)
			) {
				throw new Error("Coda settings contain invalid Web settings");
			}
			cache = {
				...(candidate.ttlMs !== undefined ? { ttlMs: candidate.ttlMs as number } : {}),
				...(candidate.maxEntries !== undefined ? { maxEntries: candidate.maxEntries as number } : {}),
				...(candidate.maxBytes !== undefined ? { maxBytes: candidate.maxBytes as number } : {}),
			};
		}
		let fetchSettings: NonNullable<UserSettings["web"]>["fetch"];
		if (value.web.fetch !== undefined) {
			const candidate = value.web.fetch;
			if (
				!isRecord(candidate) ||
				!hasOnlyKeys(candidate, ["timeoutMs", "maxBytes", "maxCharacters"]) ||
				!validOptionalInteger(candidate.timeoutMs, 1, 120_000) ||
				!validOptionalInteger(candidate.maxBytes, 1, 50 * 1024 * 1024) ||
				!validOptionalInteger(candidate.maxCharacters, 1, 500_000)
			) {
				throw new Error("Coda settings contain invalid Web settings");
			}
			fetchSettings = {
				...(candidate.timeoutMs !== undefined ? { timeoutMs: candidate.timeoutMs as number } : {}),
				...(candidate.maxBytes !== undefined ? { maxBytes: candidate.maxBytes as number } : {}),
				...(candidate.maxCharacters !== undefined ? { maxCharacters: candidate.maxCharacters as number } : {}),
			};
		}
		web = {
			...(search ? { search } : {}),
			...(cache ? { cache } : {}),
			...(fetchSettings ? { fetch: fetchSettings } : {}),
		};
	}
	if (value.ui !== undefined) {
		if (
			!isRecord(value.ui) ||
			!hasOnlyKeys(value.ui, ["motion", "colorScheme"]) ||
			(value.ui.motion !== undefined && value.ui.motion !== "full" && value.ui.motion !== "reduced") ||
			(value.ui.colorScheme !== undefined &&
				value.ui.colorScheme !== "auto" &&
				value.ui.colorScheme !== "light" &&
				value.ui.colorScheme !== "dark")
		) {
			throw new Error("Coda settings contain an invalid UI setting");
		}
		ui = {
			...(value.ui.motion ? { motion: value.ui.motion } : {}),
			...(value.ui.colorScheme ? { colorScheme: value.ui.colorScheme } : {}),
		};
	}
	return {
		...(defaultModel ? { defaultModel } : {}),
		...(defaultReasoning ? { defaultReasoning } : {}),
		...(plugins ? { plugins } : {}),
		...(customProviders ? { customProviders } : {}),
		...(projectTrust ? { projectTrust } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(workspaceMcpTrust ? { workspaceMcpTrust } : {}),
		...(hookTrust ? { hookTrust } : {}),
		...(permission ? { permission } : {}),
		...(sandbox ? { sandbox } : {}),
		...(ui ? { ui } : {}),
		...(web ? { web } : {}),
	};
}

function validOptionalInteger(value: unknown, minimum: number, maximum: number): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum)
	);
}

function validProviderBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function settingsFile(settings: UserSettings): SettingsFile {
	const validated = validateSettings({ version: 1, ...settings });
	return { version: 1, ...validated };
}

export class FileSettingsStore implements SettingsStore {
	readonly #fileSystem: FileSystem;
	readonly #directory: string;
	readonly #path: string;
	readonly #idGenerator: IdGenerator;
	#tail: Promise<void> = Promise.resolve();

	constructor(options: FileSettingsStoreOptions) {
		this.#fileSystem = options.fileSystem;
		this.#directory = join(options.homeDirectory, ".coda");
		this.#path = join(this.#directory, "settings.json");
		this.#idGenerator = options.idGenerator;
	}

	async load(): Promise<UserSettings> {
		let bytes: Uint8Array;
		try {
			bytes = await this.#fileSystem.readFile(this.#path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return {};
			throw error;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Coda settings are not valid UTF-8");
		}
		try {
			return validateSettings(JSON.parse(text));
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error("Coda settings are not valid JSON");
			throw error;
		}
	}

	async save(settings: UserSettings): Promise<void> {
		const snapshot = settingsFile(settings);
		const operation = this.#tail
			.catch(() => undefined)
			.then(() =>
				withFileMutex({
					fileSystem: this.#fileSystem,
					path: join(this.#directory, "settings.v1.lock"),
					operation: () => this.#write(snapshot),
				}),
			);
		this.#tail = operation;
		await operation;
	}

	async update(mutator: (settings: UserSettings) => UserSettings): Promise<UserSettings> {
		const operation = this.#tail
			.catch(() => undefined)
			.then(() =>
				withFileMutex({
					fileSystem: this.#fileSystem,
					path: join(this.#directory, "settings.v1.lock"),
					operation: async () => {
						const current = await this.load();
						const candidate = mutator(current);
						const next = validateSettings(settingsFile(candidate));
						if (candidate === current) return current;
						await this.#write(settingsFile(next));
						return next;
					},
				}),
			);
		this.#tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async #write(settings: SettingsFile): Promise<void> {
		await this.#fileSystem.makeDirectory(this.#directory, { recursive: true, mode: 0o700 });
		await this.#fileSystem.setMode(this.#directory, 0o700);
		const id = this.#idGenerator.generate("queue_item").replace(/[^a-zA-Z0-9_-]/g, "-");
		const temporaryPath = join(this.#directory, `.settings-${id}.tmp`);
		let handle: WritableFile | undefined;
		let committed = false;
		let cleanupError: unknown;
		try {
			handle = await this.#fileSystem.open(temporaryPath, "wx", 0o600);
			await handle.write(`${JSON.stringify(settings, null, "\t")}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#fileSystem.setMode(temporaryPath, 0o600);
			await this.#fileSystem.rename(temporaryPath, this.#path);
			committed = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!committed) {
				try {
					await this.#fileSystem.removeFile(temporaryPath);
				} catch (error) {
					if (!isFileSystemError(error, "ENOENT")) cleanupError = error;
				}
			}
		}
		if (cleanupError !== undefined) throw cleanupError;
	}
}
