import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentTool } from "@coda/agent";
import { type TSchema, Type } from "@coda/ai";
import type { RunCapabilitySelections, RunCapabilitySelectionValue, RunCapabilitySource } from "@coda/runtime";
import type { SkillActivation, SkillId } from "@coda/skills";
import { acquireScopedProjectRunCapabilityBundle } from "../host/project-capability-acquisition.ts";
import type { AcquireProjectRunCapabilityBundle } from "../runtime/project-capability-bundle.ts";
import { renderModelSkillResult } from "./context.ts";
import { modelVisibleSkills } from "./invocation.ts";
import type { CodingSkillsManager } from "./manager.ts";
import { resolveSkillSelector } from "./resolve.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

const MAX_SKILL_PROMPT_BYTES = 8_000;
const MAX_SKILL_DESCRIPTION_CHARACTERS = 1_024;
const APPROXIMATE_BYTES_PER_TOKEN = 4;
const UTF8_ENCODER = new TextEncoder();

export const SKILLS_RUN_CAPABILITY_SOURCE_ID = "skills";
const MAX_EXPLICIT_SKILL_ASSERTIONS = 256;

export interface ExplicitSkillRunAssertion {
	readonly skillId: string;
	readonly candidateRevision: string;
	readonly projectRevision: string;
}

function compareAssertion(left: ExplicitSkillRunAssertion, right: ExplicitSkillRunAssertion): number {
	return (
		compareText(left.skillId, right.skillId) ||
		compareText(left.candidateRevision, right.candidateRevision) ||
		compareText(left.projectRevision, right.projectRevision)
	);
}

function selectedSkillAssertions(
	selection: Parameters<RunCapabilitySource["acquire"]>[0]["selection"],
): readonly ExplicitSkillRunAssertion[] {
	if (selection === undefined) return Object.freeze([]);
	if (
		typeof selection !== "object" ||
		selection === null ||
		Array.isArray(selection) ||
		Object.keys(selection).length !== 1 ||
		!("assertions" in selection) ||
		!Array.isArray(selection.assertions) ||
		selection.assertions.length > MAX_EXPLICIT_SKILL_ASSERTIONS
	) {
		throw new Error("Invalid Skill Run capability selection");
	}
	const assertions: ExplicitSkillRunAssertion[] = [];
	const identities = new Set<string>();
	for (const value of selection.assertions) {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).length !== 3 ||
			!("skillId" in value) ||
			!("candidateRevision" in value) ||
			!("projectRevision" in value) ||
			typeof value.skillId !== "string" ||
			value.skillId.length === 0 ||
			typeof value.candidateRevision !== "string" ||
			value.candidateRevision.length === 0 ||
			typeof value.projectRevision !== "string" ||
			value.projectRevision.length === 0
		) {
			throw new Error("Invalid Skill Run capability selection");
		}
		const assertion = Object.freeze({
			skillId: value.skillId,
			candidateRevision: value.candidateRevision,
			projectRevision: value.projectRevision,
		});
		const identity = `${assertion.skillId}\0${assertion.candidateRevision}\0${assertion.projectRevision}`;
		if (identities.has(identity)) throw new Error("Invalid Skill Run capability selection");
		identities.add(identity);
		assertions.push(assertion);
	}
	return Object.freeze(assertions.sort(compareAssertion));
}

function mergeSkillAssertions(
	parent: RunCapabilitySelectionValue | undefined,
	child: RunCapabilitySelectionValue | undefined,
): RunCapabilitySelectionValue | undefined {
	const merged = new Map<string, ExplicitSkillRunAssertion>();
	for (const assertion of [...selectedSkillAssertions(parent), ...selectedSkillAssertions(child)]) {
		merged.set(`${assertion.skillId}\0${assertion.candidateRevision}\0${assertion.projectRevision}`, assertion);
	}
	const assertions: readonly RunCapabilitySelectionValue[] = Object.freeze(
		[...merged.values()]
			.sort(compareAssertion)
			.map(({ skillId, candidateRevision, projectRevision }) =>
				Object.freeze({ skillId, candidateRevision, projectRevision }),
			),
	);
	return Object.freeze({ assertions });
}

