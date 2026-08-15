import type { WorkspaceSessionOwner } from "./ports.ts";
import type { WorkGraphId, WorkItemId } from "./types.ts";

/** Owns process-local Session leases and quarantine state for one Workspace epoch. */
export class SessionLeaseRegistry {
	readonly #leases = new Map<string, { readonly graphId: WorkGraphId; readonly itemId: WorkItemId }>();
	readonly #quarantined = new Set<string>();

	hydrate(owners: readonly WorkspaceSessionOwner[]): void {
		for (const owner of owners) this.claim(owner.sessionId, owner.graphId, owner.itemId);
	}

	has(sessionId: string): boolean {
		return this.#leases.has(sessionId);
	}

	owner(sessionId: string): { readonly graphId: WorkGraphId; readonly itemId: WorkItemId } | undefined {
		return this.#leases.get(sessionId);
	}

	claim(sessionId: string, graphId: WorkGraphId, itemId: WorkItemId): void {
		this.#leases.set(sessionId, Object.freeze({ graphId, itemId }));
	}

	release(sessionId: string): void {
		this.#leases.delete(sessionId);
		this.#quarantined.delete(sessionId);
	}

	quarantine(sessionId: string): void {
		this.#quarantined.add(sessionId);
	}

	releaseGraph(graphId: WorkGraphId): void {
		for (const [sessionId, owner] of this.#leases) {
			if (owner.graphId === graphId && !this.#quarantined.has(sessionId)) this.#leases.delete(sessionId);
		}
	}
}
