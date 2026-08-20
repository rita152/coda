import type { SkillCandidate, SkillId, SkillRoot, SkillsSnapshot } from "@coda/skills";
import { allowsImplicitInvocation } from "./invocation.ts";
import type {
	CodingSkillDiagnostic,
	CodingSkillOrigin,
	CodingSkillSidecarMetadata,
	CodingSkillsSnapshot,
	ResolvedCodingSkill,
} from "./types.ts";

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
	return origin.sourceLabel ?? (origin.scope === "user" ? "~/.agents/skills" : "./.agents/skills");
}

function qualifiedName(
	candidate: SkillCandidate<CodingSkillOrigin>,
	origin: CodingSkillOrigin,
	suffixLength = 8,
): string {
	if (origin.kind === "plugin" && origin.pluginName) {
		return `${origin.pluginName}:${candidate.metadata.name}`;
	}
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
	readonly sidecarMetadataById?: ReadonlyMap<SkillId, CodingSkillSidecarMetadata>;
	readonly sidecarDiagnostics?: readonly CodingSkillDiagnostic[];
}): CodingSkillsSnapshot {
	const candidates = Object.freeze(
		options.loader.candidates.filter((candidate) => {
			const products = options.sidecarMetadataById?.get(candidate.id)?.policy?.products;
			return !products || products.length === 0 || products.includes("codex");
		}),
	);
	const loader: SkillsSnapshot<CodingSkillOrigin> =
		candidates.length === options.loader.candidates.length
			? options.loader
			: Object.freeze({ ...options.loader, candidates });
	const preliminary = candidates.flatMap((candidate) => {
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
		const resolved = group.map((entry, index) => {
			const sidecar = options.sidecarMetadataById?.get(entry.candidate.id);
			return Object.freeze({
				...entry,
				qualifiedName:
					qualifiedCounts.get(entry.qualifiedName) === 1
						? entry.qualifiedName
						: qualifiedName(entry.candidate, entry.origin, 32),
				winner: index === 0,
				collisionCount: group.length,
				implicitInvocation: allowsImplicitInvocation({
					disableModelInvocation: entry.candidate.metadata.disableModelInvocation,
					sidecarAllowImplicit: sidecar?.policy?.allowImplicitInvocation,
				}),
				...(sidecar?.interface ? { interface: sidecar.interface } : {}),
				...(sidecar?.dependencies ? { dependencies: sidecar.dependencies } : {}),
				...(sidecar?.policy ? { policy: sidecar.policy } : {}),
			});
		});
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
		loader,
		roots: Object.freeze([...(options.roots ?? [])]),
		candidates,
		resolved: Object.freeze(resolvedSkills),
		byId,
		diagnostics: Object.freeze([
			...options.loader.diagnostics,
			...(options.sidecarDiagnostics ?? []),
			...productDiagnostics,
		]),
		activate: async (
			id: SkillId,
			activationOptions?: { readonly arguments?: string; readonly signal?: AbortSignal },
		) => {
			const entry = byId.get(id);
			if (!entry) throw new Error(`Skill is not available in this snapshot: ${String(id)}`);
			const result = await loader.activate(id, activationOptions);
			if (!result.ok) throw new Error(result.diagnostic.message);
			return result.activation;
		},
	});
}
