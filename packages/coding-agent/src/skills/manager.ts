import type { SkillFileSystem, SkillRoot, Skills } from "@coda/skills";
import { createSkills } from "@coda/skills";
import { readSidecarImplicitInvocation } from "./invocation.ts";
import { createCodingSkillsSnapshot } from "./snapshot.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot } from "./types.ts";

export interface CodingSkillsManagerOptions {
	readonly fileSystem: SkillFileSystem;
	readonly roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly limits?: Parameters<typeof createSkills>[0]["limits"];
}

export class CodingSkillsManager {
	readonly #runtime: Skills<CodingSkillOrigin>;
	readonly #fileSystem: SkillFileSystem;
	readonly #roots: readonly SkillRoot<CodingSkillOrigin>[];
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
			operation = this.#runtime
				.snapshot({ roots: this.#roots, profile: "compatible" })
				.then(async (loader) => {
					const implicitInvocationById = await readSidecarImplicitInvocation(this.#fileSystem, loader.candidates);
					const snapshot = createCodingSkillsSnapshot({
						loader,
						roots: this.#roots,
						implicitInvocationById,
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
