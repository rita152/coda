import type { McpToolDescriptor } from "@coda/mcp";
import { mcpToolsForCommandId } from "../commands/mcp-extensions.ts";
import { extractDollarMentions } from "../commands/mentions.ts";
import type { ComposerExtensionReference } from "../session/composer-submission.ts";
import type { SkillComposerReference } from "../skills/context.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";

export interface ResolvedRunMentions {
	readonly skillReferences: readonly SkillComposerReference[];
	readonly mcpToolIds: readonly string[];
}

export function resolveRunMentions(options: {
	readonly composerText: string;
	readonly references?: readonly ComposerExtensionReference[];
	readonly skills: CodingSkillsSnapshot;
	readonly mcpTools?: readonly McpToolDescriptor[];
}): ResolvedRunMentions {
	const structured = options.references ?? [];
	const mcpTools = options.mcpTools ?? [];
	const skillReferences: SkillComposerReference[] = [];
	const mcpToolIds = new Set<string>();

	for (const reference of structured) {
		if (reference.source === "skill") {
			skillReferences.push(reference);
			continue;
		}
		if (reference.source === "mcp") {
			for (const tool of mcpToolsForCommandId(reference.commandId, mcpTools)) {
				mcpToolIds.add(tool.id);
			}
		}
	}

	const indexes = mentionIndexes(options.skills, mcpTools);
	for (const mention of extractDollarMentions(options.composerText)) {
		if (overlaps(mention.start, mention.end, structured)) continue;
		const skill = indexes.skills.get(mention.name);
		if (skill) {
			skillReferences.push(
				Object.freeze({
					id: `text-mention:${mention.start}:${skill.candidate.id}`,
					commandId: String(skill.candidate.id),
					source: "skill" as const,
					name: mention.name,
					start: mention.start,
					end: mention.end,
				}),
			);
			continue;
		}
		const tools = indexes.mcp.get(mention.name);
		if (!tools) continue;
		for (const tool of tools) mcpToolIds.add(tool.id);
	}

	return Object.freeze({
		skillReferences: Object.freeze(skillReferences),
		mcpToolIds: Object.freeze([...mcpToolIds]),
	});
}

function overlaps(start: number, end: number, references: readonly ComposerExtensionReference[]): boolean {
	return references.some((reference) => start < reference.end && end > reference.start);
}

function mentionIndexes(
	skills: CodingSkillsSnapshot,
	mcpTools: readonly McpToolDescriptor[],
): {
	readonly skills: ReadonlyMap<string, (typeof skills.resolved)[number]>;
	readonly mcp: ReadonlyMap<string, readonly McpToolDescriptor[]>;
} {
	const skillNames = new Map<string, (typeof skills.resolved)[number]>();
	addUnique(
		skillNames,
		skills.resolved.filter((entry) => entry.winner),
		(entry) => entry.candidate.metadata.name,
	);
	addUnique(skillNames, skills.resolved, (entry) => entry.qualifiedName);

	const mcp = new Map<string, readonly McpToolDescriptor[]>();
	const byServer = new Map<string, McpToolDescriptor[]>();
	for (const tool of mcpTools) {
		const group = byServer.get(tool.serverId) ?? [];
		group.push(tool);
		byServer.set(tool.serverId, group);
	}
	for (const [serverId, tools] of byServer) {
		if (!skillNames.has(serverId) && !mcp.has(serverId)) mcp.set(serverId, Object.freeze(tools));
	}
	addUniqueTools(mcp, skillNames, mcpTools, (tool) => tool.remoteName);
	addUniqueTools(mcp, skillNames, mcpTools, (tool) => `${tool.serverId}-${tool.remoteName}`);
	addUniqueTools(mcp, skillNames, mcpTools, (tool) => `${tool.serverId}:${tool.remoteName}`);
	addUniqueTools(mcp, skillNames, mcpTools, (tool) => tool.name);
	return { skills: skillNames, mcp };
}

function addUnique<T>(target: Map<string, T>, items: readonly T[], key: (item: T) => string): void {
	const counts = new Map<string, number>();
	for (const item of items) {
		const name = key(item);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	for (const item of items) {
		const name = key(item);
		if ((counts.get(name) ?? 0) !== 1 || target.has(name)) continue;
		target.set(name, item);
	}
}

function addUniqueTools(
	target: Map<string, readonly McpToolDescriptor[]>,
	reserved: ReadonlyMap<string, unknown>,
	tools: readonly McpToolDescriptor[],
	key: (tool: McpToolDescriptor) => string,
): void {
	const grouped = new Map<string, McpToolDescriptor[]>();
	for (const tool of tools) {
		const name = key(tool);
		const group = grouped.get(name) ?? [];
		group.push(tool);
		grouped.set(name, group);
	}
	for (const [name, group] of grouped) {
		if (group.length !== 1 || reserved.has(name) || target.has(name)) continue;
		target.set(name, Object.freeze(group));
	}
}
