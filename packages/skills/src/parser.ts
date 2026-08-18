import { parseDocument } from "yaml";
import type {
	AgentSkillMetadata,
	AgentSkillValidationInput,
	AgentSkillValidationResult,
	ParsedAgentSkill,
	SkillDiagnostic,
	SkillDiagnosticCode,
	SkillParseInput,
	SkillParseResult,
} from "./types.ts";
import { DEFAULT_SKILL_LIMITS } from "./types.ts";

const STANDARD_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const REPAIRABLE_SCALAR_FIELDS = new Set(["name", "description", "license", "compatibility", "allowed-tools"]);
const AGENT_SKILL_NAME = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const MAXIMUM_YAML_DEPTH = 64;

interface FrontmatterParts {
	readonly source: string;
	readonly body: string;
	readonly hadBom: boolean;
}

interface ParsedMapping {
	readonly value: Readonly<Record<string, unknown>>;
	readonly repaired: boolean;
}

type MutableDiagnostic = SkillDiagnostic & { readonly path?: string };

function diagnostic(
	code: SkillDiagnosticCode,
	severity: SkillDiagnostic["severity"],
	phase: SkillDiagnostic["phase"],
	message: string,
	options: { readonly path?: string; readonly field?: string; readonly recovered?: boolean } = {},
): MutableDiagnostic {
	return Object.freeze({ code, severity, phase, message, ...options });
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function positiveLimit(value: number | undefined, fallback: number, name: string, maximum?: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0 || (maximum !== undefined && resolved > maximum)) {
		throw new TypeError(`${name} must be a positive safe integer${maximum ? ` no greater than ${maximum}` : ""}`);
	}
	return resolved;
}

function validateInputLimits(input: SkillParseInput): void {
	positiveLimit(input.maxFrontmatterBytes, DEFAULT_SKILL_LIMITS.maxFrontmatterBytes, "maxFrontmatterBytes");
	positiveLimit(input.maxYamlDepth, DEFAULT_SKILL_LIMITS.maxYamlDepth, "maxYamlDepth", MAXIMUM_YAML_DEPTH);
}

function characterLength(value: string): number {
	return Array.from(value).length;
}

function normalizedSkillName(value: string): string {
	return value.normalize("NFKC").trim();
}

function validSkillName(value: string): boolean {
	const normalized = normalizedSkillName(value);
	return (
		characterLength(normalized) >= 1 &&
		characterLength(normalized) <= 64 &&
		normalized === normalized.toLowerCase() &&
		AGENT_SKILL_NAME.test(normalized)
	);
}

function matchesDirectoryName(name: string, directoryName: string): boolean {
	return normalizedSkillName(name) === directoryName.normalize("NFKC");
}

function lineEnd(text: string, start: number): { readonly contentEnd: number; readonly next: number } {
	const newline = text.indexOf("\n", start);
	if (newline < 0) {
		return {
			contentEnd: text.endsWith("\r") ? text.length - 1 : text.length,
			next: text.length,
		};
	}
	return {
		contentEnd: newline > start && text[newline - 1] === "\r" ? newline - 1 : newline,
		next: newline + 1,
	};
}

function splitFrontmatter(input: SkillParseInput, diagnostics: MutableDiagnostic[]): FrontmatterParts | undefined {
	let text = input.text;
	let hadBom = false;
	if (text.startsWith("\uFEFF")) {
		hadBom = true;
		text = text.slice(1);
		diagnostics.push(
			diagnostic("invalid-field", "warning", "parse", "Removed a UTF-8 byte-order mark before frontmatter", {
				path: input.path,
				recovered: true,
			}),
		);
	}
	if (text.includes("\0")) {
		diagnostics.push(diagnostic("nul-byte", "error", "parse", "SKILL.md contains a NUL byte", { path: input.path }));
		return undefined;
	}
	const first = lineEnd(text, 0);
	if (text.slice(0, first.contentEnd) !== "---") {
		diagnostics.push(
			diagnostic("frontmatter-missing", "error", "parse", "SKILL.md must begin with a --- frontmatter line", {
				path: input.path,
			}),
		);
		return undefined;
	}
	let cursor = first.next;
	while (cursor < text.length) {
		const line = lineEnd(text, cursor);
		if (text.slice(cursor, line.contentEnd) === "---") {
			const source = text.slice(first.next, cursor);
			const maxFrontmatterBytes = positiveLimit(
				input.maxFrontmatterBytes,
				DEFAULT_SKILL_LIMITS.maxFrontmatterBytes,
				"maxFrontmatterBytes",
			);
			if (byteLength(source) > maxFrontmatterBytes) {
				diagnostics.push(
					diagnostic(
						"frontmatter-too-large",
						"error",
						"parse",
						`Frontmatter exceeds the ${maxFrontmatterBytes}-byte limit`,
						{ path: input.path },
					),
				);
				return undefined;
			}
			return Object.freeze({ source, body: text.slice(line.next), hadBom });
		}
		cursor = line.next;
	}
	diagnostics.push(
		diagnostic("frontmatter-unterminated", "error", "parse", "SKILL.md frontmatter has no closing --- line", {
			path: input.path,
		}),
	);
	return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeValue(value: unknown, depth = 0): unknown {
	if (depth > 64) throw new Error("YAML value is too deeply nested");
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return Object.freeze(value.map((entry) => safeValue(entry, depth + 1)));
	if (!isRecord(value)) return String(value);
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			value: safeValue(entry, depth + 1),
			enumerable: true,
			configurable: false,
			writable: false,
		});
	}
	return Object.freeze(result);
}

