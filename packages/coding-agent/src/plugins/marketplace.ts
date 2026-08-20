import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createPlugins } from "@coda/plugins";
import type { FileSystem } from "../host/file-system.ts";
import { pathHasComponent } from "./package-tree.ts";
import { type CodingPluginId, isCodingPluginLocalSource } from "./types.ts";

const MAX_MARKETPLACE_MANIFEST_BYTES = 1024 * 1024;
const MAX_MARKETPLACE_ENTRIES = 1024;

export interface CodingPluginMarketplaceDiagnostic {
	readonly code: string;
	readonly severity: "warning" | "error";
	readonly phase: "marketplace";
	readonly message: string;
	readonly path: string;
	readonly entryIndex?: number;
	readonly pluginId?: CodingPluginId;
}

export interface CodingPluginMarketplaceLocalSource {
	readonly source: "local";
	readonly path: string;
	readonly root: string;
}

export interface CodingPluginMarketplaceGitSource {
	readonly source: "url" | "git-subdir";
	readonly url: string;
	readonly path?: string;
	readonly ref?: string;
	readonly sha?: string;
}

export type CodingPluginMarketplaceSource = CodingPluginMarketplaceLocalSource | CodingPluginMarketplaceGitSource;

export interface CodingPluginMarketplaceEntry {
	readonly pluginId: CodingPluginId;
	readonly name: string;
	readonly marketplace: string;
	readonly source: CodingPluginMarketplaceSource;
}

interface CodingPluginMarketplaceSnapshotBase {
	readonly root: string;
	readonly diagnostics: readonly CodingPluginMarketplaceDiagnostic[];
}

export interface LoadedCodingPluginMarketplace extends CodingPluginMarketplaceSnapshotBase {
	readonly status: "loaded";
	readonly name: string;
	readonly entries: readonly CodingPluginMarketplaceEntry[];
}

export interface RejectedCodingPluginMarketplace extends CodingPluginMarketplaceSnapshotBase {
	readonly status: "rejected";
	readonly entries: readonly [];
}

export type CodingPluginMarketplace = LoadedCodingPluginMarketplace | RejectedCodingPluginMarketplace;

export interface LoadCodingPluginMarketplaceOptions {
	readonly root: string;
	readonly fileSystem: FileSystem;
}

interface PluginMarketplaceOrigin {
	readonly marketplace: string;
	readonly pluginId: CodingPluginId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function validMarketplaceName(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/u.test(value);
}

function validPluginName(value: string): boolean {
	return value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value);
}

function localSourcePath(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (
		isRecord(value) &&
		hasOnlyKeys(value, ["source", "path"]) &&
		value.source === "local" &&
		typeof value.path === "string"
	) {
		return value.path;
	}
	return undefined;
}

function normalizedGitUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "https:" && url.protocol !== "ssh:") || !url.hostname || url.password) return undefined;
		if (url.protocol === "https:" && url.username) return undefined;
		if (url.search || url.hash || url.pathname === "/") return undefined;
		for (const segment of url.pathname.split("/")) {
			const decoded = decodeURIComponent(segment);
			if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
				return undefined;
			}
		}
		url.pathname = url.pathname.replace(/\/+$/u, "");
		return url.toString();
	} catch {
		return undefined;
	}
}

function normalizedGitPath(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value ||
		value.includes("\\") ||
		posix.isAbsolute(value)
	) {
		return undefined;
	}
	if (value.split("/").some((component) => component.toLowerCase() === ".codex-plugin")) return undefined;
	const normalized = posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	return normalized;
}

function hasInvalidGitRefCharacter(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) <= 0x20 || "~^:?*[\\".includes(character));
}

function validGitRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 255 &&
		value.trim() === value &&
		!value.startsWith("-") &&
		!hasInvalidGitRefCharacter(value) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.includes("//") &&
		!value.endsWith("/") &&
		!value.endsWith(".") &&
		!value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))
	);
}

