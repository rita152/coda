import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "../skills/types.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export interface SkillsCommandFlowOptions {
	readonly snapshot: CodingSkillsSnapshot;
	readonly onRefresh: () => Promise<CodingSkillsSnapshot>;
}

function reopen(
	operation: Promise<CodingSkillsSnapshot>,
	options: SkillsCommandFlowOptions,
	navigation: CommandFlowNavigation,
): Promise<void> {
	return operation.then((snapshot) => {
		navigation.push(createSkillsCommandFlow({ ...options, snapshot }));
	});
}

function skillDetail(entry: ResolvedCodingSkill): CommandFlowMenu {
	const candidate = entry.candidate;
	const diagnostics = candidate.diagnostics.map((diagnostic, index) =>
		Object.freeze({
			id: `diagnostic:${index}`,
			label: `${diagnostic.severity}: ${diagnostic.code}`,
			description: diagnostic.message,
		}),
	);
	return Object.freeze({
		id: `skills:detail:${candidate.id}`,
		title: candidate.metadata.name,
		items: Object.freeze([
			Object.freeze({ id: "id", label: "Skill ID", description: String(candidate.id) }),
			Object.freeze({ id: "revision", label: "Revision", description: String(candidate.revision) }),
			Object.freeze({ id: "path", label: "Path", description: candidate.skillFile }),
			Object.freeze({ id: "source", label: "Source", description: entry.sourceLabel }),
			Object.freeze({
				id: "conformance",
				label: "Agent Skills conformance",
				description: candidate.conformant ? "strictly conformant" : "loaded with compatible recovery",
			}),
			...diagnostics,
		]),
	});
}

function diagnosticsMenu(snapshot: CodingSkillsSnapshot): CommandFlowMenu {
	return Object.freeze({
		id: "skills:diagnostics",
		title: "Skill Diagnostics",
		filterable: true,
		items: Object.freeze(
			snapshot.diagnostics.length === 0
				? [Object.freeze({ id: "none", label: "No diagnostics" })]
				: snapshot.diagnostics.map((diagnostic, index) =>
						Object.freeze({
							id: `diagnostic:${index}`,
							label: `${diagnostic.severity}: ${diagnostic.code}`,
							description: `${diagnostic.message}${diagnostic.path ? ` • ${diagnostic.path}` : ""}`,
						}),
					),
		),
	});
}

export function createSkillsCommandFlow(options: SkillsCommandFlowOptions): CommandFlowMenu {
	const candidates = options.snapshot.resolved.map((resolved) => {
		const candidate = resolved.candidate;
		return Object.freeze({
			id: String(candidate.id),
			label: candidate.metadata.name,
			description: `${resolved.sourceLabel} • ${candidate.conformant ? "conformant" : "compatible"}${resolved.collisionCount > 1 ? ` • collision ${resolved.winner ? "winner" : "alternative"}` : ""}`,
			status: "available",
			onSelect: (navigation: CommandFlowNavigation) => navigation.push(skillDetail(resolved)),
		});
	});
	return Object.freeze({
		id: "skills",
		title: "Skills",
		filterable: true,
		items: Object.freeze([
			Object.freeze({
				id: "diagnostics",
				label: "Diagnostics",
				description: `${options.snapshot.diagnostics.length} total`,
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(diagnosticsMenu(options.snapshot)),
			}),
			Object.freeze({
				id: "refresh",
				label: "Refresh",
				description: "Rescan all bounded local Skill roots",
				onSelect: (navigation: CommandFlowNavigation) => reopen(options.onRefresh(), options, navigation),
			}),
			...candidates,
		]),
	});
}
