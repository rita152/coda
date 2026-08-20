import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { SkillCandidate, SkillFileSystem, SkillId } from "@coda/skills";
import { parse } from "yaml";
import type {
	CodingSkillDependenciesMetadata,
	CodingSkillDiagnostic,
	CodingSkillInterfaceMetadata,
	CodingSkillOrigin,
	CodingSkillPolicyMetadata,
	CodingSkillProduct,
	CodingSkillSidecarMetadata,
	CodingSkillsSnapshot,
	CodingSkillToolDependency,
	ResolvedCodingSkill,
} from "./types.ts";

const MAX_INTERFACE_NAME_CHARACTERS = 64;
const MAX_INTERFACE_DESCRIPTION_CHARACTERS = 1_024;
const MAX_DEPENDENCY_TYPE_CHARACTERS = 64;
const MAX_DEPENDENCY_TRANSPORT_CHARACTERS = 64;
const MAX_DEPENDENCY_TEXT_CHARACTERS = 1_024;
const MAX_SKILL_SIDECAR_BYTES = 64 * 1024;
const MAX_CONCURRENT_SKILL_SIDECAR_READS = 16;
const MAX_SKILL_SIDECAR_DIAGNOSTIC_CHARACTERS = 768;

interface RawOpenAiSkillMetadata {
	readonly interface?: Readonly<Record<string, unknown>>;
	readonly dependencyTools?: readonly Readonly<Record<string, unknown>>[];
	readonly policy?: Readonly<Record<string, unknown>>;
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalMapping(
	document: Readonly<Record<string, unknown>>,
	field: "interface" | "dependencies" | "policy",
): Readonly<Record<string, unknown>> | undefined | false {
	const value = document[field];
	if (value === undefined || value === null) return undefined;
	return isMapping(value) ? value : false;
}

function hasOnlyOptionalStrings(mapping: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
	return fields.every((field) => {
		const value = mapping[field];
		return value === undefined || value === null || typeof value === "string";
	});
}

function validOptionalCallbackPort(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535)
	);
}

function validDependencyTool(value: unknown): value is Readonly<Record<string, unknown>> {
	if (
		!isMapping(value) ||
		!hasOnlyOptionalStrings(value, ["type", "value", "description", "transport", "command", "url"])
	) {
		return false;
	}
	const oauth = value.oauth;
	if (oauth === undefined || oauth === null) return true;
	if (!isMapping(oauth)) return false;
	if (oauth.callbackPort !== undefined && oauth.callback_port !== undefined) return false;
	return validOptionalCallbackPort(oauth.callbackPort) && validOptionalCallbackPort(oauth.callback_port);
}

function deserializeOpenAiSkillMetadata(text: string): RawOpenAiSkillMetadata | undefined {
	try {
		const document: unknown = parse(text);
		if (!isMapping(document)) return undefined;
		const interfaceMetadata = optionalMapping(document, "interface");
		const dependencies = optionalMapping(document, "dependencies");
		const policy = optionalMapping(document, "policy");
		if (interfaceMetadata === false || dependencies === false || policy === false) return undefined;
		if (
			interfaceMetadata &&
			!hasOnlyOptionalStrings(interfaceMetadata, [
				"display_name",
				"short_description",
				"icon_small",
				"icon_large",
				"brand_color",
				"default_prompt",
			])
		) {
			return undefined;
		}
		const dependencyToolsValue = dependencies?.tools;
		if (dependencyToolsValue !== undefined && !Array.isArray(dependencyToolsValue)) return undefined;
		if (Array.isArray(dependencyToolsValue) && dependencyToolsValue.some((tool) => !validDependencyTool(tool))) {
			return undefined;
		}
		const dependencyTools = Array.isArray(dependencyToolsValue)
			? (dependencyToolsValue as readonly Readonly<Record<string, unknown>>[])
			: [];
		const allowImplicitInvocation = policy?.allow_implicit_invocation;
		if (
			allowImplicitInvocation !== undefined &&
			allowImplicitInvocation !== null &&
			typeof allowImplicitInvocation !== "boolean"
		) {
			return undefined;
		}
		const productsValue = policy?.products;
		if (
			productsValue !== undefined &&
			(!Array.isArray(productsValue) || productsValue.some((product) => decodeProduct(product) === undefined))
		) {
			return undefined;
		}
		return Object.freeze({
			...(interfaceMetadata ? { interface: interfaceMetadata } : {}),
			...(dependencies ? { dependencyTools } : {}),
			...(policy ? { policy } : {}),
		});
	} catch {
		return undefined;
	}
}