function valueDepth(value: unknown, depth = 0): number {
	if (value === null || typeof value !== "object") return depth;
	if (Array.isArray(value)) {
		return value.reduce((maximum, entry) => Math.max(maximum, valueDepth(entry, depth + 1)), depth + 1);
	}
	return Object.values(value).reduce((maximum, entry) => Math.max(maximum, valueDepth(entry, depth + 1)), depth + 1);
}

function parseMappingOnce(source: string, maxYamlDepth: number): Readonly<Record<string, unknown>> {
	const document = parseDocument(source, {
		schema: "core",
		strict: true,
		uniqueKeys: true,
	});
	const issues = [...document.errors, ...document.warnings];
	if (issues.length > 0) throw new Error(issues.map((error) => error.message).join("; "));
	const value: unknown = document.toJS({ maxAliasCount: 0 });
	if (!isRecord(value)) throw new TypeError("frontmatter-not-mapping");
	if (valueDepth(value) > maxYamlDepth) throw new RangeError("yaml-depth-exceeded");
	return safeValue(value) as Readonly<Record<string, unknown>>;
}

function repairUnquotedColons(source: string): string {
	let changed = false;
	const repaired = source
		.split(/\r?\n/u)
		.map((line) => {
			const match = /^([a-z][a-z0-9-]*):[ \t]+(.+)$/u.exec(line);
			if (!match) return line;
			const field = match[1]!;
			const value = match[2]!.trim();
			if (!REPAIRABLE_SCALAR_FIELDS.has(field) || !/:\s/u.test(value) || /^(?:["'[{]|[>|&*!])/u.test(value)) {
				return line;
			}
			changed = true;
			return `${field}: ${JSON.stringify(value)}`;
		})
		.join("\n");
	return changed ? repaired : source;
}

function parseMapping(
	parts: FrontmatterParts,
	input: SkillParseInput,
	diagnostics: MutableDiagnostic[],
	allowRepair: boolean,
): ParsedMapping | undefined {
	const maxYamlDepth = positiveLimit(
		input.maxYamlDepth,
		DEFAULT_SKILL_LIMITS.maxYamlDepth,
		"maxYamlDepth",
		MAXIMUM_YAML_DEPTH,
	);
	try {
		return Object.freeze({ value: parseMappingOnce(parts.source, maxYamlDepth), repaired: false });
	} catch (initialError) {
		if (allowRepair) {
			const repaired = repairUnquotedColons(parts.source);
			if (repaired !== parts.source) {
				try {
					const value = parseMappingOnce(repaired, maxYamlDepth);
					diagnostics.push(
						diagnostic(
							"frontmatter-repaired-unquoted-colon",
							"warning",
							"parse",
							"Repaired an unquoted colon in a known scalar frontmatter field",
							{ path: input.path, recovered: true },
						),
					);
					return Object.freeze({ value, repaired: true });
				} catch {
					// The original diagnostic below is more useful and stable than a repair-specific parser error.
				}
			}
		}
		const message = initialError instanceof Error ? initialError.message : String(initialError);
		const code: SkillDiagnosticCode =
			message === "frontmatter-not-mapping"
				? "frontmatter-not-mapping"
				: message === "yaml-depth-exceeded"
					? "yaml-depth-exceeded"
					: "frontmatter-invalid";
		diagnostics.push(
			diagnostic(code, "error", "parse", `Could not parse SKILL.md frontmatter: ${message}`, { path: input.path }),
		);
		return undefined;
	}
}

function optionalString(
	record: Readonly<Record<string, unknown>>,
	field: string,
	diagnostics: MutableDiagnostic[],
	path: string | undefined,
	strict: boolean,
): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	diagnostics.push(
		diagnostic(
			"invalid-field",
			strict ? "error" : "warning",
			strict ? "validate" : "parse",
			`${field} must be a string`,
			{
				path,
				field,
			},
		),
	);
	return undefined;
}

function optionalBoolean(
	record: Readonly<Record<string, unknown>>,
	field: string,
	diagnostics: MutableDiagnostic[],
	path: string | undefined,
	strict: boolean,
): boolean | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(
		diagnostic(
			"invalid-field",
			strict ? "error" : "warning",
			strict ? "validate" : "parse",
			`${field} must be a boolean`,
			{
				path,
				field,
			},
		),
	);
	return undefined;
}

