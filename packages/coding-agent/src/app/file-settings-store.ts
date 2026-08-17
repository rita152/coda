import { isAbsolute, join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import type { ThinkingLevel } from "@coda/ai";
import type { FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { parseMcpServerConfigurations } from "../mcp/config.ts";
import { parseCustomProviderModelConfig } from "../models/custom-model-metadata.ts";
import { AUTH_API_PROTOCOLS } from "../models/types.ts";
import type { SettingsStore, UserSettings } from "../settings/types.ts";

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

function validateSettings(value: unknown): UserSettings {
	if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported or invalid Coda settings format");
	if (
		!hasOnlyKeys(value, [
			"version",
			"defaultModel",
			"defaultReasoning",
			"customProviders",
			"projectTrust",
			"mcpServers",
			"workspaceMcpTrust",
			"hookTrust",
			"ui",
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
		workspaceMcpTrust = [...workspaceMcpTrust].sort((left, right) => left.workspace.localeCompare(right.workspace));
		if (new Set(workspaceMcpTrust.map(({ workspace }) => workspace)).size !== workspaceMcpTrust.length) {
			throw new Error("Coda settings contain duplicate Workspace MCP Trust records");
		}
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
		...(customProviders ? { customProviders } : {}),
		...(projectTrust ? { projectTrust } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(workspaceMcpTrust ? { workspaceMcpTrust } : {}),
		...(hookTrust ? { hookTrust } : {}),
		...(ui ? { ui } : {}),
	};
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
		const operation = this.#tail.catch(() => undefined).then(() => this.#write(snapshot));
		this.#tail = operation;
		await operation;
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
			await this.#fileSystem.setMode(this.#path, 0o600);
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