function decodeProduct(value: unknown): CodingSkillProduct | undefined {
	if (value === "chatgpt" || value === "CHATGPT") return "chatgpt";
	if (value === "codex" || value === "CODEX") return "codex";
	if (value === "atlas" || value === "ATLAS") return "atlas";
	return undefined;
}

function normalizedInterfaceString(value: unknown, maximumCharacters: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalizedValue = value.split(/\s+/u).filter(Boolean).join(" ");
	if (!normalizedValue || Array.from(normalizedValue).length > maximumCharacters) return undefined;
	return normalizedValue;
}

function resolvedBrandColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalizedValue = value.trim();
	return /^#[0-9a-f]{6}$/iu.test(normalizedValue) ? normalizedValue : undefined;
}

function containsParentComponent(path: string): boolean {
	return path.split(sep).includes("..");
}

function resolvedInterfaceAssetPath(
	value: unknown,
	options: { readonly skillDirectory: string; readonly pluginRoot?: string },
): string | undefined {
	if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return undefined;
	if (containsParentComponent(value)) {
		if (!options.pluginRoot || !isAbsolute(options.pluginRoot)) return undefined;
		const target = resolve(options.skillDirectory, value);
		return isContained(join(options.pluginRoot, "assets"), target) ? target : undefined;
	}
	const normalizedValue = normalize(value);
	if (normalizedValue.split(sep)[0] !== "assets") return undefined;
	return join(options.skillDirectory, normalizedValue);
}