function gitSource(value: unknown): CodingPluginMarketplaceGitSource | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["source", "url", "path", "ref", "sha"]) ||
		(value.source !== "url" && value.source !== "git-subdir")
	) {
		return undefined;
	}
	const url = normalizedGitUrl(value.url);
	if (!url) return undefined;
	const path = value.path === undefined ? undefined : normalizedGitPath(value.path);
	if ((value.path !== undefined && !path) || (value.source === "git-subdir" && !path)) return undefined;
	if (value.ref !== undefined && !validGitRef(value.ref)) return undefined;
	if (
		value.sha !== undefined &&
		(typeof value.sha !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(value.sha))
	) {
		return undefined;
	}
	return Object.freeze({
		source: value.source,
		url,
		...(path ? { path } : {}),
		...(value.ref !== undefined ? { ref: value.ref } : {}),
		...(typeof value.sha === "string" ? { sha: value.sha.toLowerCase() } : {}),
	});
}

function diagnostic(
	code: string,
	message: string,
	path: string,
	options: { readonly entryIndex?: number; readonly pluginId?: CodingPluginId } = {},
): CodingPluginMarketplaceDiagnostic {
	return Object.freeze({
		code,
		severity: options.entryIndex === undefined ? ("error" as const) : ("warning" as const),
		phase: "marketplace" as const,
		message,
		path,
		...(options.entryIndex !== undefined ? { entryIndex: options.entryIndex } : {}),
		...(options.pluginId ? { pluginId: options.pluginId } : {}),
	});
}

function rejected(
	root: string,
	entries: readonly CodingPluginMarketplaceDiagnostic[],
): RejectedCodingPluginMarketplace {
	return Object.freeze({
		status: "rejected" as const,
		root,
		entries: Object.freeze([] as const),
		diagnostics: Object.freeze([...entries]),
	});
}

