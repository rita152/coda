import type { OpenCodingAgentOptions } from "@coda/runtime";

type InputResourceStore = NonNullable<OpenCodingAgentOptions["resources"]>;
type InputResourceReservation = Awaited<ReturnType<InputResourceStore["reserve"]>>;
type InputResourceRequest = Parameters<InputResourceStore["reserve"]>[0];

interface ResourceGroup {
	readonly references: readonly string[];
	readonly reservation: InputResourceReservation;
	state: "available" | "reserved" | "settled";
	settlement?: Promise<void>;
	release?: () => Promise<void>;
	releaseOperation?: Promise<void>;
}

export interface RegisteredInputResources extends InputResourceReservation {
	readonly resources: readonly string[];
}

/**
 * Owns the hand-off from application-staged resources to Work Graph acceptance.
 *
 * Callers may still roll back a group that was rejected before Runtime
 * reservation. Once reserved, the Runtime is the only component that decides
 * commit versus rollback.
 */
export class WorkspaceInputResources {
	readonly #groupsByReference = new Map<string, ResourceGroup>();

	readonly adapter: InputResourceStore = Object.freeze({
		reserve: async (request: InputResourceRequest) => {
			const references = [...new Set(request.references)];
			if (references.length === 0) return noResources();
			const groups = new Set<ResourceGroup>();
			for (const reference of references) {
				const group = this.#groupsByReference.get(reference);
				if (!group) throw new Error(`Input resource is not registered: ${reference}`);
				if (group.state !== "available") throw new Error(`Input resource is already reserved: ${reference}`);
				groups.add(group);
			}
			for (const group of groups) group.state = "reserved";
			return Object.freeze({
				commit: () => this.#settle(groups, "commit"),
				rollback: () => this.#settle(groups, "rollback"),
			});
		},
	});

	register(
		references: readonly string[],
		reservation: InputResourceReservation,
		release?: () => Promise<void>,
	): RegisteredInputResources {
		const unique = Object.freeze([...new Set(references)]);
		if (unique.length === 0) return Object.freeze({ ...reservation, resources: unique });
		for (const reference of unique) {
			if (!reference) throw new Error("Input resource identity must not be empty");
			if (this.#groupsByReference.has(reference)) {
				throw new Error(`Input resource identity is already registered: ${reference}`);
			}
		}
		const group: ResourceGroup = {
			references: unique,
			reservation,
			state: "available",
			...(release ? { release } : {}),
		};
		for (const reference of unique) this.#groupsByReference.set(reference, group);
		return Object.freeze({
			resources: unique,
			commit: () => this.#settleAndRelease(group, "commit"),
			rollback: () => this.#settleAndRelease(group, "rollback"),
		});
	}

	async #settleAndRelease(group: ResourceGroup, outcome: "commit" | "rollback"): Promise<void> {
		try {
			await this.#settle(new Set([group]), outcome);
		} finally {
			if (!group.releaseOperation) group.releaseOperation = group.release?.() ?? Promise.resolve();
			await group.releaseOperation;
		}
	}

	async #settle(groups: ReadonlySet<ResourceGroup>, outcome: "commit" | "rollback"): Promise<void> {
		for (const group of groups) {
			if (!group.settlement) {
				group.state = "settled";
				group.settlement = Promise.resolve(group.reservation[outcome]()).finally(() => {
					for (const reference of group.references) {
						if (this.#groupsByReference.get(reference) === group) this.#groupsByReference.delete(reference);
					}
				});
			}
			await group.settlement;
		}
	}
}

function noResources(): InputResourceReservation {
	return Object.freeze({
		commit: () => Promise.resolve(),
		rollback: () => Promise.resolve(),
	});
}
