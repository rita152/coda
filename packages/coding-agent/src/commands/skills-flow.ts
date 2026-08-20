import type { CodingSkillsSnapshot, ResolvedCodingSkill } from "../skills/types.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";
import { extractDollarMentions } from "./mentions.ts";
import { skillComposerName } from "./skill-extensions.ts";

export interface SkillTryNowPrefill {
	readonly text: string;
	readonly commandId: string;
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

export interface SkillsCommandFlowOptions {
	readonly snapshot: CodingSkillsSnapshot;
	readonly onRefresh: () => Promise<CodingSkillsSnapshot>;
	readonly onTry?: (prefill: SkillTryNowPrefill) => Promise<void> | void;
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

function normalizedSelector(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function skillPrimaryLabel(entry: ResolvedCodingSkill): string {
	if (entry.origin.kind === "plugin") return entry.qualifiedName;
	return entry.interface?.displayName ?? entry.candidate.metadata.name;
}

export function createSkillTryNowPrefill(entry: ResolvedCodingSkill): SkillTryNowPrefill {
	const surfaceName = skillComposerName(entry);
	const canonicalName = entry.candidate.metadata.name;
	let text = entry.interface?.defaultPrompt?.trim() ?? "";
	const recognizedNames = new Set([normalizedSelector(canonicalName), normalizedSelector(surfaceName)]);
	for (const mention of [...extractDollarMentions(text)].reverse()) {
		if (!recognizedNames.has(normalizedSelector(mention.name))) continue;
		text = `${text.slice(0, mention.start)}$${surfaceName}${text.slice(mention.end)}`;
	}
	let selected = extractDollarMentions(text).find(
		({ name }) => normalizedSelector(name) === normalizedSelector(surfaceName),
	);
	if (!selected) {
		text = text ? `${text} $${surfaceName}` : `$${surfaceName}`;
		selected = extractDollarMentions(text).find(
			({ name }) => normalizedSelector(name) === normalizedSelector(surfaceName),
		);
	}
	if (!selected) throw new Error(`Skill Try now prompt could not reference ${surfaceName}`);
	return Object.freeze({
		text: `${text.trimEnd()} `,
		commandId: String(entry.candidate.id),
		name: surfaceName,
		start: selected.start,
		end: selected.end,
	});
}

function skillDetail(entry: ResolvedCodingSkill, options: SkillsCommandFlowOptions): CommandFlowMenu {
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
		title: skillPrimaryLabel(entry),
		items: Object.freeze([
			...(options.onTry
				? [
						Object.freeze({
							id: "try-now",
							label: "Try now",
							description: "Prefill an editable task without submitting it",
							onSelect: async (navigation: CommandFlowNavigation) => {
								await options.onTry!(createSkillTryNowPrefill(entry));
								navigation.close();
							},
						}),
					]
				: []),
			Object.freeze({ id: "name", label: "Canonical name", description: entry.qualifiedName }),
			...(entry.interface?.displayName && entry.interface.displayName !== skillPrimaryLabel(entry)
				? [
						Object.freeze({
							id: "display-name",
							label: "Display name",
							description: entry.interface.displayName,
						}),
					]
				: []),
			Object.freeze({ id: "id", label: "Skill ID", description: String(candidate.id) }),
			Object.freeze({ id: "revision", label: "Revision", description: String(candidate.revision) }),
			Object.freeze({ id: "path", label: "Path", description: candidate.skillFile }),
			Object.freeze({ id: "source", label: "Source", description: entry.sourceLabel }),
			...(entry.interface?.defaultPrompt
				? [
						Object.freeze({
							id: "default-prompt",
							label: "Default prompt",
							description: entry.interface.defaultPrompt,
						}),
					]
				: []),
			...(entry.interface?.iconSmall
				? [Object.freeze({ id: "icon-small", label: "Small icon", description: entry.interface.iconSmall })]
				: []),
			...(entry.interface?.iconLarge
				? [Object.freeze({ id: "icon-large", label: "Large icon", description: entry.interface.iconLarge })]
				: []),
			...(entry.interface?.brandColor
				? [Object.freeze({ id: "brand-color", label: "Brand color", description: entry.interface.brandColor })]
				: []),
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
		const provenance = `${resolved.sourceLabel} • ${candidate.conformant ? "conformant" : "compatible"}${resolved.collisionCount > 1 ? ` • collision ${resolved.winner ? "winner" : "alternative"}` : ""}`;
		const description = [
			...(resolved.origin.kind === "plugin" && resolved.interface?.displayName
				? [resolved.interface.displayName]
				: []),
			...(resolved.interface?.shortDescription ? [resolved.interface.shortDescription] : []),
			provenance,
		].join(" • ");
		return Object.freeze({
			id: String(candidate.id),
			label: skillPrimaryLabel(resolved),
			description,
			status: "available",
			onSelect: (navigation: CommandFlowNavigation) => navigation.push(skillDetail(resolved, options)),
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