function metadataField(
	record: Readonly<Record<string, unknown>>,
	diagnostics: MutableDiagnostic[],
	path: string | undefined,
	strict: boolean,
): Readonly<Record<string, string>> {
	const value = record.metadata;
	if (value === undefined) return Object.freeze({});
	if (!isRecord(value)) {
		diagnostics.push(
			diagnostic(
				"invalid-metadata",
				strict ? "error" : "warning",
				strict ? "validate" : "parse",
				"metadata must be a mapping of string keys to string values",
				{ path, field: "metadata" },
			),
		);
		return Object.freeze({});
	}
	const result: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			Object.defineProperty(result, key, { value: entry, enumerable: true, writable: false, configurable: false });
			continue;
		}
		diagnostics.push(
			diagnostic(
				"invalid-metadata",
				strict ? "error" : "warning",
				strict ? "validate" : "parse",
				`metadata.${key} must be a string`,
				{ path, field: `metadata.${key}` },
			),
		);
	}
	return Object.freeze(result);
}

function strictFieldDiagnostics(
	record: Readonly<Record<string, unknown>>,
	directoryName: string,
	path: string | undefined,
): readonly MutableDiagnostic[] {
	const diagnostics: MutableDiagnostic[] = [];
	const name = record.name;
	if (typeof name !== "string" || normalizedSkillName(name).length === 0) {
		diagnostics.push(diagnostic("missing-name", "error", "validate", "name is required", { path, field: "name" }));
	} else {
		if (!validSkillName(name)) {
			diagnostics.push(
				diagnostic(
					"invalid-name",
					"error",
					"validate",
					"name must be 1-64 Unicode lowercase letters or numbers separated by single hyphens",
					{ path, field: "name" },
				),
			);
		}
		if (!matchesDirectoryName(name, directoryName)) {
			diagnostics.push(
				diagnostic("name-directory-mismatch", "error", "validate", "name must equal the parent directory name", {
					path,
					field: "name",
				}),
			);
		}
	}
	const description = record.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		diagnostics.push(
			diagnostic("missing-description", "error", "validate", "description is required and must be non-empty", {
				path,
				field: "description",
			}),
		);
	} else if (characterLength(description) > 1_024) {
		diagnostics.push(
			diagnostic("description-too-long", "error", "validate", "description must not exceed 1024 characters", {
				path,
				field: "description",
			}),
		);
	}
	optionalString(record, "license", diagnostics, path, true);
	const compatibility = optionalString(record, "compatibility", diagnostics, path, true);
	if (compatibility !== undefined && (characterLength(compatibility) === 0 || characterLength(compatibility) > 500)) {
		diagnostics.push(
			diagnostic(
				"compatibility-too-long",
				"error",
				"validate",
				"compatibility must contain 1-500 characters when present",
				{ path, field: "compatibility" },
			),
		);
	}
	optionalString(record, "allowed-tools", diagnostics, path, true);
	metadataField(record, diagnostics, path, true);
	for (const field of Object.keys(record)) {
		if (!STANDARD_FIELDS.has(field)) {
			diagnostics.push(
				diagnostic(
					"unknown-field",
					"error",
					"validate",
					`Non-standard frontmatter field is not allowed: ${field}`,
					{
						path,
						field,
					},
				),
			);
		}
	}
	return Object.freeze(diagnostics);
}

