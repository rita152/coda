export interface WorkspaceSessionPaneIdentity<TPane> {
	readonly id: (pane: TPane) => string;
	readonly isEmpty: (pane: TPane) => boolean;
}

export interface WorkspaceSessionPaneCreation<TPane> {
	readonly pane: TPane;
	readonly created: boolean;
}

/** Keeps opened Session panes alive while changing only foreground focus. */
export class WorkspaceSessionPanes<TPane> {
	readonly #identity: WorkspaceSessionPaneIdentity<TPane>;
	readonly #open = new Map<string, TPane>();
	readonly #opening = new Map<string, Promise<TPane>>();
	#active: TPane;

	constructor(initial: TPane, identity: WorkspaceSessionPaneIdentity<TPane>) {
		this.#identity = identity;
		this.#active = initial;
		this.#open.set(identity.id(initial), initial);
	}

	get active(): TPane {
		return this.#active;
	}

	get open(): readonly TPane[] {
		return [...this.#open.values()];
	}

	get(sessionId: string): TPane | undefined {
		return this.#open.get(sessionId);
	}

	async focus(sessionId: string, load: () => Promise<TPane>): Promise<TPane> {
		let pane = this.#open.get(sessionId);
		if (!pane) {
			let pending = this.#opening.get(sessionId);
			if (!pending) {
				pending = load().then((loaded) => {
					if (this.#identity.id(loaded) !== sessionId) {
						throw new Error(`Loaded Session pane identity does not match ${sessionId}`);
					}
					const existing = this.#open.get(sessionId);
					if (existing) return existing;
					this.#open.set(sessionId, loaded);
					return loaded;
				});
				this.#opening.set(sessionId, pending);
				void pending.then(
					() => this.#opening.delete(sessionId),
					() => this.#opening.delete(sessionId),
				);
			}
			pane = await pending;
		}
		this.#active = pane;
		return pane;
	}

	async create(factory: () => Promise<TPane>): Promise<WorkspaceSessionPaneCreation<TPane>> {
		if (this.#identity.isEmpty(this.#active)) return { pane: this.#active, created: false };
		const pane = await factory();
		const id = this.#identity.id(pane);
		if (this.#open.has(id)) throw new Error(`Session pane is already open: ${id}`);
		this.#open.set(id, pane);
		this.#active = pane;
		return { pane, created: true };
	}

	/** Atomically replaces the foreground pane after its successor is ready. */
	replaceActive(replacement: TPane): TPane {
		if (!this.#identity.isEmpty(replacement)) throw new Error("Replacement Session pane is not empty");
		const replacementId = this.#identity.id(replacement);
		const activeId = this.#identity.id(this.#active);
		if (replacementId === activeId || this.#open.has(replacementId)) {
			throw new Error(`Replacement Session pane identity is already open: ${replacementId}`);
		}
		const replaced = this.#active;
		this.#open.delete(activeId);
		this.#open.set(replacementId, replacement);
		this.#active = replacement;
		return replaced;
	}
}