export async function loadCodingPluginMarketplace(
	options: LoadCodingPluginMarketplaceOptions,
): Promise<CodingPluginMarketplace> {
	if (!options || !options.fileSystem) throw new TypeError("fileSystem is required");
	if (!isAbsolute(options.root)) throw new TypeError("Marketplace root must be absolute");
	const lexicalMarketplaceRoot = join(options.root, ".agents", "plugins");
	const marketplacePath = join(lexicalMarketplaceRoot, "marketplace.json");
	if (pathHasComponent(options.root, ".codex-plugin")) {
		return rejected(lexicalMarketplaceRoot, [
			diagnostic(
				"plugin-marketplace-root-unavailable",
				'Plugin Marketplace roots below ".codex-plugin" are outside the Agent Plugins protocol',
				lexicalMarketplaceRoot,
			),
		]);
	}
	let marketplaceRoot: string;
	try {
		const canonicalConfiguredRoot = await options.fileSystem.realpath(options.root);
		if (pathHasComponent(canonicalConfiguredRoot, ".codex-plugin")) {
			throw new Error('Marketplace root resolves below reserved ".codex-plugin" content');
		}
		marketplaceRoot = await options.fileSystem.realpath(lexicalMarketplaceRoot);
		if (pathHasComponent(marketplaceRoot, ".codex-plugin")) {
			throw new Error('Marketplace component root resolves below reserved ".codex-plugin" content');
		}
		if (!isContained(canonicalConfiguredRoot, marketplaceRoot)) {
			throw new Error("Marketplace root resolves outside the configured root");
		}
		if ((await options.fileSystem.stat(marketplaceRoot)).kind !== "directory") {
			throw new Error("Marketplace root is not a directory");
		}
	} catch (error) {
		return rejected(lexicalMarketplaceRoot, [
			diagnostic(
				"plugin-marketplace-root-unavailable",
				`Could not resolve Plugin Marketplace root: ${error instanceof Error ? error.message : String(error)}`,
				lexicalMarketplaceRoot,
			),
		]);
	}
	let manifest: unknown;
	try {
		const canonicalMarketplacePath = await options.fileSystem.realpath(marketplacePath);
		if (pathHasComponent(canonicalMarketplacePath, ".codex-plugin")) {
			throw new Error('marketplace.json resolves below reserved ".codex-plugin" content');
		}
		if (!isContained(marketplaceRoot, canonicalMarketplacePath)) {
			throw new Error("marketplace.json resolves outside the Marketplace root");
		}
		const manifestStatus = await options.fileSystem.stat(canonicalMarketplacePath);
		if (manifestStatus.kind !== "file") {
			throw new Error("marketplace.json is not a regular file");
		}
		if (manifestStatus.size > MAX_MARKETPLACE_MANIFEST_BYTES) {
			return rejected(marketplaceRoot, [
				diagnostic(
					"plugin-marketplace-manifest-too-large",
					`marketplace.json is ${manifestStatus.size} bytes; the maximum accepted size is 1 MiB (${MAX_MARKETPLACE_MANIFEST_BYTES} bytes)`,
					marketplacePath,
				),
			]);
		}
		const bytes = await options.fileSystem.readFile(canonicalMarketplacePath);
		if (bytes.byteLength > MAX_MARKETPLACE_MANIFEST_BYTES) {
			return rejected(marketplaceRoot, [
				diagnostic(
					"plugin-marketplace-manifest-too-large",
					`marketplace.json is ${bytes.byteLength} bytes; the maximum accepted size is 1 MiB (${MAX_MARKETPLACE_MANIFEST_BYTES} bytes)`,
					marketplacePath,
				),
			]);
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		manifest = JSON.parse(text);
	} catch (error) {
		return rejected(marketplaceRoot, [
			diagnostic(
				"plugin-marketplace-manifest-unreadable",
				`Could not read marketplace.json: ${error instanceof Error ? error.message : String(error)}`,
				marketplacePath,
			),
		]);
	}
	if (!isRecord(manifest) || typeof manifest.name !== "string" || !Array.isArray(manifest.plugins)) {
		return rejected(marketplaceRoot, [
			diagnostic(
				"plugin-marketplace-manifest-invalid",
				"marketplace.json must contain a valid name and a plugins array",
				marketplacePath,
			),
		]);
	}
	if (manifest.plugins.length > MAX_MARKETPLACE_ENTRIES) {
		return rejected(marketplaceRoot, [
			diagnostic(
				"plugin-marketplace-entry-limit-exceeded",
				`marketplace.json declares ${manifest.plugins.length} entries; the limit is ${MAX_MARKETPLACE_ENTRIES}`,
				marketplacePath,
			),
		]);
	}
	if (isCodingPluginLocalSource(manifest.name)) {
		return rejected(marketplaceRoot, [
			diagnostic(
				"plugin-marketplace-name-reserved",
				`Plugin Marketplace name "${manifest.name}" is reserved for direct Agent Plugin installations`,
				marketplacePath,
			),
		]);
	}
	if (!validMarketplaceName(manifest.name)) {
		return rejected(marketplaceRoot, [
			diagnostic(
				"plugin-marketplace-manifest-invalid",
				"marketplace.json must contain a valid name and a plugins array",
				marketplacePath,
			),
		]);
	}
	const name = manifest.name;
	const diagnostics: CodingPluginMarketplaceDiagnostic[] = [];
	const entries: CodingPluginMarketplaceEntry[] = [];
	const admittedPluginIds = new Set<CodingPluginId>();
	const admit = (entry: CodingPluginMarketplaceEntry, entryIndex: number): void => {
		if (admittedPluginIds.has(entry.pluginId)) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-duplicate-id",
					`Skipped duplicate Plugin Marketplace entry "${entry.pluginId}"`,
					marketplacePath,
					{ entryIndex, pluginId: entry.pluginId },
				),
			);
			return;
		}
		admittedPluginIds.add(entry.pluginId);
		entries.push(entry);
	};
	const loader = createPlugins<PluginMarketplaceOrigin>({ fileSystem: options.fileSystem });
	for (const [entryIndex, value] of manifest.plugins.entries()) {
		if (!isRecord(value) || typeof value.name !== "string" || !validPluginName(value.name)) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-entry-invalid",
					"Skipped invalid Plugin Marketplace entry",
					marketplacePath,
					{ entryIndex },
				),
			);
			continue;
		}
		const pluginId = `${value.name}@${name}` as CodingPluginId;
		const remoteSource = gitSource(value.source);
		if (remoteSource) {
			admit(
				Object.freeze({
					pluginId,
					name: value.name,
					marketplace: name,
					source: remoteSource,
				}),
				entryIndex,
			);
			continue;
		}
		const sourcePath = localSourcePath(value.source);
		if (!sourcePath || !sourcePath.startsWith("./")) {
			const declaredSource = isRecord(value.source) ? value.source.source : undefined;
			const unsupported = declaredSource === "npm";
			const invalidGit = declaredSource === "url" || declaredSource === "git-subdir";
			diagnostics.push(
				diagnostic(
					unsupported
						? "plugin-marketplace-source-unsupported"
						: invalidGit
							? "plugin-marketplace-git-source-invalid"
							: "plugin-marketplace-entry-invalid",
					unsupported
						? `Skipped Plugin "${pluginId}" because npm sources are unsupported`
						: `Skipped Plugin "${pluginId}" because its source is invalid`,
					marketplacePath,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		if (sourcePath.split("/").some((component) => component.toLowerCase() === ".codex-plugin")) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-package-invalid",
					`Skipped Plugin "${pluginId}" because its source crosses reserved .codex-plugin content`,
					sourcePath,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		const lexicalPluginRoot = resolve(marketplaceRoot, sourcePath);
		if (!isContained(marketplaceRoot, lexicalPluginRoot)) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-local-source-outside-root",
					`Skipped Plugin "${pluginId}" because its local source escapes the Marketplace root`,
					lexicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		if (pathHasComponent(lexicalPluginRoot, ".codex-plugin")) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-package-invalid",
					`Skipped Plugin "${pluginId}" because its source is below reserved .codex-plugin content`,
					lexicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		let canonicalPluginRoot: string;
		try {
			canonicalPluginRoot = await options.fileSystem.realpath(lexicalPluginRoot);
		} catch (error) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-local-source-unavailable",
					`Skipped Plugin "${pluginId}": ${error instanceof Error ? error.message : String(error)}`,
					lexicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		if (!isContained(marketplaceRoot, canonicalPluginRoot)) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-local-source-outside-root",
					`Skipped Plugin "${pluginId}" because its local source resolves outside the Marketplace root`,
					canonicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		if (pathHasComponent(canonicalPluginRoot, ".codex-plugin")) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-package-invalid",
					`Skipped Plugin "${pluginId}" because its source resolves below reserved .codex-plugin content`,
					canonicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		const snapshot = await loader.load({
			root: canonicalPluginRoot,
			origin: Object.freeze({ marketplace: name, pluginId }),
		});
		if (snapshot.status !== "loaded" || snapshot.manifest.name !== value.name) {
			diagnostics.push(
				diagnostic(
					"plugin-marketplace-package-invalid",
					`Skipped Plugin "${pluginId}" because its source is not a matching Agent Plugins package`,
					canonicalPluginRoot,
					{ entryIndex, pluginId },
				),
			);
			continue;
		}
		admit(
			Object.freeze({
				pluginId,
				name: value.name,
				marketplace: name,
				source: Object.freeze({
					source: "local" as const,
					path: sourcePath,
					root: canonicalPluginRoot,
				}),
			}),
			entryIndex,
		);
	}
	return Object.freeze({
		status: "loaded" as const,
		name,
		root: marketplaceRoot,
		entries: Object.freeze(entries),
		diagnostics: Object.freeze(diagnostics),
	});
}
