import { isAbsolute, join, relative, sep } from "node:path";
import type {
	SkillDiagnostic,
	SkillDirectoryEntry,
	SkillFileSystem,
	SkillRoot,
	Skills,
	SkillsSnapshot,
} from "@coda/skills";
import { createSkills } from "@coda/skills";
import { materializePluginMcp } from "./materialize.ts";
import { loadPluginMcp } from "./mcp-config.ts";
import { containsReservedCodexPluginComponent, guardReservedCodexPluginPaths } from "./reserved-path.ts";
import type {
	CreatePluginsOptions,
	LoadedPluginSnapshot,
	PluginDiagnostic,
	PluginLimits,
	PluginLoadRequest,
	PluginManifest,
	Plugins,
} from "./types.ts";
import { AGENT_PLUGIN_SCHEMA, DEFAULT_PLUGIN_LIMITS } from "./types.ts";

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as Error & { readonly code?: unknown }).code)
		: undefined;
}

function resolveLimits(overrides: Partial<PluginLimits> | undefined): Readonly<PluginLimits> {
	const limits = { ...DEFAULT_PLUGIN_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	}
	return Object.freeze(limits);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MANIFEST_FIELDS = new Set([
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
]);

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
	const entry = value[field];
	if (entry === undefined) return undefined;
	if (typeof entry !== "string") throw new Error(`plugin.json ${field} must be a string`);
	return entry;
}

function manifestFrom<Origin>(
	value: unknown,
	request: PluginLoadRequest<Origin>,
	diagnostics: PluginDiagnostic<Origin>[],
): PluginManifest {
	if (!isRecord(value)) throw new Error("plugin.json must contain a JSON object");
	if (value.extensions !== undefined && !isRecord(value.extensions)) {
		diagnostics.push(
			manifestDiagnostic(
				request,
				"manifest-extensions-ignored",
				"Ignored non-object plugin.json extensions",
				"warning",
				"extensions",
			),
		);
	}
	for (const field of Object.keys(value)) {
		if (MANIFEST_FIELDS.has(field)) continue;
		diagnostics.push(
			manifestDiagnostic(
				request,
				"manifest-unknown-field",
				`Ignored unknown plugin.json field: ${field}`,
				"warning",
				field,
			),
		);
	}
	if (value.$schema !== AGENT_PLUGIN_SCHEMA)
		throw new Error("plugin.json targets an unsupported Agent Plugins version");
	if (
		typeof value.name !== "string" ||
		value.name.length > 64 ||
		!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value.name)
	) {
		throw new Error("plugin.json name must satisfy the Agent Plugins name constraints");
	}
	let author: PluginManifest["author"];
	if (value.author !== undefined) {
		if (!isRecord(value.author)) throw new Error("plugin.json author must be an object");
		const unknown = Object.keys(value.author).find((field) => !["name", "email", "url"].includes(field));
		if (unknown) throw new Error(`plugin.json author contains an unknown field: ${unknown}`);
		const name = optionalString(value.author, "name");
		const email = optionalString(value.author, "email");
		const url = optionalString(value.author, "url");
		author = Object.freeze({
			...(name !== undefined ? { name } : {}),
			...(email !== undefined ? { email } : {}),
			...(url !== undefined ? { url } : {}),
		});
	}
	let keywords: readonly string[] | undefined;
	if (value.keywords !== undefined) {
		if (!Array.isArray(value.keywords) || value.keywords.some((entry) => typeof entry !== "string")) {
			throw new Error("plugin.json keywords must be an array of strings");
		}
		keywords = Object.freeze([...value.keywords]);
	}
	const version = optionalString(value, "version");
	const description = optionalString(value, "description");
	const homepage = optionalString(value, "homepage");
	const repository = optionalString(value, "repository");
	const license = optionalString(value, "license");
	return Object.freeze({
		$schema: AGENT_PLUGIN_SCHEMA,
		name: value.name,
		...(version !== undefined ? { version } : {}),
		...(description !== undefined ? { description } : {}),
		...(author ? { author } : {}),
		...(homepage !== undefined ? { homepage } : {}),
		...(repository !== undefined ? { repository } : {}),
		...(license !== undefined ? { license } : {}),
		...(keywords ? { keywords } : {}),
	});
}

function manifestDiagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	code: string,
	message: string,
	severity: PluginDiagnostic<Origin>["severity"],
	field?: string,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code,
		severity,
		phase: "manifest",
		message,
		...(field ? { field } : {}),
		path: join(request.root, "plugin.json"),
		pluginRoot: request.root,
		origin: request.origin,
	});
}

function componentDiagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	code: string,
	message: string,
	path: string,
	severity: PluginDiagnostic<Origin>["severity"] = "warning",
	componentName?: string,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code,
		severity,
		phase: "skill",
		message,
		...(componentName ? { componentName } : {}),
		path,
		pluginRoot: request.root,
		origin: request.origin,
	});
}

function stableSkillComponentName(name: string): string | undefined {
	const normalized = name.normalize("NFC");
	return normalized === name &&
		name.length >= 1 &&
		name.length <= 64 &&
		/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)
		? name
		: undefined;
}

function delegatedSkillDiagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	diagnostic: SkillDiagnostic<Origin>,
	componentName: string | undefined,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code: diagnostic.code,
		severity: diagnostic.severity,
		phase: "skill" as const,
		message: diagnostic.message,
		...(componentName ? { componentName } : {}),
		...(diagnostic.path ? { path: diagnostic.path } : {}),
		...(diagnostic.field ? { field: diagnostic.field } : {}),
		pluginRoot: request.root,
		origin: request.origin,
	});
}

function diagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	code: string,
	message: string,
	path?: string,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code,
		severity: "error",
		phase: "manifest",
		message,
		...(path ? { path } : {}),
		pluginRoot: request.root,
		origin: request.origin,
	});
}

