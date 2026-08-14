import type { SkillFileSystem, SkillId, SkillRoot, Skills } from "@coda/skills";
import { createSkills } from "@coda/skills";
import type { CommandRegistry } from "../commands/registry.ts";
import type { SlashExtensionEntry } from "../commands/unified-registry.ts";
import { registerSlashExtension } from "../commands/unified-registry.ts";
import { createCodingSkillsSnapshot } from "./snapshot.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot } from "./types.ts";

export interface CodingSkillsManagerOptions {
	readonly fileSystem: SkillFileSystem;
	readonly roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly limits?: Parameters<typeof createSkills>[0]["limits"];
}

export class CodingSkillsManager {
	readonly #runtime: Skills<CodingSkillOrigin>;
	readonly #roots: readonly SkillRoot<CodingSkillOrigin>[];
	#current?: CodingSkillsSnapshot;
	#dirty = true;
	#dirtyGeneration = 0;
	#publishedGeneration = -1;
	readonly #refreshes = new Map<number, Promise<CodingSkillsSnapshot>>();

	constructor(options: CodingSkillsManagerOptions) {
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
				.then((loader) => {
					const snapshot = createCodingSkillsSnapshot({ loader });
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

function slashCompatible(name: string): boolean {
	return name.length > 0 && !/[\s/]/u.test(name);
}

/** Returns stable Composer entries: short winners and qualified collision alternatives. */
export function skillExtensionEntries(snapshot: CodingSkillsSnapshot): readonly SlashExtensionEntry[] {
	const shortAliasByName = new Map<string, SkillId>();
	for (const entry of snapshot.resolved) {
		if (!shortAliasByName.has(entry.candidate.metadata.name)) {
			shortAliasByName.set(entry.candidate.metadata.name, entry.candidate.id);
		}
	}
	return Object.freeze(
		snapshot.resolved.flatMap((entry) => {
			const surfaceWinner = shortAliasByName.get(entry.candidate.metadata.name) === entry.candidate.id;
			const name = surfaceWinner ? entry.candidate.metadata.name : entry.qualifiedName;
			if (!slashCompatible(name)) return [];
			const id = String(entry.candidate.id).replace(/^skill:/u, "");
			return [
				Object.freeze({
					id,
					name,
					title: entry.candidate.metadata.name,
					description: entry.candidate.metadata.description,
				}),
			];
		}),
	);
}

export function skillIdFromCommandId(commandId: string): SkillId | undefined {
	return /^skill:[a-f0-9]{32}$/u.test(commandId) ? (commandId as SkillId) : undefined;
}

export class SkillCommandRegistryBinding {
	readonly #registry: CommandRegistry;
	#dispose: readonly (() => void)[] = [];

	constructor(registry: CommandRegistry) {
		this.#registry = registry;
	}

	sync(snapshot: CodingSkillsSnapshot): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
		const next: (() => void)[] = [];
		try {
			for (const entry of skillExtensionEntries(snapshot)) {
				next.push(registerSlashExtension(this.#registry, "skill", entry));
			}
			this.#dispose = Object.freeze(next);
		} catch (error) {
			for (const dispose of next.reverse()) dispose();
			throw error;
		}
	}

	dispose(): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
	}
}
