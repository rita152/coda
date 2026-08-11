import type { AgentTool } from "@coda/agent";
import { type TSchema, Type } from "@coda/ai";
import type { SkillId } from "@coda/skills";
import { renderModelSkillResult } from "./context.ts";
import type { CodingSkillsSnapshot } from "./types.ts";

export interface SkillToolDetails {
	readonly id: string;
	readonly revision: string;
	readonly name: string;
	readonly source: string;
	readonly baseDirectory: string;
	readonly arguments?: string;
	readonly resources: readonly string[];
	readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
}

export function modelVisibleSkillIds(snapshot: CodingSkillsSnapshot): readonly SkillId[] {
	return Object.freeze(snapshot.resolved.map(({ candidate }) => candidate.id));
}

export function createSkillTool(snapshot: CodingSkillsSnapshot): AgentTool<TSchema, SkillToolDetails> | undefined {
	const ids = modelVisibleSkillIds(snapshot);
	if (ids.length === 0) return undefined;
	const parameters = Type.Object(
		{
			skill: Type.Union(ids.map((id) => Type.Literal(String(id)))),
			arguments: Type.Optional(Type.String({ maxLength: 65_536 })),
		},
		{ additionalProperties: false },
	);
	return Object.freeze({
		name: "skill",
		description: "Load one available Skill from this Run's catalog by its exact stable id.",
		parameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_: { readonly skill: string; readonly arguments?: string }, context) => {
			const id = arguments_.skill as SkillId;
			const resolved = snapshot.byId.get(id);
			if (!resolved) {
				throw new Error(`Skill is not available in this Run: ${arguments_.skill}`);
			}
			const activation = await snapshot.activate(id, {
				...(arguments_.arguments ? { arguments: arguments_.arguments } : {}),
				signal: context.signal,
			});
			return {
				content: renderModelSkillResult(activation, resolved),
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
