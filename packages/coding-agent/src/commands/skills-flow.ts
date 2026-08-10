import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";
import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "../skills/types.ts";

export interface SkillsCommandFlowOptions {
	readonly snapshot: CodingSkillsSnapshot;
	readonly onRefresh: () => Promise<CodingSkillsSnapshot>;
	readonly onTrust: () => Promise<CodingSkillsSnapshot>;
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

function trustConfirmation(options: SkillsCommandFlowOptions): CommandFlowMenu {
	const diff = options.snapshot.inventory.diff;
	const changes = [
		...diff.added.map((item, index) =>
			Object.freeze({
				id: `added:${index}`,
				label: `Added ${item.id}`,
				description: `${item.path} • ${item.revision.slice(0, 12)}`,
			}),
		),
		...diff.removed.map((item, index) =>
			Object.freeze({
				id: `removed:${index}`,
				label: `Removed ${item.id}`,
				description: `${item.path} • ${item.revision.slice(0, 12)}`,
			}),
		),
		...diff.changed.map(({ before, after }, index) =>
			Object.freeze({
				id: `changed:${index}`,
				label: `Changed ${after.id}`,
				description: `${after.path} • ${before.revision.slice(0, 12)} -> ${after.revision.slice(0, 12)}`,
			}),
		),
	];
	const preview = changes.slice(0, 50);
	return Object.freeze({
		id: "skills:trust",
		title: "Trust Workspace Skills",
		items: Object.freeze([
			Object.freeze({
				id: "summary",
				label: `Inventory ${options.snapshot.inventory.sha256.slice(0, 12)}`,
				description: `+${diff.added.length} -${diff.removed.length} ~${diff.changed.length}; trust grants no execution authority`,
			}),
			...preview,
			...(changes.length > preview.length
				? [
						Object.freeze({
							id: "changes-truncated",
							label: `… ${changes.length - preview.length} more changes`,
						}),
					]
				: []),
			Object.freeze({
				id: "confirm",
				label: "Trust exact inventory",
				description: "Any content or membership change requires trust again",
				onSelect: (navigation: CommandFlowNavigation) => reopen(options.onTrust(), options, navigation),
			}),
			Object.freeze({
				id: "cancel",
				label: "Cancel",
				onSelect: (navigation: CommandFlowNavigation) => navigation.back(),
			}),
		]),
	});
}

export function createSkillsCommandFlow(options: SkillsCommandFlowOptions): CommandFlowMenu {
	const inventory = options.snapshot.inventory;
	const admittedIds = new Set(options.snapshot.admitted.map(({ candidate }) => candidate.id));
	const candidates = options.snapshot.candidates.map((candidate) => {
		const resolved = options.snapshot.byId.get(candidate.id);
		return Object.freeze({
			id: String(candidate.id),
			label: candidate.metadata.name,
			description: resolved
				? `${resolved.sourceLabel} • ${candidate.conformant ? "conformant" : "compatible"}${resolved.collisionCount > 1 ? ` • collision ${resolved.winner ? "winner" : "alternative"}` : ""}`
				: `${candidate.skillFile} • omitted (${inventory.trust})`,
			status: admittedIds.has(candidate.id) ? "available" : "omitted",
			...(resolved
				? { onSelect: (navigation: CommandFlowNavigation) => navigation.push(skillDetail(resolved)) }
				: {}),
		});
	});
	return Object.freeze({
		id: "skills",
		title: "Skills",
		filterable: true,
		items: Object.freeze([
			Object.freeze({
				id: "inventory",
				label: `Workspace inventory: ${inventory.trust}`,
				description: `${inventory.items.length} Skill(s) • ${inventory.sha256.slice(0, 12)}`,
			}),
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
			...(inventory.trust === "untrusted"
				? [
						Object.freeze({
							id: "trust",
							label: "Review and trust Workspace inventory",
							description: `+${inventory.diff.added.length} -${inventory.diff.removed.length} ~${inventory.diff.changed.length}`,
							onSelect: (navigation: CommandFlowNavigation) => navigation.push(trustConfirmation(options)),
						}),
					]
				: []),
			...candidates,
		]),
	});
}