/** Captures the exact Skill candidates whose contents were injected before Run preparation. */
export function skillRunCapabilitySelections(
	projectRevision: string,
	entries: readonly {
		readonly activation: { readonly candidate: { readonly id: unknown; readonly revision: unknown } };
	}[],
): RunCapabilitySelections {
	if (!projectRevision) throw new TypeError("Explicit Skill context requires a Project revision");
	const assertionsByIdentity = new Map<string, ExplicitSkillRunAssertion>();
	for (const { activation } of entries) {
		const assertion = Object.freeze({
			skillId: String(activation.candidate.id),
			candidateRevision: String(activation.candidate.revision),
			projectRevision,
		});
		assertionsByIdentity.set(
			`${assertion.skillId}\0${assertion.candidateRevision}\0${assertion.projectRevision}`,
			assertion,
		);
	}
	const assertions = [...assertionsByIdentity.values()];
	if (assertions.length > MAX_EXPLICIT_SKILL_ASSERTIONS) {
		throw new Error(`Explicit Skill selection exceeds ${MAX_EXPLICIT_SKILL_ASSERTIONS} assertions`);
	}
	const values: readonly RunCapabilitySelectionValue[] = Object.freeze(
		assertions
			.sort(compareAssertion)
			.map(({ skillId, candidateRevision, projectRevision: revision }) =>
				Object.freeze({ skillId, candidateRevision, projectRevision: revision }),
			),
	);
	return Object.freeze({
		[SKILLS_RUN_CAPABILITY_SOURCE_ID]: Object.freeze({
			assertions: values,
		}),
	});
}

const HOST_ALIASES_INTRO =
	"A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.";

const HOST_ALIASES_HOW_TO_USE = [
	"### How to use skills",
	"- Discovery: The list above is the skills available in this session (name + description + short path). Skill bodies live on disk at the listed paths after expanding the matching alias from `### Skill roots`.",
	"- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.",
	"- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.",
	"- How to use a skill (progressive disclosure):",
	"  1) After deciding to use a skill, the main agent must expand the listed short `path` with the matching alias from `### Skill roots`, then open and read its `SKILL.md` completely before taking task actions. If a read is truncated or paginated, continue until EOF.",
	"  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that expanded `SKILL.md` first, and only consider other paths if needed.",
	"  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the files required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.",
	"  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.",
	"  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.",
	"- Coordination and sequencing:",
	"  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.",
	"  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.",
	"- Context hygiene:",
	"  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.",
	"  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.",
	"  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.",
	"- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.",
] as const;

interface HostAlias {
	readonly name: string;
	readonly root: string;
}

interface SkillToolDetails {
	readonly id: string;
	readonly revision: string;
	readonly name: string;
	readonly source: string;
	readonly baseDirectory: string;
	readonly arguments?: string;
	readonly truncated: boolean;
	readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
}

function normalizedSkillArguments(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\r\n?/gu, "\n").trim();
	return normalized || undefined;
}

