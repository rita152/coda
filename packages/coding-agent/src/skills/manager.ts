import type { SkillFileSystem, SkillId, SkillRoot, Skills } from "@coda/skills";
import { createSkills } from "@coda/skills";
import type { CommandRegistry } from "../commands/registry.ts";
import type { SlashExtensionEntry } from "../commands/unified-registry.ts";
import { registerSlashExtension } from "../commands/unified-registry.ts";
import { createCodingSkillsSnapshot } from "./inventory.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot, WorkspaceSkillsTrustRecord } from "./types.ts";

export interface CodingSkillsManagerOptions {
	readonly fileSystem: SkillFileSystem;
	readonly workspace: string;
	readonly roots: readonly SkillRoot<CodingSkillOrigin>[];
	readonly limits?: Parameters<typeof createSkills>[0]["limits"];
}

export class CodingSkillsManager {
	readonly #runtime: Skills<CodingSkillOrigin>;
	readonly #workspace: string;
	readonly #roots: readonly SkillRoot<CodingSkillOrigin>[];
	#current?: CodingSkillsSnapshot;
	#dirty = true;
	#dirtyGeneration = 0;
	#refreshTail: Promise<void> = Promise.resolve();

	constructor(options: CodingSkillsManagerOptions) {
		this.#runtime = createSkills<CodingSkillOrigin>({
			fileSystem: options.fileSystem,
			...(options.limits ? { limits: options.limits } : {}),
		});
		this.#workspace = options.workspace;
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

	/**
	 * Rescans by default so correctness never depends on watcher delivery. Callers may
	 * reuse the loader snapshot after a trust-only settings change.
	 */
	async refresh(
		trustRecords: readonly WorkspaceSkillsTrustRecord[] = [],
		options: { readonly rescan?: boolean; readonly signal?: AbortSignal } = {},
	): Promise<CodingSkillsSnapshot> {
		const operation = this.#refreshTail.then(async () => {
			const rescan = options.rescan ?? true;
			if (!rescan && !this.#dirty && this.#current) {
				this.#current = createCodingSkillsSnapshot({
					workspace: this.#workspace,
					loader: this.#current.loader,
					trustRecords,
				});
				return this.#current;
			}
			const dirtyGeneration = this.#dirtyGeneration;
			const loader = await this.#runtime.snapshot({
				roots: this.#roots,
				profile: "compatible",
				...(options.signal ? { signal: options.signal } : {}),
			});
			const snapshot = createCodingSkillsSnapshot({
				workspace: this.#workspace,
				loader,
				trustRecords,
			});
			this.#current = snapshot;
			this.#dirty = this.#dirtyGeneration !== dirtyGeneration;
			return snapshot;
		});
		this.#refreshTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}

function slashCompatible(name: string): boolean {
	return name.length > 0 && !/[\s/]/u.test(name);
}

/** Returns stable Composer entries: short winners and qualified collision alternatives. */
export function skillExtensionEntries(snapshot: CodingSkillsSnapshot): readonly SlashExtensionEntry[] {
	const shortAliasByName = new Map<string, SkillId>();
	for (const entry of snapshot.admitted) {
		if (!shortAliasByName.has(entry.candidate.metadata.name)) {
			shortAliasByName.set(entry.candidate.metadata.name, entry.candidate.id);
		}
	}
	return Object.freeze(
		snapshot.admitted.flatMap((entry) => {
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