async function loadSkills<Origin>(options: {
	readonly fileSystem: SkillFileSystem;
	readonly skills: Skills<Origin>;
	readonly request: PluginLoadRequest<Origin>;
	readonly root: string;
	readonly limits: Readonly<PluginLimits>;
	readonly diagnostics: PluginDiagnostic<Origin>[];
}): Promise<SkillsSnapshot<Origin>> {
	const componentRoot = join(options.root, "skills");
	const reportedRoot = join(options.request.root, "skills");
	let present = false;
	let canonicalRoot: string;
	try {
		await options.fileSystem.lstat(componentRoot);
		present = true;
		canonicalRoot = await options.fileSystem.realpath(componentRoot);
		if (!isContained(options.root, canonicalRoot)) throw new Error("skills/ resolves outside the Plugin root");
		if ((await options.fileSystem.stat(canonicalRoot)).kind !== "directory") {
			throw new Error("skills/ is not a directory");
		}
	} catch (error) {
		if (!present && errorCode(error) === "ENOENT") {
			return options.skills.snapshot({
				roots: [],
				profile: "strict",
				signal: options.request.signal,
			});
		}
		options.request.signal?.throwIfAborted();
		options.diagnostics.push(
			componentDiagnostic(
				options.request,
				"skills-component-invalid",
				`Could not load skills/: ${error instanceof Error ? error.message : String(error)}`,
				reportedRoot,
			),
		);
		return options.skills.snapshot({
			roots: [],
			profile: "strict",
			signal: options.request.signal,
		});
	}
	let entries: readonly SkillDirectoryEntry[];
	try {
		entries = [...(await options.fileSystem.readDirectory(canonicalRoot))].sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
	} catch (error) {
		options.request.signal?.throwIfAborted();
		options.diagnostics.push(
			componentDiagnostic(
				options.request,
				"skills-component-invalid",
				`Could not read skills/: ${error instanceof Error ? error.message : String(error)}`,
				reportedRoot,
			),
		);
		entries = [];
	}
	if (entries.length > options.limits.maxSkillScanEntries) {
		options.diagnostics.push(
			componentDiagnostic(
				options.request,
				"plugin-skill-scan-limit-exceeded",
				`Plugin Skill discovery exceeds ${options.limits.maxSkillScanEntries} immediate entries`,
				reportedRoot,
				"error",
			),
		);
	}
	const roots: { readonly componentName?: string; readonly root: SkillRoot<Origin> }[] = [];
	let componentsSeen = 0;
	for (const entry of entries.slice(0, options.limits.maxSkillScanEntries)) {
		options.request.signal?.throwIfAborted();
		if (entry.kind !== "directory" && entry.kind !== "symbolic-link") continue;
		componentsSeen++;
		if (componentsSeen > options.limits.maxSkillComponents) {
			options.diagnostics.push(
				componentDiagnostic(
					options.request,
					"plugin-skill-component-limit-exceeded",
					`Plugin Skill component count exceeds ${options.limits.maxSkillComponents}`,
					reportedRoot,
					"error",
				),
			);
			break;
		}
		const skillDirectory = join(componentRoot, entry.name);
		const skillFile = join(skillDirectory, "SKILL.md");
		const reportedSkillFile = join(reportedRoot, entry.name, "SKILL.md");
		try {
			const canonicalSkillDirectory = await options.fileSystem.realpath(skillDirectory);
			if (!isContained(options.root, canonicalSkillDirectory)) {
				throw new Error("Skill directory resolves outside the Plugin root");
			}
			if ((await options.fileSystem.stat(canonicalSkillDirectory)).kind !== "directory") continue;
			try {
				await options.fileSystem.lstat(skillFile);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			const canonicalFile = await options.fileSystem.realpath(skillFile);
			if (!isContained(options.root, canonicalFile)) throw new Error("SKILL.md resolves outside the Plugin root");
			if ((await options.fileSystem.stat(canonicalFile)).kind !== "file") {
				throw new Error("SKILL.md is not a regular file");
			}
			roots.push(
				Object.freeze({
					...(stableSkillComponentName(entry.name) ? { componentName: entry.name } : {}),
					root: Object.freeze({
						path: skillDirectory,
						origin: options.request.origin,
						symlinks: Object.freeze({ mode: "follow" as const, containmentRoot: options.root }),
					}),
				}),
			);
		} catch (error) {
			options.request.signal?.throwIfAborted();
			options.diagnostics.push(
				componentDiagnostic(
					options.request,
					"plugin-skill-invalid",
					`Skipped invalid Plugin Skill: ${error instanceof Error ? error.message : String(error)}`,
					reportedSkillFile,
					"warning",
					stableSkillComponentName(entry.name),
				),
			);
		}
	}
	if (roots.length === 0) {
		return options.skills.snapshot({
			roots: [],
			profile: "strict",
			signal: options.request.signal,
		});
	}
	const snapshots: SkillsSnapshot<Origin>[] = [];
	for (const entry of roots) {
		options.request.signal?.throwIfAborted();
		const snapshot = await options.skills.snapshot({
			roots: [entry.root],
			profile: "strict",
			signal: options.request.signal,
		});
		snapshots.push(snapshot);
		options.diagnostics.push(
			...snapshot.diagnostics.map((diagnostic) =>
				delegatedSkillDiagnostic(options.request, diagnostic, entry.componentName),
			),
		);
	}
	const activationOwners = new Map<string, SkillsSnapshot<Origin>>();
	const candidates = [];
	for (const snapshot of snapshots) {
		for (const candidate of snapshot.candidates) {
			if (activationOwners.has(candidate.id)) continue;
			activationOwners.set(candidate.id, snapshot);
			candidates.push(candidate);
		}
	}
	const firstSnapshot = snapshots[0]!;
	const combined: SkillsSnapshot<Origin> = {
		candidates: Object.freeze(candidates),
		diagnostics: Object.freeze(snapshots.flatMap(({ diagnostics }) => diagnostics)),
		activate: (id, activationOptions) => (activationOwners.get(id) ?? firstSnapshot).activate(id, activationOptions),
	};
	return Object.freeze(combined);
}

async function loadPlugin<Origin>(
	rootFileSystem: SkillFileSystem,
	fileSystem: SkillFileSystem,
	skills: Skills<Origin>,
	limits: Readonly<PluginLimits>,
	request: PluginLoadRequest<Origin>,
): Promise<
	| LoadedPluginSnapshot<Origin>
	| {
			readonly status: "rejected";
			readonly requestedRoot: string;
			readonly origin: Origin;
			readonly diagnostics: readonly PluginDiagnostic<Origin>[];
	  }
> {
	if (!request || !isAbsolute(request.root)) {
		throw new TypeError("Plugin root must be absolute");
	}
	request.signal?.throwIfAborted();
	if (containsReservedCodexPluginComponent(request.root)) {
		const entry = diagnostic(
			request,
			"plugin-root-unsupported",
			'Plugin roots inside ".codex-plugin" are outside the Agent Plugins protocol',
			request.root,
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([entry]),
		});
	}
	let root: string;
	try {
		root = await rootFileSystem.realpath(request.root);
	} catch (error) {
		request.signal?.throwIfAborted();
		const entry = diagnostic(
			request,
			"plugin-root-invalid",
			`Could not resolve Plugin root: ${String(error)}`,
			request.root,
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([entry]),
		});
	}
	if (containsReservedCodexPluginComponent(root)) {
		const entry = diagnostic(
			request,
			"plugin-root-unsupported",
			'Plugin roots resolving inside ".codex-plugin" are outside the Agent Plugins protocol',
			root,
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([entry]),
		});
	}
	let rootIdentity: { readonly device?: string; readonly inode?: string };
	try {
		const status = await fileSystem.lstat(root);
		if (status.kind !== "directory") throw new TypeError("Plugin root must be a real directory");
		rootIdentity = Object.freeze({
			...(status.device === undefined ? {} : { device: status.device }),
			...(status.inode === undefined ? {} : { inode: status.inode }),
		});
	} catch (error) {
		request.signal?.throwIfAborted();
		const entry = diagnostic(
			request,
			"plugin-root-invalid",
			`Could not resolve Plugin root: ${String(error)}`,
			request.root,
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([entry]),
		});
	}
	const manifestPath = join(root, "plugin.json");
	const diagnostics: PluginDiagnostic<Origin>[] = [];
	let manifest: PluginManifest;
	try {
		const canonicalManifest = await fileSystem.realpath(manifestPath);
		if (!isContained(root, canonicalManifest)) throw new Error("plugin.json resolves outside the Plugin root");
		const status = await fileSystem.stat(canonicalManifest);
		if (status.kind !== "file") throw new Error("plugin.json is not a regular file");
		if (status.size > limits.maxManifestBytes)
			throw new Error(`plugin.json exceeds ${limits.maxManifestBytes} bytes`);
		const bytes = await fileSystem.readFile(canonicalManifest);
		if (bytes.byteLength > limits.maxManifestBytes)
			throw new Error(`plugin.json exceeds ${limits.maxManifestBytes} bytes`);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		manifest = manifestFrom(JSON.parse(text), request, diagnostics);
		request.signal?.throwIfAborted();
	} catch (error) {
		request.signal?.throwIfAborted();
		const entry = diagnostic(
			request,
			"plugin-manifest-invalid",
			`Could not load plugin.json: ${error instanceof Error ? error.message : String(error)}`,
			join(request.root, "plugin.json"),
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([...diagnostics, entry]),
		});
	}
	const skillsSnapshot = await loadSkills({ fileSystem, skills, request, root, limits, diagnostics });
	const mcp = await loadPluginMcp({
		fileSystem,
		request,
		root,
		pluginName: manifest.name,
		limits,
		diagnostics,
	});
	return Object.freeze({
		status: "loaded" as const,
		requestedRoot: request.root,
		root,
		origin: request.origin,
		manifest,
		skills: skillsSnapshot,
		mcpServers: mcp.servers,
		...(mcp.configuration ? { mcpConfiguration: mcp.configuration } : {}),
		diagnostics: Object.freeze(diagnostics),
		materializeMcp: (options) =>
			materializePluginMcp({ fileSystem, request, root, rootIdentity, servers: mcp.servers, options }),
	});
}

export function createPlugins<Origin = unknown>(options: CreatePluginsOptions): Plugins<Origin> {
	if (!options || typeof options !== "object" || !options.fileSystem) throw new TypeError("fileSystem is required");
	const limits = resolveLimits(options.limits);
	const guardedFileSystem = guardReservedCodexPluginPaths(options.fileSystem);
	const skills = createSkills<Origin>({ fileSystem: guardedFileSystem });
	return Object.freeze({
		load: (request: PluginLoadRequest<Origin>) =>
			loadPlugin<Origin>(options.fileSystem, guardedFileSystem, skills, limits, request),
	});
}