function createSkillTool(
	snapshot: CodingSkillsSnapshot,
	activations: ReadonlyMap<SkillId, SkillActivation<CodingSkillOrigin>>,
): AgentTool<TSchema, SkillToolDetails> | undefined {
	if (modelVisibleSkills(snapshot).length === 0) return undefined;
	return Object.freeze({
		name: "skill",
		description:
			"Load one listed Skill by its catalog name or exact id and return its frozen SKILL.md body. If the user names a listed Skill or the task clearly matches a listed description, and that Skill is not already in USER-SELECTED SKILL CONTEXT, you must load it before other Tools (including delegate). Opening the listed SKILL.md path is the fallback. If you skip an obvious Skill, say why.",
		parameters: Type.Object(
			{
				skill: Type.String({
					minLength: 1,
					maxLength: 256,
					description: "Skill name or exact id from the Available skills catalog",
				}),
				arguments: Type.Optional(Type.String({ maxLength: 65_536 })),
			},
			{ additionalProperties: false },
		),
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_: { readonly skill: string; readonly arguments?: string }, context) => {
			const resolved = resolveSkillSelector(snapshot, arguments_.skill);
			if (!resolved?.implicitInvocation) {
				throw new Error(`Skill is not available in this Run: ${arguments_.skill}`);
			}
			const id = resolved.candidate.id;
			context.signal.throwIfAborted();
			const frozen = activations.get(id);
			if (!frozen) throw new Error(`Skill is not available in this Run: ${arguments_.skill}`);
			const skillArguments = normalizedSkillArguments(arguments_.arguments);
			const activation = skillArguments ? Object.freeze({ ...frozen, arguments: skillArguments }) : frozen;
			const truncated = UTF8_ENCODER.encode(activation.contents).byteLength > MAX_SKILL_PROMPT_BYTES;
			return {
				content: renderModelSkillResult(activation, resolved),
				observation: {
					status: "ok",
					truncated,
					facts: {
						diagnosticCount: activation.diagnostics.length,
					},
				},
				details: Object.freeze({
					id: String(id),
					revision: String(activation.revision),
					name: catalogName(resolved),
					source: resolved.sourceLabel,
					baseDirectory: activation.baseDirectory,
					...(activation.arguments ? { arguments: activation.arguments } : {}),
					truncated,
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

async function freezeRunSkillActivations(
	snapshot: CodingSkillsSnapshot,
	signal: AbortSignal,
): Promise<ReadonlyMap<SkillId, SkillActivation<CodingSkillOrigin>>> {
	const activations = new Map<SkillId, SkillActivation<CodingSkillOrigin>>();
	const visible = modelVisibleSkills(snapshot);
	if (visible.length === 0) return activations;
	for (const { candidate } of visible) {
		signal.throwIfAborted();
		activations.set(candidate.id, await snapshot.activate(candidate.id, { signal }));
	}
	return activations;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function oneLine(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maximum: number): string {
	const characters = Array.from(value);
	return characters.length <= maximum ? value : `${characters.slice(0, Math.max(0, maximum - 3)).join("")}...`;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function canonicalDiscoveryRoot(entry: ResolvedCodingSkill): string {
	const pluginRoot = entry.origin.kind === "plugin" ? entry.origin.pluginRoot : undefined;
	if (pluginRoot && isAbsolute(pluginRoot)) {
		const pluginSkillsRoot = join(pluginRoot, "skills");
		if (isContained(pluginSkillsRoot, entry.candidate.skillFile)) return pluginSkillsRoot;
	}
	const provenance =
		entry.candidate.provenance.find(({ origin }) => origin === entry.origin) ?? entry.candidate.provenance[0];
	if (!provenance) return entry.candidate.directory;
	let root = entry.candidate.directory;
	for (let depth = 0; depth < provenance.depth; depth++) root = dirname(root);
	return root;
}

function hostAliases(entries: readonly ResolvedCodingSkill[]): readonly HostAlias[] {
	const roots: string[] = [];
	for (const entry of entries) {
		const root = canonicalDiscoveryRoot(entry);
		if (!roots.includes(root)) roots.push(root);
	}
	return roots.map((root, index) => Object.freeze({ name: `r${index}`, root }));
}

function aliasLocator(path: string, aliases: readonly HostAlias[]): string {
	const alias = [...aliases]
		.filter(({ root }) => isContained(root, path))
		.sort((left, right) => right.root.length - left.root.length)[0];
	if (!alias) return path;
	const suffix = relative(alias.root, path).split(sep).join("/");
	return suffix.length > 0 ? `${alias.name}/${suffix}` : alias.name;
}

function catalogName(entry: ResolvedCodingSkill): string {
	if (entry.origin.kind === "plugin" && entry.origin.pluginName) {
		return `${entry.origin.pluginName}:${entry.candidate.metadata.name}`;
	}
	return entry.winner ? entry.candidate.metadata.name : entry.qualifiedName;
}

function catalogLine(entry: ResolvedCodingSkill, description: string, aliases: readonly HostAlias[]): string {
	const name = oneLine(catalogName(entry));
	const locator = `(file: ${aliasLocator(entry.candidate.skillFile, aliases)})`;
	return description.length > 0 ? `- ${name}: ${description} ${locator}` : `- ${name}: ${locator}`;
}

function skillRootLines(aliases: readonly HostAlias[]): readonly string[] {
	return aliases.map(({ name, root }) => `- \`${name}\` = \`${root}\``);
}

function utf8Length(value: string): number {
	return UTF8_ENCODER.encode(value).byteLength;
}

function metadataLineTokens(line: string): number {
	return Math.ceil(utf8Length(`${line}\n`) / APPROXIMATE_BYTES_PER_TOKEN);
}

function omissionMarker(omitted: number): string | undefined {
	if (omitted <= 0) return undefined;
	return `- ${omitted} additional ${omitted === 1 ? "skill" : "skills"} omitted from this bounded skills list.`;
}

function renderSkillCatalog(snapshot: CodingSkillsSnapshot, contextWindow: number): string {
	const metadataTokenBudget = Math.max(1, Math.floor(contextWindow * 0.02));
	const entries = [...modelVisibleSkills(snapshot)].sort(
		(left, right) =>
			left.precedence - right.precedence ||
			compareText(left.candidate.metadata.name, right.candidate.metadata.name) ||
			compareText(String(left.candidate.id), String(right.candidate.id)),
	);
	if (entries.length === 0) return "";
	const render = (
		rows: readonly { readonly entry: ResolvedCodingSkill; readonly description: string }[],
		aliases: readonly HostAlias[],
		omitted: number,
	) => {
		const roots = skillRootLines(aliases);
		const marker = omissionMarker(omitted);
		return `<skills_instructions>\n${[
			"## Skills",
			HOST_ALIASES_INTRO,
			...(roots.length > 0 ? ["### Skill roots", ...roots] : []),
			"### Available skills",
			...rows.map(({ entry, description }) => catalogLine(entry, description, aliases)),
			...(marker ? [marker] : []),
			...HOST_ALIASES_HOW_TO_USE,
		].join("\n")}\n</skills_instructions>`;
	};
	const metadataTokens = (
		rows: readonly { readonly entry: ResolvedCodingSkill; readonly description: string }[],
		aliases: readonly HostAlias[],
		omitted: number,
	) =>
		[
			...skillRootLines(aliases),
			...rows.map(({ entry, description }) => catalogLine(entry, description, aliases)),
			...(omissionMarker(omitted) ? [omissionMarker(omitted)!] : []),
		].reduce((total, line) => total + metadataLineTokens(line), 0);

	const rows: {
		readonly entry: ResolvedCodingSkill;
		readonly sourceCharacters: readonly string[];
		description: string;
	}[] = [];
	for (const entry of entries) {
		const tentativeRows = [
			...rows,
			{
				entry,
				sourceCharacters: Array.from(
					truncate(oneLine(entry.candidate.metadata.description), MAX_SKILL_DESCRIPTION_CHARACTERS),
				),
				description: "",
			},
		];
		const tentativeAliases = hostAliases(tentativeRows.map(({ entry: rowEntry }) => rowEntry));
		const tentativeOmitted = entries.length - tentativeRows.length;
		if (metadataTokens(tentativeRows, tentativeAliases, tentativeOmitted) > metadataTokenBudget) {
			continue;
		}
		rows.push(tentativeRows[tentativeRows.length - 1]!);
	}
	const aliases = hostAliases(rows.map(({ entry }) => entry));
	const omitted = entries.length - rows.length;
	if (rows.length === 0) {
		if (metadataTokens(rows, aliases, omitted) > metadataTokenBudget) return "";
		return render(rows, aliases, omitted);
	}
	let currentMetadataTokens = metadataTokens(rows, aliases, omitted);
	for (;;) {
		let changed = false;
		for (const row of rows) {
			const allocatedCharacters = Array.from(row.description).length;
			const nextCharacter = row.sourceCharacters[allocatedCharacters];
			if (nextCharacter === undefined) continue;
			const previousLine = catalogLine(row.entry, row.description, aliases);
			const nextDescription = `${row.description}${nextCharacter}`;
			const nextLine = catalogLine(row.entry, nextDescription, aliases);
			const nextMetadataTokens =
				currentMetadataTokens - metadataLineTokens(previousLine) + metadataLineTokens(nextLine);
			if (nextMetadataTokens > metadataTokenBudget) continue;
			row.description = nextDescription;
			currentMetadataTokens = nextMetadataTokens;
			changed = true;
		}
		if (!changed) break;
	}
	return render(rows, aliases, omitted);
}

export function codingSkillsSnapshotRevision(snapshot: CodingSkillsSnapshot): string {
	const descriptor = snapshot.resolved
		.map(
			({ candidate, dependencies, implicitInvocation, interface: interfaceMetadata, policy, qualifiedName }) =>
				`${String(candidate.id)}\0${String(candidate.revision)}\0${qualifiedName}\0${String(implicitInvocation)}\0${JSON.stringify(
					{
						interface: interfaceMetadata ?? null,
						dependencies: dependencies ?? null,
						policy: policy ?? null,
					},
				)}`,
		)
		.sort()
		.join("\n");
	return createHash("sha256").update(descriptor, "utf8").digest("hex");
}

export function createSkillsCapabilitySource(
	managerOrOptions: CodingSkillsManager | { readonly acquireProjectBundle: AcquireProjectRunCapabilityBundle },
): RunCapabilitySource {
	const acquireProjectBundle =
		"acquireProjectBundle" in managerOrOptions ? managerOrOptions.acquireProjectBundle : undefined;
	return Object.freeze({
		id: SKILLS_RUN_CAPABILITY_SOURCE_ID,
		mergeSelection: mergeSkillAssertions,
		acquire: async ({ model, signal, scope, selection }: Parameters<RunCapabilitySource["acquire"]>[0]) => {
			const assertions = selectedSkillAssertions(selection);
			const bundle = acquireProjectBundle
				? await acquireScopedProjectRunCapabilityBundle(scope, acquireProjectBundle, signal)
				: undefined;
			const snapshot = bundle
				? bundle.skills
				: await (managerOrOptions as CodingSkillsManager).refresh({ rescan: false, signal });
			const availableProjectRevision = bundle?.revision ?? `skills:${codingSkillsSnapshotRevision(snapshot)}`;
			{
				const unavailableProjectRevisions = [
					...new Set(
						assertions
							.map(({ projectRevision }) => projectRevision)
							.filter((projectRevision) => projectRevision !== availableProjectRevision),
					),
				].sort(compareText);
				if (unavailableProjectRevisions.length > 0) {
					throw new Error(
						`Selected Skill Project revision is no longer available: ${unavailableProjectRevisions.join(", ")}`,
					);
				}
			}
			const unavailableSkills = assertions
				.filter(({ skillId, candidateRevision }) => {
					const resolved = snapshot.byId.get(skillId as SkillId);
					return !resolved || String(resolved.candidate.revision) !== candidateRevision;
				})
				.map(({ skillId }) => skillId)
				.sort(compareText);
			if (unavailableSkills.length > 0) {
				throw new Error(`Selected Skill is no longer available: ${unavailableSkills.join(", ")}`);
			}
			const activations = await freezeRunSkillActivations(snapshot, signal);
			const tool = createSkillTool(snapshot, activations);
			const catalog = renderSkillCatalog(snapshot, model.contextWindow);
			return Object.freeze({
				revision: bundle
					? `${bundle.revision};skills:${codingSkillsSnapshotRevision(snapshot)}`
					: codingSkillsSnapshotRevision(snapshot),
				tools: Object.freeze(tool ? [Object.freeze({ tool, effect: "read" as const })] : []),
				promptFragments: Object.freeze(catalog ? [Object.freeze({ id: "skills", text: catalog })] : []),
				dispose: () => undefined,
			});
		},
	});
}
