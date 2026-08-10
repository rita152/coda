export interface WorkspaceSessionRuntimeIdentity<TRuntime> {
	readonly id: (runtime: TRuntime) => string;
	readonly isEmpty: (runtime: TRuntime) => boolean;
}

export interface WorkspaceSessionCreation<TRuntime> {
	readonly runtime: TRuntime;
	readonly created: boolean;
}

/** Keeps every opened Session runtime alive while changing only foreground focus. */
export class WorkspaceSessionRuntimes<TRuntime> {
	readonly #identity: WorkspaceSessionRuntimeIdentity<TRuntime>;
	readonly #open = new Map<string, TRuntime>();
	readonly #opening = new Map<string, Promise<TRuntime>>();
	#active: TRuntime;

	constructor(initial: TRuntime, identity: WorkspaceSessionRuntimeIdentity<TRuntime>) {
		this.#identity = identity;
		this.#active = initial;
		this.#open.set(identity.id(initial), initial);
	}

	get active(): TRuntime {
		return this.#active;
	}

	get open(): readonly TRuntime[] {
		return [...this.#open.values()];
	}

	get(sessionId: string): TRuntime | undefined {
		return this.#open.get(sessionId);
	}

	async focus(sessionId: string, load: () => Promise<TRuntime>): Promise<TRuntime> {
		let runtime = this.#open.get(sessionId);
		if (!runtime) {
			let pending = this.#opening.get(sessionId);
			if (!pending) {
				pending = load().then((loaded) => {
					if (this.#identity.id(loaded) !== sessionId) {
						throw new Error(`Loaded Session runtime identity does not match ${sessionId}`);
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
			runtime = await pending;
		}
		this.#active = runtime;
		return runtime;
	}

	async create(factory: () => Promise<TRuntime>): Promise<WorkspaceSessionCreation<TRuntime>> {
		if (this.#identity.isEmpty(this.#active)) return { runtime: this.#active, created: false };
		const runtime = await factory();
		const id = this.#identity.id(runtime);
		if (this.#open.has(id)) throw new Error(`Session runtime is already open: ${id}`);
		this.#open.set(id, runtime);
		this.#active = runtime;
		return { runtime, created: true };
	}
}
