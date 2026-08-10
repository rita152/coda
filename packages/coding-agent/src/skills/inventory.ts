import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { SkillCandidate, SkillId, SkillsSnapshot } from "@coda/skills";
import type {
	CodingSkillDiagnostic,
	CodingSkillOrigin,
	CodingSkillsSnapshot,
	ResolvedCodingSkill,
	WorkspaceSkillInventoryItem,
	WorkspaceSkillsInventory,
	WorkspaceSkillsInventoryDiff,
	WorkspaceSkillsTrustRecord,
} from "./types.ts";

const INCOMPLETE_DISCOVERY_CODES = new Set([
	"scan-depth-exceeded",
	"scan-directory-limit-exceeded",
	"scan-entry-limit-exceeded",
	"skill-limit-exceeded",
]);

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
	readonly #values: Map<K, V>;

	constructor(entries: Iterable<readonly [K, V]>) {
		this.#values = new Map(entries);
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	get(key: K): V | undefined {
		return this.#values.get(key);
	}

	has(key: K): boolean {
		return this.#values.has(key);
	}

	entries(): MapIterator<[K, V]> {
		return this.#values.entries();
	}

	keys(): MapIterator<K> {
		return this.#values.keys();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}
}

function inventoryItems(
	candidates: readonly SkillCandidate<CodingSkillOrigin>[],
): readonly WorkspaceSkillInventoryItem[] {
	return Object.freeze(
		candidates
			.filter((candidate) => candidate.provenance.some(({ origin }) => origin.scope === "workspace"))
			.map((candidate) =>
				Object.freeze({
					id: String(candidate.id),
					path: candidate.skillFile,
					revision: String(candidate.revision),
				}),
			)
			.sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id)),
	);
}

function inventoryHash(items: readonly WorkspaceSkillInventoryItem[]): string {
	const hash = createHash("sha256");
	hash.update("coda-workspace-skills-inventory-v1\0");
	for (const item of items) hash.update(`${item.id}\0${item.path}\0${item.revision}\0`);
	return hash.digest("hex");
}

function inventoryDiff(
	previous: readonly WorkspaceSkillInventoryItem[],
	current: readonly WorkspaceSkillInventoryItem[],
): WorkspaceSkillsInventoryDiff {
	const immutablePrevious = previous.map((item) => Object.freeze({ ...item }));
	const before = new Map(immutablePrevious.map((item) => [item.id, item]));
	const after = new Map(current.map((item) => [item.id, item]));
	const added = current.filter((item) => !before.has(item.id));
	const removed = immutablePrevious.filter((item) => !after.has(item.id));
	const changed = current.flatMap((item) => {
		const old = before.get(item.id);
		return old && (old.path !== item.path || old.revision !== item.revision)
			? [Object.freeze({ before: old, after: item })]
			: [];
	});
	return Object.freeze({
		added: Object.freeze(added),
		removed: Object.freeze(removed),
		changed: Object.freeze(changed),
	});
}

function workspaceInventory(
	workspace: string,
	loader: SkillsSnapshot<CodingSkillOrigin>,
	trustRecords: readonly WorkspaceSkillsTrustRecord[],
): WorkspaceSkillsInventory {
	const items = inventoryItems(loader.candidates);
	const sha256 = inventoryHash(items);
	const complete = !loader.diagnostics.some(
		(diagnostic) =>
			diagnostic.severity === "error" &&
			INCOMPLETE_DISCOVERY_CODES.has(diagnostic.code) &&
			(diagnostic.origin === undefined || diagnostic.origin.scope === "workspace"),
	);
	const prior = trustRecords.find((entry) => entry.workspace === workspace);
	const trusted = complete && prior?.sha256 === sha256;
	return Object.freeze({
		workspace,
		sha256,
		complete,
		items,
		trust: !complete ? "incomplete" : items.length === 0 ? "not-required" : trusted ? "trusted" : "untrusted",
		diff: inventoryDiff(prior?.inventory ?? [], items),
	});
}

function originLabel(origin: CodingSkillOrigin): string {
	return origin.scope === "user" ? "~/.agents/skills" : "./.agents/skills";
}

function qualifiedName(
	candidate: SkillCandidate<CodingSkillOrigin>,
	origin: CodingSkillOrigin,
	suffixLength = 8,
): string {
	const suffix = String(candidate.id)
		.replace(/^skill:/u, "")
		.slice(-suffixLength);
	return `${candidate.metadata.name}@${origin.scope}-${suffix}`;
}

function collisionDiagnostic(name: string, entries: readonly ResolvedCodingSkill[]): CodingSkillDiagnostic | undefined {
	if (entries.length < 2) return undefined;
	return Object.freeze({
		code: "skill-name-collision",
		severity: "warning",
		message: `Skill name "${name}" has ${entries.length} candidates; ${entries[0]!.sourceLabel} is the precedence winner`,
		skillId: entries[0]!.candidate.id,
		path: entries[0]!.candidate.skillFile,
	});
}

