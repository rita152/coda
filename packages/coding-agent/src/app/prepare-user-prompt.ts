import type { AgentInput } from "@coda/agent";
import type { ImageContent } from "@coda/ai";
import type { McpToolDescriptor } from "@coda/mcp";
import type { SkillId } from "@coda/skills";
import type { CodingMcpRegistry } from "../mcp/registry.ts";
import { mcpRunCapabilitySelections } from "../mcp/run-capability.ts";
import type { MediaLibrary } from "../media/media-library.ts";
import type { ComposerExtensionReference } from "../session/composer-submission.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "../skills/context.ts";
import { codingSkillsSnapshotRevision, skillRunCapabilitySelections } from "../skills/run-capability.ts";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "../skills/types.ts";
import type { PreparedWorkInput } from "../ui/input-types.ts";
import { promptInput } from "./media-attachments.ts";
import { resolveRunMentions } from "./run-mentions.ts";
import { assertExtensionReferencesAvailable } from "./trust-gating.ts";

export interface PreparedUserPromptProjectCatalog {
	readonly skills: CodingSkillsSnapshot;
	readonly projectRevision: string;
	readonly mcpTools: readonly McpToolDescriptor[];
}

export type PrepareExplicitSkillMcpDependencies = (input: {
	readonly selectedSkills: readonly ResolvedCodingSkill[];
	readonly signal: AbortSignal;
}) => Promise<PreparedUserPromptProjectCatalog>;

export interface PrepareUserPromptOptions {
	readonly text: string;
	readonly composerText?: string;
	readonly references?: readonly ComposerExtensionReference[];
	readonly attachmentIds: readonly string[];
	readonly mediaLibrary: MediaLibrary;
	readonly restoredContents?: ReadonlyMap<string, ImageContent>;
	readonly skills: CodingSkillsSnapshot;
	/** Revision of the coherent Project catalog from which `skills` was read. */
	readonly projectRevision?: string;
	readonly mcpTools?: readonly McpToolDescriptor[];
	readonly mcpRegistry?: Pick<CodingMcpRegistry, "snapshot">;
	/**
	 * Session-owned consent hook for MCP dependencies declared by explicitly
	 * selected Skills. A successful install returns the newly published coherent
	 * Project catalog; activation must never reuse the pre-install snapshot.
	 */
	readonly prepareSkillMcpDependencies?: PrepareExplicitSkillMcpDependencies;
	readonly signal?: AbortSignal;
}

/** Activates `$` Skill context and captures mentioned MCP Tools for this exact Run. */
export async function prepareUserPrompt(options: PrepareUserPromptOptions): Promise<PreparedWorkInput> {
	const composerText = options.composerText ?? options.text;
	const references = options.references ?? [];
	let skills = options.skills;
	let projectRevision = options.projectRevision;
	let mcpTools = options.mcpTools ?? options.mcpRegistry?.snapshot().tools ?? [];
	assertExtensionReferencesAvailable(skills, mcpTools, references);
	let resolved = resolveRunMentions({
		composerText,
		references,
		skills,
		mcpTools,
	});
	if (resolved.skillReferences.length > 0 && options.prepareSkillMcpDependencies) {
		const selectedSkills = Object.freeze(
			resolved.skillReferences.map((reference) => {
				const selected = skills.byId.get(reference.commandId as SkillId);
				if (!selected) throw new Error(`Selected Skill is no longer available: ${reference.name}`);
				return selected;
			}),
		);
		const refreshed = await options.prepareSkillMcpDependencies({
			selectedSkills,
			signal: options.signal ?? new AbortController().signal,
		});
		skills = refreshed.skills;
		projectRevision = refreshed.projectRevision;
		mcpTools = refreshed.mcpTools;
		assertExtensionReferencesAvailable(skills, mcpTools, references);
		resolved = resolveRunMentions({ composerText, references, skills, mcpTools });
	}
	const taskText =
		resolved.skillReferences.length > 0
			? (sharedSkillArguments(composerText, resolved.skillReferences) ?? "")
			: options.text;
	const prepared = await promptInput(
		taskText,
		options.attachmentIds,
		options.mediaLibrary,
		options.restoredContents ?? new Map(),
	);
	let input: AgentInput = prepared;
	let skillSelections = {};
	if (resolved.skillReferences.length > 0) {
		const selectedProjectRevision = projectRevision ?? `skills:${codingSkillsSnapshotRevision(skills)}`;
		const activations = await activateExplicitSkillReferences({
			snapshot: skills,
			references: resolved.skillReferences,
			composerText,
			...(options.signal ? { signal: options.signal } : {}),
		});
		input = prependSkillContext(
			prepared,
			renderExplicitSkillContext(activations),
			renderExplicitSkillReferences(activations),
		);
		skillSelections = skillRunCapabilitySelections(selectedProjectRevision, activations);
	}
	return Object.freeze({
		input,
		capabilitySelections: Object.freeze({
			...mcpRunCapabilitySelections(resolved.mcpToolIds),
			...skillSelections,
		}),
	});
}
