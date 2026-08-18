import type { SkillCandidate, SkillId, SkillRoot, SkillsSnapshot } from "@coda/skills";
import { allowsImplicitInvocation } from "./invocation.ts";
import type { CodingSkillDiagnostic, CodingSkillOrigin, CodingSkillsSnapshot, ResolvedCodingSkill } from "./types.ts";

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

function selectedOrigin(candidate: SkillCandidate<CodingSkillOrigin>): CodingSkillOrigin | undefined {
	return candidate.provenance
		.map(({ origin }) => origin)
		.sort((left, right) => left.priority - right.priority || compareText(left.root, right.root))[0];
}

export function createCodingSkillsSnapshot(options: {
	readonly loader: SkillsSnapshot<CodingSkillOrigin>;
	readonly roots?: readonly SkillRoot<CodingSkillOrigin>[];
	readonly implicitInvocationById?: ReadonlyMap<SkillId, boolean>;
}): CodingSkillsSnapshot {
	const preliminary = options.loader.candidates.flatMap((candidate) => {
		const origin = selectedOrigin(candidate);
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
	const resolvedSkills: ResolvedCodingSkill[] = [];
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
				implicitInvocation: allowsImplicitInvocation({
					disableModelInvocation: entry.candidate.metadata.disableModelInvocation,
					sidecarAllowImplicit: options.implicitInvocationById?.get(entry.candidate.id),
				}),
			}),
		);
		resolvedSkills.push(...resolved);
		const diagnostic = collisionDiagnostic(name, resolved);
		if (diagnostic) productDiagnostics.push(diagnostic);
	}
	resolvedSkills.sort(
		(left, right) =>
			left.precedence - right.precedence ||
			compareText(left.candidate.metadata.name, right.candidate.metadata.name) ||
			compareText(String(left.candidate.id), String(right.candidate.id)),
	);
	const byId: ReadonlyMap<SkillId, ResolvedCodingSkill> = new ImmutableMap(
		resolvedSkills.map((entry) => [entry.candidate.id, entry] as const),
	);
	return Object.freeze({
		loader: options.loader,
		roots: Object.freeze([...(options.roots ?? [])]),
		candidates: options.loader.candidates,
		resolved: Object.freeze(resolvedSkills),
		byId,
		diagnostics: Object.freeze([...options.loader.diagnostics, ...productDiagnostics]),
		activate: async (
			id: SkillId,
			activationOptions?: { readonly arguments?: string; readonly signal?: AbortSignal },
		) => {
			const entry = byId.get(id);
			if (!entry) throw new Error(`Skill is not available in this snapshot: ${String(id)}`);
			const result = await options.loader.activate(id, activationOptions);
			if (!result.ok) throw new Error(result.diagnostic.message);
			return result.activation;
		},
	});
}