function selectedOrigin(
	candidate: SkillCandidate<CodingSkillOrigin>,
	workspaceTrusted: boolean,
): CodingSkillOrigin | undefined {
	return candidate.provenance
		.map(({ origin }) => origin)
		.filter((origin) => origin.scope === "user" || workspaceTrusted)
		.sort((left, right) => left.priority - right.priority || compareText(left.root, right.root))[0];
}

export function createCodingSkillsSnapshot(options: {
	readonly workspace: string;
	readonly loader: SkillsSnapshot<CodingSkillOrigin>;
	readonly trustRecords?: readonly WorkspaceSkillsTrustRecord[];
}): CodingSkillsSnapshot {
	const inventory = workspaceInventory(options.workspace, options.loader, options.trustRecords ?? []);
	const workspaceTrusted = inventory.trust === "trusted" || inventory.trust === "not-required";
	const preliminary = options.loader.candidates.flatMap((candidate) => {
		const origin = selectedOrigin(candidate, workspaceTrusted);
		if (!origin) return [];
		return [
			{
				candidate,
				origin,
				precedence: origin.priority,
				sourceLabel: originLabel(origin),
				qualifiedName: qualifiedName(candidate, origin),
			},
		];
	});
	const grouped = new Map<string, typeof preliminary>();
	for (const entry of preliminary) {
		const group = grouped.get(entry.candidate.metadata.name) ?? [];
		group.push(entry);
		grouped.set(entry.candidate.metadata.name, group);
	}
	const admitted: ResolvedCodingSkill[] = [];
	const productDiagnostics: CodingSkillDiagnostic[] = [];
	for (const [name, group] of [...grouped].sort(([left], [right]) => compareText(left, right))) {
		group.sort(
			(left, right) =>
				left.precedence - right.precedence || compareText(String(left.candidate.id), String(right.candidate.id)),
		);
		const qualifiedCounts = new Map<string, number>();
		for (const entry of group) {
			qualifiedCounts.set(entry.qualifiedName, (qualifiedCounts.get(entry.qualifiedName) ?? 0) + 1);
		}
		const resolved = group.map((entry, index) =>
			Object.freeze({
				...entry,
				qualifiedName:
					qualifiedCounts.get(entry.qualifiedName) === 1
						? entry.qualifiedName
						: qualifiedName(entry.candidate, entry.origin, 32),
				winner: index === 0,
				collisionCount: group.length,
			}),
		);
		admitted.push(...resolved);
		const diagnostic = collisionDiagnostic(name, resolved);
		if (diagnostic) productDiagnostics.push(diagnostic);
	}
	admitted.sort(
		(left, right) =>
			left.precedence - right.precedence ||
			compareText(left.candidate.metadata.name, right.candidate.metadata.name) ||
			compareText(String(left.candidate.id), String(right.candidate.id)),
	);
	if (inventory.trust === "untrusted") {
		productDiagnostics.push(
			Object.freeze({
				code: "workspace-skills-untrusted",
				severity: "warning",
				message: `Workspace Skills inventory ${inventory.sha256} is not trusted and was omitted`,
			}),
		);
	} else if (inventory.trust === "incomplete") {
		productDiagnostics.push(
			Object.freeze({
				code: "workspace-skills-incomplete",
				severity: "error",
				message: "Workspace Skills discovery hit a hard limit; the partial inventory cannot be trusted",
			}),
		);
	}
	const byId: ReadonlyMap<SkillId, ResolvedCodingSkill> = new ImmutableMap(
		admitted.map((entry) => [entry.candidate.id, entry] as const),
	);
	const snapshot: CodingSkillsSnapshot = {
		loader: options.loader,
		inventory,
		candidates: options.loader.candidates,
		admitted: Object.freeze(admitted),
		byId,
		diagnostics: Object.freeze([...options.loader.diagnostics, ...productDiagnostics]),
		activate: async (id, activationOptions) => {
			const entry = byId.get(id);
			if (!entry) throw new Error(`Skill is not trusted, enabled, or present in this snapshot: ${String(id)}`);
			const result = await options.loader.activate(id, activationOptions);
			if (!result.ok) throw new Error(result.diagnostic.message);
			return result.activation;
		},
	};
	return Object.freeze(snapshot);
}

export function workspaceSkillsTrustRecord(snapshot: CodingSkillsSnapshot): WorkspaceSkillsTrustRecord {
	if (!snapshot.inventory.complete) throw new Error("Cannot trust an incomplete Workspace Skills inventory");
	return Object.freeze({
		workspace: snapshot.inventory.workspace,
		sha256: snapshot.inventory.sha256,
		inventory: Object.freeze(snapshot.inventory.items.map((item) => Object.freeze({ ...item }))),
	});
}

export function skillDirectoryLabel(candidate: SkillCandidate<CodingSkillOrigin>): string {
	return basename(candidate.directory);
}

export function asSkillId(value: string): SkillId {
	return value as SkillId;
}