function compatibleSkill(
	record: Readonly<Record<string, unknown>>,
	parts: FrontmatterParts,
	input: SkillParseInput,
	diagnostics: MutableDiagnostic[],
): ParsedAgentSkill | undefined {
	let name: string;
	if (typeof record.name === "string" && record.name.trim().length > 0) {
		name = record.name.trim();
	} else {
		name = input.directoryName;
		diagnostics.push(
			diagnostic("missing-name", "warning", "parse", "Missing name; used the parent directory name", {
				path: input.path,
				field: "name",
				recovered: true,
			}),
		);
	}
	const descriptionValue = record.description;
	if (typeof descriptionValue !== "string" || descriptionValue.trim().length === 0) {
		diagnostics.push(
			diagnostic("missing-description", "error", "parse", "description is required and must be non-empty", {
				path: input.path,
				field: "description",
			}),
		);
		return undefined;
	}
	const description = descriptionValue.trim();
	if (!validSkillName(name)) {
		diagnostics.push(
			diagnostic(
				"invalid-name",
				"warning",
				"parse",
				"name is outside the Agent Skills Unicode lowercase-alphanumeric-and-hyphen grammar",
				{ path: input.path, field: "name" },
			),
		);
	}
	if (!matchesDirectoryName(name, input.directoryName)) {
		diagnostics.push(
			diagnostic("name-directory-mismatch", "warning", "parse", "name differs from the parent directory", {
				path: input.path,
				field: "name",
			}),
		);
	}
	if (characterLength(description) > 1_024) {
		diagnostics.push(
			diagnostic("description-too-long", "warning", "parse", "description exceeds 1024 characters", {
				path: input.path,
				field: "description",
			}),
		);
	}
	const license = optionalString(record, "license", diagnostics, input.path, false);
	const compatibility = optionalString(record, "compatibility", diagnostics, input.path, false);
	if (compatibility !== undefined && (characterLength(compatibility) === 0 || characterLength(compatibility) > 500)) {
		diagnostics.push(
			diagnostic(
				"compatibility-too-long",
				"warning",
				"parse",
				"compatibility is outside the 1-500 character standard bound",
				{ path: input.path, field: "compatibility" },
			),
		);
	}
	const allowedTools = optionalString(record, "allowed-tools", diagnostics, input.path, false);
	const disableModelInvocation = optionalBoolean(record, "disable-model-invocation", diagnostics, input.path, false);
	const userInvocable = optionalBoolean(record, "user-invocable", diagnostics, input.path, false);
	const metadata: AgentSkillMetadata = Object.freeze({
		name,
		description,
		...(license !== undefined ? { license } : {}),
		...(compatibility !== undefined ? { compatibility } : {}),
		metadata: metadataField(record, diagnostics, input.path, false),
		...(allowedTools !== undefined ? { allowedTools } : {}),
		...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
		...(userInvocable !== undefined ? { userInvocable } : {}),
	});
	for (const field of Object.keys(record)) {
		if (!STANDARD_FIELDS.has(field)) {
			diagnostics.push(
				diagnostic("unknown-field", "warning", "parse", `Ignored non-standard frontmatter field: ${field}`, {
					path: input.path,
					field,
				}),
			);
		}
	}
	const strict = strictFieldDiagnostics(record, input.directoryName, input.path);
	return Object.freeze({
		metadata,
		body: parts.body,
		frontmatter: parts.source,
		conformant: strict.every((entry) => entry.severity !== "error"),
	});
}

function parseCompatible(input: SkillParseInput, allowRepair: boolean): SkillParseResult {
	if (!input.directoryName) throw new TypeError("directoryName is required");
	validateInputLimits(input);
	const diagnostics: MutableDiagnostic[] = [];
	const parts = splitFrontmatter(input, diagnostics);
	if (!parts) return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
	const parsed = parseMapping(parts, input, diagnostics, allowRepair);
	if (!parsed) return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
	const skill = compatibleSkill(parsed.value, parts, input, diagnostics);
	const conformant = Boolean(skill?.conformant && !parsed.repaired);
	return Object.freeze({
		...(skill ? { skill: conformant === skill.conformant ? skill : Object.freeze({ ...skill, conformant }) } : {}),
		diagnostics: Object.freeze(diagnostics),
	});
}

export function parseAgentSkill(input: SkillParseInput): SkillParseResult {
	return parseCompatible(input, true);
}

export function validateAgentSkill(input: AgentSkillValidationInput): AgentSkillValidationResult {
	if (!input.directoryName) throw new TypeError("directoryName is required");
	validateInputLimits(input);
	const structural: MutableDiagnostic[] = [];
	const parseInput: SkillParseInput = input;
	const parts = splitFrontmatter(parseInput, structural);
	if (!parts) return Object.freeze({ valid: false, diagnostics: Object.freeze(structural) });
	const parsed = parseMapping(parts, parseInput, structural, false);
	if (!parsed) return Object.freeze({ valid: false, diagnostics: Object.freeze(structural) });
	const validation = strictFieldDiagnostics(parsed.value, input.directoryName, input.path);
	const diagnostics = Object.freeze([...structural, ...validation]);
	const valid = diagnostics.every((entry) => entry.severity !== "error");
	const compatibilityDiagnostics: MutableDiagnostic[] = [];
	const skill = compatibleSkill(parsed.value, parts, parseInput, compatibilityDiagnostics);
	return Object.freeze({
		valid,
		...(skill ? { skill: Object.freeze({ ...skill, conformant: valid }) } : {}),
		diagnostics,
	});
}
