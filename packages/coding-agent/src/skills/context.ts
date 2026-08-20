import type { AgentInput } from "@coda/agent";
import type { ImageContent, SkillReferenceContent, TextContent } from "@coda/ai";
import type { SkillActivation, SkillId } from "@coda/skills";
import type { CodingSkillOrigin, CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

export interface SkillComposerReference {
	readonly id?: string;
	readonly commandId: string;
	readonly source: "skill" | "mcp";
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

const LEGACY_USER_SELECTED_SKILL_CONTEXT_PATTERN =
	/BEGIN USER-SELECTED SKILL CONTEXT[\s\S]*?END USER-SELECTED SKILL CONTEXT(?:\r?\n)*/gu;
const USER_SELECTED_SKILL_CONTEXT_PATTERN =
	/<skill>\r?\n<name>[^\r\n]*<\/name>\r?\n<path>[^\r\n]*<\/path>\r?\n[\s\S]*?<\/skill>(?:\r?\n)*/gu;
const MAX_SKILL_PROMPT_BYTES = 8_000;
const UTF8_ENCODER = new TextEncoder();

function modelVisibleName(resolved: ResolvedCodingSkill): string {
	if (resolved.origin.kind === "plugin") return resolved.qualifiedName;
	return resolved.winner ? resolved.candidate.metadata.name : resolved.qualifiedName;
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (UTF8_ENCODER.encode(value).byteLength <= maximumBytes) return value;
	const characters: string[] = [];
	let bytes = 0;
	for (const character of value) {
		const nextBytes = UTF8_ENCODER.encode(character).byteLength;
		if (bytes + nextBytes > maximumBytes) break;
		characters.push(character);
		bytes += nextBytes;
	}
	return characters.join("");
}

function skillFragment(activation: SkillActivation<CodingSkillOrigin>, resolved: ResolvedCodingSkill): string {
	return [
		"<skill>",
		`<name>${modelVisibleName(resolved)}</name>`,
		`<path>${activation.candidate.skillFile}</path>`,
		truncateUtf8(activation.contents, MAX_SKILL_PROMPT_BYTES),
		"</skill>",
	].join("\n");
}

export function renderExplicitSkillContext(
	entries: readonly {
		readonly activation: SkillActivation<CodingSkillOrigin>;
		readonly resolved: ResolvedCodingSkill;
	}[],
	_snapshotBinding?: string,
): string {
	if (entries.length === 0) return "";
	return `${entries.map(({ activation, resolved }) => skillFragment(activation, resolved)).join("\n")}\n`;
}

/** Projects activated Skills into the user-message reference blocks shown by the Composer. */
export function renderExplicitSkillReferences(
	entries: readonly {
		readonly activation: SkillActivation<CodingSkillOrigin>;
		readonly resolved: ResolvedCodingSkill;
	}[],
): readonly SkillReferenceContent[] {
	return Object.freeze(
		entries.map(({ activation, resolved }) =>
			Object.freeze({
				type: "skill" as const,
				name: modelVisibleName(resolved),
				path: activation.candidate.skillFile,
			}),
		),
	);
}

export function renderModelSkillResult(
	activation: SkillActivation<CodingSkillOrigin>,
	resolved: ResolvedCodingSkill,
): string {
	return skillFragment(activation, resolved);
}

/** Removes the internal explicit-Skill envelope from user-facing text without changing the Agent input. */
export function stripUserSelectedSkillContext(text: string): string {
	return text.replace(LEGACY_USER_SELECTED_SKILL_CONTEXT_PATTERN, "").replace(USER_SELECTED_SKILL_CONTEXT_PATTERN, "");
}

/** Renders the user-facing projection of text, images, and direct Skill references. */
export function renderVisibleUserText(
	content: string | readonly (TextContent | ImageContent | SkillReferenceContent)[],
): string {
	if (typeof content === "string") return stripUserSelectedSkillContext(content);
	return content
		.map((block) =>
			block.type === "skill"
				? `$${block.name} `
				: block.type === "text"
					? stripUserSelectedSkillContext(block.text)
					: "",
		)
		.join("")
		.trimEnd();
}

/** Removes only structured Skill tokens; plain text that merely looks like a command is retained. */
export function sharedSkillArguments(
	composerText: string,
	references: readonly SkillComposerReference[],
): string | undefined {
	const skillReferences = references
		.filter(({ source }) => source === "skill")
		.sort((left, right) => left.start - right.start || left.end - right.end);
	let previousEnd = 0;
	for (const reference of skillReferences) {
		const token = composerText.slice(reference.start, reference.end);
		if (
			!Number.isSafeInteger(reference.start) ||
			!Number.isSafeInteger(reference.end) ||
			reference.start < previousEnd ||
			reference.start < 0 ||
			reference.start >= reference.end ||
			reference.end > composerText.length ||
			(token !== `/${reference.name}` && token !== `$${reference.name}`)
		) {
			throw new Error("Skill reference range does not identify an ordered Composer token");
		}
		previousEnd = reference.end;
	}
	let value = composerText;
	for (const reference of skillReferences.reverse()) {
		value = `${value.slice(0, reference.start)} ${value.slice(reference.end)}`;
	}
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized || undefined;
}

export async function activateExplicitSkillReferences(options: {
	readonly snapshot: CodingSkillsSnapshot;
	readonly references: readonly SkillComposerReference[];
	readonly composerText: string;
	readonly signal?: AbortSignal;
}): Promise<
	readonly {
		readonly activation: SkillActivation<CodingSkillOrigin>;
		readonly resolved: ResolvedCodingSkill;
	}[]
> {
	const arguments_ = sharedSkillArguments(options.composerText, options.references);
	const activations = [];
	for (const reference of options.references) {
		if (reference.source !== "skill") continue;
		const resolved = options.snapshot.byId.get(reference.commandId as SkillId);
		if (!resolved) {
			throw new Error(`Selected Skill is no longer available: ${reference.name}`);
		}
		const activation = await options.snapshot.activate(resolved.candidate.id, {
			...(arguments_ ? { arguments: arguments_ } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		activations.push(Object.freeze({ activation, resolved }));
	}
	return Object.freeze(activations);
}

export function prependSkillContext(
	input: AgentInput,
	context: string,
	references: readonly SkillReferenceContent[] = [],
): AgentInput {
	if (!context && references.length === 0) return input;
	const inputBlocks = typeof input === "string" ? (input ? [{ type: "text" as const, text: input }] : []) : [...input];
	return [...references, ...(context ? [{ type: "text" as const, text: context }] : []), ...inputBlocks];
}
