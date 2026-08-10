export interface RunRuntimeSnapshot<T> {
	readonly id: number;
	readonly value: T;
}

/**
 * Holds one session's desired runtime selection while keeping the active Run's
 * selection stable. Values passed to this slot must already be immutable and
 * ready for synchronous activation at the Agent's beforeRun boundary.
 */
export class RunRuntimeSlot<T> {
	#selected: T;
	#active?: RunRuntimeSnapshot<T>;
	#nextId = 0;

	constructor(initial: T) {
		this.#selected = initial;
	}

	get selected(): T {
		return this.#selected;
	}

	get active(): RunRuntimeSnapshot<T> | undefined {
		return this.#active;
	}

	select(value: T): void {
		this.#selected = value;
	}

	begin(): RunRuntimeSnapshot<T> {
		if (this.#active) throw new Error(`Run runtime is already active: ${this.#active.id}`);
		const snapshot = Object.freeze({ id: ++this.#nextId, value: this.#selected });
		this.#active = snapshot;
		return snapshot;
	}

	end(id: number): void {
		if (!this.#active) throw new Error("No Run runtime is active");
		if (this.#active.id !== id) {
			throw new Error(`Cannot end Run runtime ${id}; active runtime is ${this.#active.id}`);
		}
		this.#active = undefined;
	}
}
