import { isAbsolute, join, relative, sep } from "node:path";
import type { SkillDirectoryEntry, SkillFileSystem, SkillRoot, Skills, SkillsSnapshot } from "@coda/skills";
import { createSkills } from "@coda/skills";
import { materializePluginMcp } from "./materialize.ts";
import { loadPluginMcp } from "./mcp-config.ts";
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
		author = Object.freeze({
			...(optionalString(value.author, "name") !== undefined ? { name: optionalString(value.author, "name") } : {}),
			...(optionalString(value.author, "email") !== undefined
				? { email: optionalString(value.author, "email") }
				: {}),
			...(optionalString(value.author, "url") !== undefined ? { url: optionalString(value.author, "url") } : {}),
		});
	}
	let keywords: readonly string[] | undefined;
	if (value.keywords !== undefined) {
		if (!Array.isArray(value.keywords) || value.keywords.some((entry) => typeof entry !== "string")) {
			throw new Error("plugin.json keywords must be an array of strings");
		}
		keywords = Object.freeze([...value.keywords]);
	}
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
	return Object.freeze({
		$schema: AGENT_PLUGIN_SCHEMA,
		name: value.name,
		...(optionalString(value, "version") !== undefined ? { version: optionalString(value, "version") } : {}),
		...(optionalString(value, "description") !== undefined
			? { description: optionalString(value, "description") }
			: {}),
		...(author ? { author } : {}),
		...(optionalString(value, "homepage") !== undefined ? { homepage: optionalString(value, "homepage") } : {}),
		...(optionalString(value, "repository") !== undefined ? { repository: optionalString(value, "repository") } : {}),
		...(optionalString(value, "license") !== undefined ? { license: optionalString(value, "license") } : {}),
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
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code,
		severity,
		phase: "skill",
		message,
		path,
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

async function canonicalDirectory(fileSystem: SkillFileSystem, path: string, label: string): Promise<string> {
	const canonical = await fileSystem.realpath(path);
	if ((await fileSystem.stat(canonical)).kind !== "directory") throw new TypeError(`${label} must be a directory`);
	return canonical;
}

async function loadSkills<Origin>(options: {
	readonly fileSystem: SkillFileSystem;
	readonly skills: Skills<Origin>;
	readonly request: PluginLoadRequest<Origin>;
	readonly root: string;
	readonly diagnostics: PluginDiagnostic<Origin>[];
}): Promise<SkillsSnapshot<Origin>> {
	const lexicalRoot = join(options.request.root, "skills");
	let present = false;
	let canonicalRoot: string;
	try {
		await options.fileSystem.lstat(lexicalRoot);
		present = true;
		canonicalRoot = await options.fileSystem.realpath(lexicalRoot);
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
				lexicalRoot,
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
				lexicalRoot,
			),
		);
		entries = [];
	}
	const roots: SkillRoot<Origin>[] = [];
	for (const entry of entries) {
		options.request.signal?.throwIfAborted();
		if (entry.kind !== "directory" && entry.kind !== "symbolic-link") continue;
		const skillDirectory = join(lexicalRoot, entry.name);
		const skillFile = join(skillDirectory, "SKILL.md");
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
					path: skillDirectory,
					origin: options.request.origin,
					symlinks: Object.freeze({ mode: "follow" as const, containmentRoot: options.root }),
				}),
			);
		} catch (error) {
			options.request.signal?.throwIfAborted();
			options.diagnostics.push(
				componentDiagnostic(
					options.request,
					"plugin-skill-invalid",
					`Skipped invalid Plugin Skill: ${error instanceof Error ? error.message : String(error)}`,
					skillFile,
				),
			);
		}
	}
	return options.skills.snapshot({
		roots: Object.freeze(roots),
		profile: "strict",
		signal: options.request.signal,
	});
}

async function loadPlugin<Origin>(
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
	let root: string;
	try {
		root = await canonicalDirectory(fileSystem, request.root, "Plugin root");
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
	const manifestPath = join(request.root, "plugin.json");
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
			manifestPath,
		);
		return Object.freeze({
			status: "rejected" as const,
			requestedRoot: request.root,
			origin: request.origin,
			diagnostics: Object.freeze([entry]),
		});
	}
	const skillsSnapshot = await loadSkills({ fileSystem, skills, request, root, diagnostics });
	diagnostics.push(
		...skillsSnapshot.diagnostics.map((entry) =>
			Object.freeze({
				code: entry.code,
				severity: entry.severity,
				phase: "skill" as const,
				message: entry.message,
				...(entry.path ? { path: entry.path } : {}),
				...(entry.field ? { field: entry.field } : {}),
				pluginRoot: request.root,
				origin: request.origin,
			}),
		),
	);
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
		materializeMcp: (options) => materializePluginMcp({ fileSystem, request, root, servers: mcp.servers, options }),
	});
}

export function createPlugins<Origin = unknown>(options: CreatePluginsOptions): Plugins<Origin> {
	if (!options || typeof options !== "object" || !options.fileSystem) throw new TypeError("fileSystem is required");
	const limits = resolveLimits(options.limits);
	const skills = createSkills<Origin>({ fileSystem: options.fileSystem });
	return Object.freeze({
		load: (request: PluginLoadRequest<Origin>) => loadPlugin<Origin>(options.fileSystem, skills, limits, request),
	});
}