function resolvedInterface(
	value: Readonly<Record<string, unknown>> | undefined,
	options: { readonly skillDirectory: string; readonly pluginRoot?: string },
): CodingSkillInterfaceMetadata | undefined {
	if (!value) return undefined;
	const displayName = normalizedInterfaceString(value.display_name, MAX_INTERFACE_NAME_CHARACTERS);
	const shortDescription = normalizedInterfaceString(value.short_description, MAX_INTERFACE_DESCRIPTION_CHARACTERS);
	const iconSmall = resolvedInterfaceAssetPath(value.icon_small, options);
	const iconLarge = resolvedInterfaceAssetPath(value.icon_large, options);
	const brandColor = resolvedBrandColor(value.brand_color);
	const defaultPrompt = normalizedInterfaceString(value.default_prompt, MAX_INTERFACE_DESCRIPTION_CHARACTERS);
	const resolved = Object.freeze({
		...(displayName ? { displayName } : {}),
		...(shortDescription ? { shortDescription } : {}),
		...(iconSmall ? { iconSmall } : {}),
		...(iconLarge ? { iconLarge } : {}),
		...(brandColor ? { brandColor } : {}),
		...(defaultPrompt ? { defaultPrompt } : {}),
	});
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolvedDependencyString(value: unknown, maximumCharacters: number): string | undefined {
	return normalizedInterfaceString(value, maximumCharacters);
}

function resolvedDependencyTool(value: Readonly<Record<string, unknown>>): CodingSkillToolDependency | undefined {
	const type = resolvedDependencyString(value.type, MAX_DEPENDENCY_TYPE_CHARACTERS);
	const dependencyValue = resolvedDependencyString(value.value, MAX_DEPENDENCY_TEXT_CHARACTERS);
	if (!type || !dependencyValue) return undefined;
	const description = resolvedDependencyString(value.description, MAX_DEPENDENCY_TEXT_CHARACTERS);
	const transport = resolvedDependencyString(value.transport, MAX_DEPENDENCY_TRANSPORT_CHARACTERS);
	const command = resolvedDependencyString(value.command, MAX_DEPENDENCY_TEXT_CHARACTERS);
	const url = resolvedDependencyString(value.url, MAX_DEPENDENCY_TEXT_CHARACTERS);
	const oauthValue = isMapping(value.oauth) ? value.oauth : undefined;
	const callbackPort = oauthValue?.callbackPort ?? oauthValue?.callback_port;
	const oauth = typeof callbackPort === "number" ? Object.freeze({ callbackPort }) : undefined;
	return Object.freeze({
		type,
		value: dependencyValue,
		...(description ? { description } : {}),
		...(transport ? { transport } : {}),
		...(command ? { command } : {}),
		...(url ? { url } : {}),
		...(oauth ? { oauth } : {}),
	});
}

function resolvedDependencies(
	tools: readonly Readonly<Record<string, unknown>>[] | undefined,
): CodingSkillDependenciesMetadata | undefined {
	if (!tools) return undefined;
	const resolvedTools = Object.freeze(
		tools.flatMap((tool) => {
			const resolved = resolvedDependencyTool(tool);
			return resolved ? [resolved] : [];
		}),
	);
	return resolvedTools.length > 0 ? Object.freeze({ tools: resolvedTools }) : undefined;
}

function resolvedPolicy(value: Readonly<Record<string, unknown>> | undefined): CodingSkillPolicyMetadata | undefined {
	if (!value) return undefined;
	const allowImplicitInvocation = value.allow_implicit_invocation;
	const products = Object.freeze(
		((value.products as readonly unknown[] | undefined) ?? []).map((product) => decodeProduct(product)!),
	);
	return Object.freeze({
		...(typeof allowImplicitInvocation === "boolean" ? { allowImplicitInvocation } : {}),
		products,
	});
}

export function parseSkillSidecarMetadata(
	text: string,
	options: { readonly skillDirectory: string; readonly pluginRoot?: string },
): CodingSkillSidecarMetadata {
	const metadata = deserializeOpenAiSkillMetadata(text);
	if (!metadata) return Object.freeze({});
	const interfaceMetadata = resolvedInterface(metadata.interface, options);
	const dependencies = resolvedDependencies(metadata.dependencyTools);
	const policy = resolvedPolicy(metadata.policy);
	return Object.freeze({
		...(interfaceMetadata ? { interface: interfaceMetadata } : {}),
		...(dependencies ? { dependencies } : {}),
		...(policy ? { policy } : {}),
	});
}

export function allowsImplicitInvocation(input: {
	readonly disableModelInvocation?: boolean;
	readonly sidecarAllowImplicit?: boolean;
}): boolean {
	if (input.disableModelInvocation === true) return false;
	if (input.sidecarAllowImplicit === false) return false;
	return true;
}

export function parseAllowImplicitInvocation(text: string): boolean | undefined {
	const metadata = deserializeOpenAiSkillMetadata(text);
	return typeof metadata?.policy?.allow_implicit_invocation === "boolean"
		? metadata.policy.allow_implicit_invocation
		: undefined;
}

export function modelVisibleSkills(snapshot: CodingSkillsSnapshot): readonly ResolvedCodingSkill[] {
	return snapshot.resolved.filter((entry) => entry.implicitInvocation);
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as Error & { readonly code?: unknown }).code)
		: undefined;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function readableSidecarPath(
	fileSystem: SkillFileSystem,
	candidate: SkillCandidate<CodingSkillOrigin>,
	path: string,
): Promise<string | undefined> {
	const pluginOrigin = candidate.provenance.map(({ origin }) => origin).find(({ kind }) => kind === "plugin");
	if (!pluginOrigin) return path;
	if (!pluginOrigin.pluginRoot) return undefined;
	await fileSystem.lstat(path);
	const [currentPluginRoot, canonicalPath] = await Promise.all([
		fileSystem.realpath(pluginOrigin.root),
		fileSystem.realpath(path),
	]);
	if (relative(pluginOrigin.pluginRoot, currentPluginRoot) !== "") return undefined;
	if (!isContained(pluginOrigin.pluginRoot, canonicalPath)) return undefined;
	return canonicalPath;
}

function boundedSidecarDiagnosticText(value: unknown): string {
	const text = String(value).replace(/\s+/gu, " ").trim();
	const characters = Array.from(text);
	return characters.length <= MAX_SKILL_SIDECAR_DIAGNOSTIC_CHARACTERS
		? text
		: `${characters.slice(0, MAX_SKILL_SIDECAR_DIAGNOSTIC_CHARACTERS - 3).join("")}...`;
}

