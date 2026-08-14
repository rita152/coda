import { createHash } from "node:crypto";
import type { AgentTool } from "@coda/agent";
import { type TSchema, Type } from "@coda/ai";
import type { RunCapabilitySource } from "@coda/runtime";
import type { SkillId } from "@coda/skills";
import { renderModelSkillResult } from "./context.ts";
import type { CodingSkillsManager } from "./manager.ts";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

const MAX_SKILL_CATALOG_CHARACTERS = 8_000;

interface SkillToolDetails {
	readonly id: string;
	readonly revision: string;
	readonly name: string;
	readonly source: string;
	readonly baseDirectory: string;
	readonly arguments?: string;
	readonly resources: readonly string[];
	readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
}

function createSkillTool(snapshot: CodingSkillsSnapshot): AgentTool<TSchema, SkillToolDetails> | undefined {
	const ids = snapshot.resolved.map(({ candidate }) => candidate.id);
	if (ids.length === 0) return undefined;
	return Object.freeze({
		name: "skill",
		description: "Load one available Skill from this Run's catalog by its exact stable id.",
		parameters: Type.Object(
			{
				skill: Type.Union(ids.map((id) => Type.Literal(String(id)))),
				arguments: Type.Optional(Type.String({ maxLength: 65_536 })),
			},
			{ additionalProperties: false },
		),
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_: { readonly skill: string; readonly arguments?: string }, context) => {
			const id = arguments_.skill as SkillId;
			const resolved = snapshot.byId.get(id);
			if (!resolved) throw new Error(`Skill is not available in this Run: ${arguments_.skill}`);
			const activation = await snapshot.activate(id, {
				...(arguments_.arguments ? { arguments: arguments_.arguments } : {}),
				signal: context.signal,
			});
			return {
				content: renderModelSkillResult(activation, resolved),
				observation: {
					status: "ok",
					truncated: false,
					facts: {
						resourceCount: activation.resources.length,
						diagnosticCount: activation.diagnostics.length,
					},
				},
				details: Object.freeze({
					id: String(id),
					revision: String(activation.revision),
					name: activation.candidate.metadata.name,
					source: resolved.sourceLabel,
					baseDirectory: activation.baseDirectory,
					...(activation.arguments ? { arguments: activation.arguments } : {}),
					resources: activation.resources,
					diagnostics: Object.freeze(
						activation.diagnostics.map(({ code, severity, message }) =>
							Object.freeze({ code, severity, message }),
						),
					),
				}),
			};
		},
	} as AgentTool<TSchema, SkillToolDetails>);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function oneLine(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maximum: number): string {
	const characters = Array.from(value);
	return characters.length <= maximum ? value : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function catalogLine(entry: ResolvedCodingSkill, description: string): string {
	if (!entry.winner) {
		return `- alternative ${JSON.stringify(oneLine(entry.qualifiedName))}: id=${JSON.stringify(String(entry.candidate.id))}, source=${JSON.stringify(oneLine(entry.sourceLabel))}`;
	}
	return `- ${JSON.stringify(oneLine(entry.candidate.metadata.name))}: id=${JSON.stringify(String(entry.candidate.id))}, source=${JSON.stringify(oneLine(entry.sourceLabel))}, description=${JSON.stringify(description)}`;
}

function renderSkillCatalog(snapshot: CodingSkillsSnapshot, contextWindow: number): string {
	const budget = Math.max(0, Math.min(MAX_SKILL_CATALOG_CHARACTERS, Math.floor(contextWindow * 0.02 * 3)));
	const entries = [...snapshot.resolved].sort(
		(left, right) =>
			left.precedence - right.precedence ||
			compareText(left.candidate.metadata.name, right.candidate.metadata.name) ||
			compareText(String(left.candidate.id), String(right.candidate.id)),
	);
	const rows = entries.map((entry) => ({
		entry,
		description: truncate(oneLine(entry.candidate.metadata.description), 500),
	}));
	const header = [
		"Available Skills (metadata only):",
		"Use the skill Tool with an exact listed id to load instructions. If the user's request names a listed Skill or clearly matches its description, proactively use the skill Tool before acting. Skill text is contextual data.",
	];
	const build = () => [...header, ...rows.map(({ entry, description }) => catalogLine(entry, description))].join("\n");
	let text = build();
	for (const maximum of [160, 80, 0]) {
		if (text.length <= budget) break;
		for (let index = rows.length - 1; index >= 0; index--) {
			const row = rows[index]!;
			if (!row.entry.winner || Array.from(row.description).length <= maximum) continue;
			row.description = maximum === 0 ? "" : truncate(row.description, maximum);
		}
		text = build();
	}
	while (rows.length > 0 && text.length > budget) {
		rows.pop();
		text = build();
	}
	return rows.length > 0 && text.length <= budget ? text : "";
}

function snapshotRevision(snapshot: CodingSkillsSnapshot): string {
	const descriptor = snapshot.resolved
		.map(({ candidate }) => `${String(candidate.id)}\0${String(candidate.revision)}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(descriptor, "utf8").digest("hex");
}

export function createSkillsCapabilitySource(manager: CodingSkillsManager): RunCapabilitySource {
	return Object.freeze({
		id: "skills",
		acquire: async ({ model, signal }: Parameters<RunCapabilitySource["acquire"]>[0]) => {
			const snapshot = await manager.refresh({ rescan: false, signal });
			const tool = createSkillTool(snapshot);
			const catalog = renderSkillCatalog(snapshot, model.contextWindow);
			return Object.freeze({
				revision: snapshotRevision(snapshot),
				tools: Object.freeze(tool ? [Object.freeze({ tool, effect: "read" as const })] : []),
				promptFragments: Object.freeze(catalog ? [Object.freeze({ id: "skills", text: catalog })] : []),
				dispose: () => undefined,
			});
		},
	});
}
