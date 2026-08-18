import type { AgentInput } from "@coda/agent";
import type { ImageContent } from "@coda/ai";
import type { CodingMcpRegistry } from "../mcp/registry.ts";
import type { MediaLibrary } from "../media/media-library.ts";
import type { ComposerExtensionReference } from "../session/composer-submission.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "../skills/context.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import { promptInput } from "./media-attachments.ts";
import { resolveRunMentions } from "./run-mentions.ts";
import { assertExtensionReferencesAvailable } from "./trust-gating.ts";

export interface PrepareUserPromptOptions {
	readonly text: string;
	readonly composerText?: string;
	readonly references?: readonly ComposerExtensionReference[];
	readonly attachmentIds: readonly string[];
	readonly mediaLibrary: MediaLibrary;
	readonly restoredContents?: ReadonlyMap<string, ImageContent>;
	readonly skills: CodingSkillsSnapshot;
	readonly mcpRegistry?: Pick<CodingMcpRegistry, "selectTools" | "snapshot">;
	readonly signal?: AbortSignal;
}

/** Activates `$` Skill context and admits mentioned MCP Tools for the next Run. */
export async function prepareUserPrompt(options: PrepareUserPromptOptions): Promise<AgentInput> {
	const composerText = options.composerText ?? options.text;
	const references = options.references ?? [];
	const mcpTools = options.mcpRegistry?.snapshot().tools ?? [];
	assertExtensionReferencesAvailable(options.skills, mcpTools, references);
	const resolved = resolveRunMentions({
		composerText,
		references,
		skills: options.skills,
		mcpTools,
	});
	options.mcpRegistry?.selectTools(resolved.mcpToolIds);
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
	if (resolved.skillReferences.length === 0) return prepared;
	const activations = await activateExplicitSkillReferences({
		snapshot: options.skills,
		references: resolved.skillReferences,
		composerText,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return prependSkillContext(
		prepared,
		renderExplicitSkillContext(activations),
		renderExplicitSkillReferences(activations),
	);
}