function sidecarDiagnostic(
	candidate: SkillCandidate<CodingSkillOrigin>,
	path: string,
	code: "skill-sidecar-invalid" | "skill-sidecar-read-failed" | "skill-sidecar-too-large",
	message: string,
): CodingSkillDiagnostic {
	return Object.freeze({
		code,
		severity: "warning" as const,
		message: boundedSidecarDiagnosticText(message),
		skillId: candidate.id,
		path,
	});
}

async function mapConcurrentOrdered<T, R>(
	values: readonly T[],
	maximum: number,
	operation: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	const worker = async () => {
		for (;;) {
			const index = next++;
			if (index >= values.length) return;
			results[index] = await operation(values[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(maximum, values.length) }, worker));
	return results;
}

export interface ReadSkillSidecarMetadataResult {
	readonly metadataById: ReadonlyMap<SkillId, CodingSkillSidecarMetadata>;
	readonly diagnostics: readonly CodingSkillDiagnostic[];
}

/** Reads optional Codex `agents/openai.yaml` metadata without failing Skill discovery. */
export async function readSkillSidecarMetadata(
	fileSystem: SkillFileSystem,
	candidates: readonly SkillCandidate<CodingSkillOrigin>[],
): Promise<ReadSkillSidecarMetadataResult> {
	const results = await mapConcurrentOrdered(candidates, MAX_CONCURRENT_SKILL_SIDECAR_READS, async (candidate) => {
		const path = join(candidate.directory, "agents", "openai.yaml");
		try {
			const readablePath = await readableSidecarPath(fileSystem, candidate, path);
			if (!readablePath) {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-invalid",
						"Skill sidecar did not resolve to a regular file inside its Agent Plugin root",
					),
				};
			}
			const status = await fileSystem.stat(readablePath);
			if (status.kind !== "file") {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-invalid",
						"Skill sidecar is not a regular file",
					),
				};
			}
			if (status.size > MAX_SKILL_SIDECAR_BYTES) {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-too-large",
						`Skill sidecar exceeds the ${MAX_SKILL_SIDECAR_BYTES}-byte limit`,
					),
				};
			}
			const bytes = await fileSystem.readFile(readablePath);
			if (bytes.byteLength > MAX_SKILL_SIDECAR_BYTES) {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-too-large",
						`Skill sidecar exceeds the ${MAX_SKILL_SIDECAR_BYTES}-byte limit after reading`,
					),
				};
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-invalid",
						"Skill sidecar is not valid UTF-8",
					),
				};
			}
			const deserialized = deserializeOpenAiSkillMetadata(text);
			if (!deserialized) {
				return {
					diagnostic: sidecarDiagnostic(
						candidate,
						path,
						"skill-sidecar-invalid",
						"Skill sidecar is not a valid Codex agents/openai.yaml document",
					),
				};
			}
			const pluginRoot = candidate.provenance
				.map(({ origin }) => origin)
				.find(({ kind }) => kind === "plugin")?.pluginRoot;
			const interfaceMetadata = resolvedInterface(deserialized.interface, {
				skillDirectory: candidate.directory,
				...(pluginRoot ? { pluginRoot } : {}),
			});
			const dependencies = resolvedDependencies(deserialized.dependencyTools);
			const policy = resolvedPolicy(deserialized.policy);
			const metadata = Object.freeze({
				...(interfaceMetadata ? { interface: interfaceMetadata } : {}),
				...(dependencies ? { dependencies } : {}),
				...(policy ? { policy } : {}),
			});
			return Object.keys(metadata).length === 0 ? {} : { entry: [candidate.id, metadata] as const };
		} catch (error) {
			if (errorCode(error) === "ENOENT") return {};
			return {
				diagnostic: sidecarDiagnostic(
					candidate,
					path,
					"skill-sidecar-read-failed",
					`Skill sidecar could not be read: ${String(error)}`,
				),
			};
		}
	});
	const entries = results.flatMap((result) => (result.entry ? [result.entry] : []));
	const diagnostics = results.flatMap((result) => (result.diagnostic ? [result.diagnostic] : []));
	return Object.freeze({ metadataById: new Map(entries), diagnostics: Object.freeze(diagnostics) });
}
