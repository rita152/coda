import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	CAPABILITY_MANIFEST_VERSION,
	CAPABILITY_STATUSES,
	type CapabilityContractEntry,
	type CapabilityStatus,
	CODA_CAPABILITY_CONTRACT,
	RUNTIME_CAPABILITY_FACTS,
} from "../src/runtime/capability-contract.ts";

const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = "capabilities.v1.json";
const README_PATH = "packages/coding-agent/README.md";

export const CORE_COMMANDS_MARKERS = Object.freeze({
	start: "<!-- coda:core-commands:start -->",
	end: "<!-- coda:core-commands:end -->",
});

export const CAPABILITIES_MARKERS = Object.freeze({
	start: "<!-- coda:capabilities:start -->",
	end: "<!-- coda:capabilities:end -->",
});

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CapabilityManifestEntry extends CapabilityContractEntry {
	readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface CapabilityManifest {
	readonly schema: "coda-capabilities-v1";
	readonly version: 1;
	readonly profile: "coda-current-runtime";
	readonly generatedBy: "npm run capabilities:update";
	readonly statusDefinitions: Readonly<Record<CapabilityStatus, string>>;
	readonly sources: readonly string[];
	readonly runtimeFacts: {
		readonly session: {
			readonly currentFormatVersion: number;
			readonly supportedFormatVersions: readonly number[];
			readonly recordTypes: readonly string[];
		};
		readonly tools: { readonly builtIn: readonly string[] };
		readonly commands: readonly {
			readonly name: string;
			readonly aliases: readonly string[];
			readonly visible: boolean;
			readonly arguments: "none" | "tail";
		}[];
		readonly modelApiProtocols: readonly string[];
		readonly aiTypeOnlyExports: readonly string[];
		readonly codingAgentPackage: {
			readonly private: boolean;
			readonly exports: readonly string[];
		};
	};
	readonly capabilities: readonly CapabilityManifestEntry[];
}

interface AiCompatibilityManifest {
	readonly rootTypes: Readonly<Record<string, { readonly status: string }>>;
}

interface CodingAgentPackageJson {
	readonly private: boolean;
	readonly exports: Readonly<Record<string, unknown>>;
}

export interface CapabilityArtifacts {
	readonly manifest: CapabilityManifest;
	readonly manifestText: string;
	readonly readmeText: string;
}

const STATUS_DEFINITIONS: Readonly<Record<CapabilityStatus, string>> = Object.freeze({
	"runtime-supported": "Implemented and exercised through the current Coda runtime.",
	"type-only": "Expressible in a public TypeScript surface without corresponding runtime support.",
	"experimental-private":
		"Implemented only behind a private or experimental seam with no public compatibility promise.",
	deferred: "Explicitly outside the current runtime; presence in types or upstream protocols does not imply support.",
});

const STATUS_HEADINGS: Readonly<Record<CapabilityStatus, string>> = Object.freeze({
	"runtime-supported": "Runtime-supported",
	"type-only": "Type-only (not runtime support)",
	"experimental-private": "Experimental/private",
	deferred: "Explicitly deferred",
});

export async function generateCapabilityArtifacts(
	repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<CapabilityArtifacts> {
	const [compatibilityText, packageText, readmeText] = await Promise.all([
		readFile(resolve(repositoryRoot, "packages/ai/compatibility/manifest.v1.json"), "utf8"),
		readFile(resolve(repositoryRoot, "packages/coding-agent/package.json"), "utf8"),
		readFile(resolve(repositoryRoot, README_PATH), "utf8"),
	]);
	const compatibility = parseJson<AiCompatibilityManifest>(compatibilityText, "AI compatibility manifest");
	const packageJson = parseJson<CodingAgentPackageJson>(packageText, "Coding Agent package manifest");
	const aiTypeOnlyExports = Object.entries(compatibility.rootTypes)
		.filter(([, entry]) => entry.status === "type-only")
		.map(([name]) => name)
		.sort(compareText);
	const packageExports = Object.keys(packageJson.exports).sort(compareText);
	const runtimeFacts: CapabilityManifest["runtimeFacts"] = {
		session: {
			currentFormatVersion: RUNTIME_CAPABILITY_FACTS.session.currentFormatVersion,
			supportedFormatVersions: [...RUNTIME_CAPABILITY_FACTS.session.supportedFormatVersions],
			recordTypes: [...RUNTIME_CAPABILITY_FACTS.session.recordTypes],
		},
		tools: { builtIn: [...RUNTIME_CAPABILITY_FACTS.tools.builtIn] },
		commands: RUNTIME_CAPABILITY_FACTS.commands.map((command) => ({
			name: command.name,
			aliases: [...command.aliases],
			visible: command.visible,
			arguments: command.arguments,
		})),
		modelApiProtocols: [...RUNTIME_CAPABILITY_FACTS.modelApiProtocols],
		aiTypeOnlyExports,
		codingAgentPackage: { private: packageJson.private, exports: packageExports },
	};
	const capabilities = CODA_CAPABILITY_CONTRACT.map((entry) => enrichCapability(entry, runtimeFacts)).sort(
		(left, right) =>
			CAPABILITY_STATUSES.indexOf(left.status) - CAPABILITY_STATUSES.indexOf(right.status) ||
			compareText(left.id, right.id),
	);
	const manifest: CapabilityManifest = {
		schema: "coda-capabilities-v1",
		version: CAPABILITY_MANIFEST_VERSION,
		profile: "coda-current-runtime",
		generatedBy: "npm run capabilities:update",
		statusDefinitions: STATUS_DEFINITIONS,
		sources: [
			"packages/ai/compatibility/manifest.v1.json",
			"packages/coding-agent/package.json",
			"packages/coding-agent/src/commands/core-commands.ts",
			"packages/coding-agent/src/providers/types.ts",
			"packages/coding-agent/src/runtime/capability-contract.ts",
			"packages/coding-agent/src/session/records.ts",
			"packages/coding-agent/src/tools/contracts.ts",
			"packages/coding-agent/src/tools/mutation-contract.ts",
		],
		runtimeFacts,
		capabilities,
	};
	const issues = validateCapabilityManifest(manifest);
	if (issues.length > 0) throw new Error(`Generated capability manifest is invalid:\n- ${issues.join("\n- ")}`);
	const generatedReadme = replaceGeneratedBlock(
		replaceGeneratedBlock(readmeText, CORE_COMMANDS_MARKERS, renderCoreCommands(manifest)),
		CAPABILITIES_MARKERS,
		renderCapabilities(manifest),
	);
	return {
		manifest,
		manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
		readmeText: generatedReadme,
	};
}

export async function writeCapabilityArtifacts(repositoryRoot = DEFAULT_REPOSITORY_ROOT): Promise<void> {
	const artifacts = await generateCapabilityArtifacts(repositoryRoot);
	await Promise.all([
		writeFile(resolve(repositoryRoot, MANIFEST_PATH), artifacts.manifestText, "utf8"),
		writeFile(resolve(repositoryRoot, README_PATH), artifacts.readmeText, "utf8"),
	]);
}

export async function checkCapabilityArtifacts(repositoryRoot = DEFAULT_REPOSITORY_ROOT): Promise<readonly string[]> {
	const artifacts = await generateCapabilityArtifacts(repositoryRoot);
	const mismatches: string[] = [];
	let committedManifest: string | undefined;
	try {
		committedManifest = await readFile(resolve(repositoryRoot, MANIFEST_PATH), "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	if (committedManifest !== artifacts.manifestText) mismatches.push(MANIFEST_PATH);
	const committedReadme = await readFile(resolve(repositoryRoot, README_PATH), "utf8");
	if (committedReadme !== artifacts.readmeText) mismatches.push(README_PATH);
	return mismatches;
}

export function validateCapabilityManifest(value: unknown): readonly string[] {
	const issues: string[] = [];
	if (!isRecord(value)) return ["manifest must be an object"];
	checkExactKeys(
		value,
		["schema", "version", "profile", "generatedBy", "statusDefinitions", "sources", "runtimeFacts", "capabilities"],
		"manifest",
		issues,
	);
	if (value.schema !== "coda-capabilities-v1") issues.push("schema must be coda-capabilities-v1");
	if (value.version !== 1) issues.push("version must be 1");
	if (value.profile !== "coda-current-runtime") issues.push("profile must be coda-current-runtime");
	if (value.generatedBy !== "npm run capabilities:update") issues.push("generatedBy must name the update command");
	validateStatusDefinitions(value.statusDefinitions, issues);
	validateSortedStrings(value.sources, "sources", issues);
	validateRuntimeFacts(value.runtimeFacts, issues);
	validateCapabilityEntries(value.capabilities, issues);
	return issues;
}

export function replaceGeneratedBlock(
	text: string,
	markers: { readonly start: string; readonly end: string },
	content: string,
): string {
	const start = text.indexOf(markers.start);
	const nextStart = text.indexOf(markers.start, start + markers.start.length);
	const end = text.indexOf(markers.end, start + markers.start.length);
	const nextEnd = text.indexOf(markers.end, end + markers.end.length);
	if (start < 0 || end < 0 || nextStart >= 0 || nextEnd >= 0 || end < start) {
		throw new Error(`Expected exactly one ordered ${markers.start} / ${markers.end} marker pair`);
	}
	return `${text.slice(0, start)}${markers.start}\n${content.trim()}\n${markers.end}${text.slice(end + markers.end.length)}`;
}

function enrichCapability(
	entry: CapabilityContractEntry,
	facts: CapabilityManifest["runtimeFacts"],
): CapabilityManifestEntry {
	const base = {
		...entry,
		sources: [...entry.sources].sort(compareText),
		tests: [...entry.tests].sort(compareText),
	};
	switch (entry.id) {
		case "ai.model-access":
			return { ...base, details: { apiProtocols: facts.modelApiProtocols } };
		case "ai.selected-type-closure":
			return { ...base, details: { exports: facts.aiTypeOnlyExports } };
		case "coding-agent.application-interface":
			return {
				...base,
				details: {
					packagePrivate: facts.codingAgentPackage.private,
					exportedSubpaths: facts.codingAgentPackage.exports,
				},
			};
		case "coding-agent.built-in-tools":
			return { ...base, details: { names: facts.tools.builtIn } };
		case "coding-agent.context-compaction":
			return {
				...base,
				details: {
					command: facts.commands.some((command) => command.name === "compact") ? "/compact" : null,
					durableRecordType: facts.session.recordTypes.includes("context_compacted") ? "context_compacted" : null,
				},
			};
		case "coding-agent.sessions":
			return {
				...base,
				details: {
					currentFormatVersion: facts.session.currentFormatVersion,
					supportedFormatVersions: facts.session.supportedFormatVersions,
				},
			};
		default:
			return base;
	}
}

function renderCoreCommands(manifest: CapabilityManifest): string {
	const visible = manifest.runtimeFacts.commands
		.filter((command) => command.visible)
		.map((command) => `\`/${command.name}\``);
	const hidden = manifest.runtimeFacts.commands.flatMap((command) => [
		...command.aliases.map((alias) => `\`/${alias}\` (alias of \`/${command.name}\`)`),
		...(command.visible ? [] : [`\`/${command.name}\``]),
	]);
	return [
		`Visible core commands are ${joinReadable(visible)}.`,
		hidden.length > 0 ? `Hidden compatibility or management names are ${joinReadable(hidden)}.` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

function renderCapabilities(manifest: CapabilityManifest): string {
	const lines = [
		"This status block is generated from executable runtime contracts. See the",
		"[versioned manifest](../../capabilities.v1.json) for exact facts, sources, and tests.",
	];
	for (const status of CAPABILITY_STATUSES) {
		lines.push("", `### ${STATUS_HEADINGS[status]}`, "");
		for (const entry of manifest.capabilities.filter((candidate) => candidate.status === status)) {
			lines.push(`- **${entry.title}** (${entry.package}) — ${entry.summary}${readmeDetail(entry)}`);
		}
	}
	return lines.join("\n");
}

function readmeDetail(entry: CapabilityManifestEntry): string {
	if (entry.id === "coding-agent.built-in-tools") {
		const names = detailStrings(entry, "names").map((name) => `\`${name}\``);
		return ` Built-ins: ${joinReadable(names)}.`;
	}
	if (entry.id === "coding-agent.sessions") {
		return ` Current Session format: v${detailNumber(entry, "currentFormatVersion")}.`;
	}
	if (entry.id === "ai.model-access") {
		const protocols = detailStrings(entry, "apiProtocols").map((name) => `\`${name}\``);
		return ` Custom Provider protocols: ${joinReadable(protocols)}.`;
	}
	if (entry.id === "ai.selected-type-closure") {
		return ` The manifest accounts for ${detailStrings(entry, "exports").length} exact type-only exports.`;
	}
	return "";
}

function validateStatusDefinitions(value: unknown, issues: string[]): void {
	if (!isRecord(value)) {
		issues.push("statusDefinitions must be an object");
		return;
	}
	checkExactKeys(value, CAPABILITY_STATUSES, "statusDefinitions", issues);
	for (const status of CAPABILITY_STATUSES) {
		if (!isNonEmptyString(value[status])) issues.push(`statusDefinitions.${status} must be a non-empty string`);
	}
}

function validateRuntimeFacts(value: unknown, issues: string[]): void {
	if (!isRecord(value)) {
		issues.push("runtimeFacts must be an object");
		return;
	}
	checkExactKeys(
		value,
		["session", "tools", "commands", "modelApiProtocols", "aiTypeOnlyExports", "codingAgentPackage"],
		"runtimeFacts",
		issues,
	);
	if (!isRecord(value.session)) issues.push("runtimeFacts.session must be an object");
	else {
		checkExactKeys(
			value.session,
			["currentFormatVersion", "supportedFormatVersions", "recordTypes"],
			"runtimeFacts.session",
			issues,
		);
		if (!Number.isSafeInteger(value.session.currentFormatVersion)) {
			issues.push("runtimeFacts.session.currentFormatVersion must be an integer");
		}
		if (!isUniqueNumberArray(value.session.supportedFormatVersions)) {
			issues.push("runtimeFacts.session.supportedFormatVersions must contain unique integers");
		} else if (!value.session.supportedFormatVersions.includes(value.session.currentFormatVersion as number)) {
			issues.push("current Session format must be included in supported formats");
		}
		validateUniqueStrings(value.session.recordTypes, "runtimeFacts.session.recordTypes", issues);
	}
	if (!isRecord(value.tools)) issues.push("runtimeFacts.tools must be an object");
	else {
		checkExactKeys(value.tools, ["builtIn"], "runtimeFacts.tools", issues);
		validateUniqueStrings(value.tools.builtIn, "runtimeFacts.tools.builtIn", issues);
		if (Array.isArray(value.tools.builtIn) && !value.tools.builtIn.includes("read_tool_output")) {
			issues.push("built-in Tools must include read_tool_output");
		}
	}
	if (!Array.isArray(value.commands)) issues.push("runtimeFacts.commands must be an array");
	else {
		const names = new Set<string>();
		for (const [index, command] of value.commands.entries()) {
			if (!isRecord(command)) {
				issues.push(`runtimeFacts.commands[${index}] must be an object`);
				continue;
			}
			checkExactKeys(
				command,
				["name", "aliases", "visible", "arguments"],
				`runtimeFacts.commands[${index}]`,
				issues,
			);
			if (!isNonEmptyString(command.name)) issues.push(`runtimeFacts.commands[${index}].name must be non-empty`);
			else if (names.has(command.name)) issues.push(`runtimeFacts.commands repeats ${command.name}`);
			else names.add(command.name);
			validateUniqueStrings(command.aliases, `runtimeFacts.commands[${index}].aliases`, issues);
			if (typeof command.visible !== "boolean")
				issues.push(`runtimeFacts.commands[${index}].visible must be boolean`);
			if (command.arguments !== "none" && command.arguments !== "tail") {
				issues.push(`runtimeFacts.commands[${index}].arguments must be none or tail`);
			}
		}
		if (!names.has("compact")) issues.push("core commands must include compact");
	}
	validateUniqueStrings(value.modelApiProtocols, "runtimeFacts.modelApiProtocols", issues);
	validateSortedStrings(value.aiTypeOnlyExports, "runtimeFacts.aiTypeOnlyExports", issues);
	if (!isRecord(value.codingAgentPackage)) issues.push("runtimeFacts.codingAgentPackage must be an object");
	else {
		checkExactKeys(value.codingAgentPackage, ["private", "exports"], "runtimeFacts.codingAgentPackage", issues);
		if (value.codingAgentPackage.private !== true) issues.push("Coding Agent package must remain private");
		validateSortedStrings(value.codingAgentPackage.exports, "runtimeFacts.codingAgentPackage.exports", issues);
	}
}

function validateCapabilityEntries(value: unknown, issues: string[]): void {
	if (!Array.isArray(value)) {
		issues.push("capabilities must be an array");
		return;
	}
	const ids = new Set<string>();
	const statuses = new Set<CapabilityStatus>();
	let previous: { readonly status: CapabilityStatus; readonly id: string } | undefined;
	for (const [index, entry] of value.entries()) {
		const label = `capabilities[${index}]`;
		if (!isRecord(entry)) {
			issues.push(`${label} must be an object`);
			continue;
		}
		checkAllowedKeys(
			entry,
			["id", "package", "status", "title", "summary", "sources", "tests", "details"],
			label,
			issues,
		);
		for (const required of ["id", "package", "status", "title", "summary", "sources", "tests"] as const) {
			if (!(required in entry)) issues.push(`${label} is missing ${required}`);
		}
		if (!isNonEmptyString(entry.id) || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(entry.id)) {
			issues.push(`${label}.id must be a dotted stable identifier`);
		} else if (ids.has(entry.id)) issues.push(`capability id is repeated: ${entry.id}`);
		else ids.add(entry.id);
		if (!isNonEmptyString(entry.package)) issues.push(`${label}.package must be non-empty`);
		if (!isCapabilityStatus(entry.status)) issues.push(`${label}.status is invalid`);
		else {
			statuses.add(entry.status);
			if (previous && compareCapabilityOrder(previous, { status: entry.status, id: String(entry.id) }) > 0) {
				issues.push("capabilities must be sorted by status and id");
			}
			previous = { status: entry.status, id: String(entry.id) };
		}
		if (!isNonEmptyString(entry.title)) issues.push(`${label}.title must be non-empty`);
		if (!isNonEmptyString(entry.summary)) issues.push(`${label}.summary must be non-empty`);
		validateSortedStrings(entry.sources, `${label}.sources`, issues, true);
		validateSortedStrings(entry.tests, `${label}.tests`, issues, true);
		if (entry.details !== undefined && (!isRecord(entry.details) || !isJsonValue(entry.details))) {
			issues.push(`${label}.details must contain only JSON values`);
		}
	}
	for (const status of CAPABILITY_STATUSES) {
		if (!statuses.has(status)) issues.push(`capabilities must include the ${status} status`);
	}
	const compaction = value.find((entry) => isRecord(entry) && entry.id === "coding-agent.context-compaction");
	if (!isRecord(compaction) || compaction.status !== "runtime-supported") {
		issues.push("Durable Context Compaction must be runtime-supported");
	}
	if (
		value.some(
			(entry) =>
				isRecord(entry) &&
				entry.status === "deferred" &&
				(typeof entry.id === "string" ? entry.id : "").includes("compaction"),
		)
	) {
		issues.push("Context Compaction cannot also be classified as deferred");
	}
}

function validateSortedStrings(value: unknown, label: string, issues: string[], nonEmpty = false): void {
	if (!validateUniqueStrings(value, label, issues, nonEmpty)) return;
	const strings = value as string[];
	if (strings.some((entry, index) => index > 0 && compareText(strings[index - 1]!, entry) > 0)) {
		issues.push(`${label} must be sorted`);
	}
}

function validateUniqueStrings(value: unknown, label: string, issues: string[], nonEmpty = false): value is string[] {
	if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
		issues.push(`${label} must contain non-empty strings`);
		return false;
	}
	if (nonEmpty && value.length === 0) issues.push(`${label} must not be empty`);
	if (new Set(value).size !== value.length) issues.push(`${label} must not contain duplicates`);
	return true;
}

function checkExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
	issues: string[],
): void {
	const actual = Object.keys(value).sort(compareText);
	const wanted = [...expected].sort(compareText);
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) issues.push(`${label} has unexpected or missing keys`);
}

function checkAllowedKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
	issues: string[],
): void {
	const allowedSet = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedSet.has(key))) issues.push(`${label} has unexpected keys`);
}

function detailStrings(entry: CapabilityManifestEntry, key: string): readonly string[] {
	const value = entry.details?.[key];
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function detailNumber(entry: CapabilityManifestEntry, key: string): number {
	const value = entry.details?.[key];
	if (typeof value !== "number") throw new Error(`Capability ${entry.id} is missing numeric detail ${key}`);
	return value;
}

function joinReadable(items: readonly string[]): string {
	if (items.length === 0) return "none";
	if (items.length === 1) return items[0]!;
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function compareCapabilityOrder(
	left: { readonly status: CapabilityStatus; readonly id: string },
	right: { readonly status: CapabilityStatus; readonly id: string },
): number {
	return (
		CAPABILITY_STATUSES.indexOf(left.status) - CAPABILITY_STATUSES.indexOf(right.status) ||
		compareText(left.id, right.id)
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isCapabilityStatus(value: unknown): value is CapabilityStatus {
	return typeof value === "string" && (CAPABILITY_STATUSES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueNumberArray(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => Number.isSafeInteger(entry)) &&
		new Set(value).size === value.length
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseJson<T>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`${label} is invalid JSON`, { cause: error });
	}
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
