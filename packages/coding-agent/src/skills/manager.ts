import type { SkillFileSystem, SkillRoot, Skills } from "@coda/skills";
import { createSkills, DEFAULT_SKILL_LIMITS } from "@coda/skills";
import { aggregateSkillsSnapshots } from "./aggregate.ts";
import { readSkillSidecarMetadata } from "./invocation.ts";
import { createCodingSkillsSnapshot } from "./snapshot.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot } from "./types.ts";

export interface CodingSkillsManagerOptions {
	readonly fileSystem: SkillFileSystem;
	readonly roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly limits?: Parameters<typeof createSkills>[0]["limits"];
	readonly supplementalSnapshots?: () =>
		| readonly import("@coda/skills").SkillsSnapshot<CodingSkillOrigin>[]
		| Promise<readonly import("@coda/skills").SkillsSnapshot<CodingSkillOrigin>[]>;
}

export class CodingSkillsManager {
	readonly #runtime: Skills<CodingSkillOrigin>;
	readonly #fileSystem: SkillFileSystem;
	readonly #roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly #supplementalSnapshots?: CodingSkillsManagerOptions["supplementalSnapshots"];
	readonly #maxSkills: number;
	#current?: CodingSkillsSnapshot;
	#dirty = true;
	#dirtyGeneration = 0;
	#publishedGeneration = -1;
	readonly #refreshes = new Map<number, Promise<CodingSkillsSnapshot>>();

	constructor(options: CodingSkillsManagerOptions) {
		this.#fileSystem = options.fileSystem;
		this.#runtime = createSkills<CodingSkillOrigin>({
			fileSystem: options.fileSystem,
			...(options.limits ? { limits: options.limits } : {}),
		});
		this.#roots = Object.freeze([...options.roots]);
		this.#supplementalSnapshots = options.supplementalSnapshots;
		this.#maxSkills = options.limits?.maxSkills ?? DEFAULT_SKILL_LIMITS.maxSkills;
	}

	get roots(): readonly SkillRoot<CodingSkillOrigin>[] {
		return this.#roots;
	}

	get current(): CodingSkillsSnapshot | undefined {
		return this.#current;
	}

	markDirty(): void {
		this.#dirty = true;
		this.#dirtyGeneration++;
	}

	/** Concurrent refreshes of one dirty generation share a single loader scan. */
	async refresh(
		options: { readonly rescan?: boolean; readonly signal?: AbortSignal } = {},
	): Promise<CodingSkillsSnapshot> {
		if (options.signal?.aborted)
			throw options.signal.reason ?? new DOMException("Skill refresh aborted", "AbortError");
		if ((options.rescan ?? true) && !this.#dirty) {
			this.#dirty = true;
			this.#dirtyGeneration++;
		}
		if (!this.#dirty && this.#current) return this.#current;
		const generation = this.#dirtyGeneration;
		let operation = this.#refreshes.get(generation);
		if (!operation) {
			operation = Promise.all([
				this.#runtime.snapshot({ roots: this.#roots, profile: "compatible" }),
				Promise.resolve(this.#supplementalSnapshots?.() ?? []),
			])
				.then(async ([primary, supplemental]) => {
					const loader = aggregateSkillsSnapshots([primary, ...supplemental], { maxSkills: this.#maxSkills });
					const sidecars = await readSkillSidecarMetadata(this.#fileSystem, loader.candidates);
					const roots = [
						...this.#roots,
						...loader.candidates.flatMap(({ provenance }) =>
							provenance.map(({ root, origin }) => Object.freeze({ path: root, origin })),
						),
					];
					const snapshot = createCodingSkillsSnapshot({
						loader,
						roots,
						sidecarMetadataById: sidecars.metadataById,
						sidecarDiagnostics: sidecars.diagnostics,
					});
					if (generation >= this.#publishedGeneration) {
						this.#current = snapshot;
						this.#publishedGeneration = generation;
					}
					if (this.#dirtyGeneration === generation && this.#publishedGeneration === generation) {
						this.#dirty = false;
					}
					return snapshot;
				})
				.finally(() => this.#refreshes.delete(generation));
			this.#refreshes.set(generation, operation);
		}
		if (!options.signal) return operation;
		return new Promise<CodingSkillsSnapshot>((resolve, reject) => {
			const onAbort = () =>
				reject(options.signal!.reason ?? new DOMException("Skill refresh aborted", "AbortError"));
			options.signal!.addEventListener("abort", onAbort, { once: true });
			operation!.then(resolve, reject).finally(() => options.signal!.removeEventListener("abort", onAbort));
		});
	}
}
