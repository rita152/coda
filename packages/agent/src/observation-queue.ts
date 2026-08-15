export interface BoundedObservationQueueOptions<T> {
	readonly capacity: number;
	/** Optional push delivery. Without it, consumers call `next()`. */
	readonly deliver?: (value: T) => Promise<void> | void;
	readonly onDeliveryError?: (error: unknown) => void;
	/** Preserve a task boundary between every delivery. */
	readonly yieldBetweenDeliveries?: boolean;
	readonly capacityName?: string;
}

/**
 * Bounded, failure-isolated Observation handoff for both push subscribers and
 * AsyncIterator consumers. Producers never await downstream work.
 */
export class BoundedObservationQueue<T> {
	readonly #capacity: number;
	readonly #deliver?: NonNullable<BoundedObservationQueueOptions<T>["deliver"]>;
	readonly #onDeliveryError?: BoundedObservationQueueOptions<T>["onDeliveryError"];
	readonly #yieldBetweenDeliveries: boolean;
	readonly #items: T[] = [];
	readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];
	#scheduled = false;
	#closed = false;

	constructor(options: BoundedObservationQueueOptions<T>) {
		if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
			throw new Error(`${options.capacityName ?? "Observation"} capacity must be a positive safe integer`);
		}
		this.#capacity = options.capacity;
		this.#deliver = options.deliver;
		this.#onDeliveryError = options.onDeliveryError;
		this.#yieldBetweenDeliveries = options.yieldBetweenDeliveries ?? false;
	}

	get size(): number {
		return this.#items.length;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Returns false without mutation when the bounded queue is full. */
	enqueue(value: T): boolean {
		if (this.#closed) return false;
		if (this.#items.length >= this.#capacity) return false;
		const waiter = this.#waiters.shift();
		if (waiter && !this.#deliver) waiter({ done: false, value });
		else this.#items.push(value);
		this.#schedule();
		return true;
	}

	/** Atomically discards stale deliveries and retains one resynchronization item. */
	replace(value: T): void {
		if (this.#closed) return;
		this.#items.splice(0);
		const waiter = this.#waiters.shift();
		if (waiter && !this.#deliver) waiter({ done: false, value });
		else this.#items.push(value);
		this.#schedule();
	}

	clear(): void {
		this.#items.splice(0);
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.#items.shift();
		if (value !== undefined) return Promise.resolve({ done: false, value });
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	close(options: { readonly discard?: boolean } = {}): void {
		if (this.#closed) return;
		this.#closed = true;
		if (options.discard ?? true) this.#items.splice(0);
		if (this.#items.length === 0) {
			for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
		}
	}

	#schedule(): void {
		if (!this.#deliver || this.#closed || this.#scheduled || this.#items.length === 0) return;
		this.#scheduled = true;
		queueMicrotask(() => void this.#drain());
	}

	async #drain(): Promise<void> {
		if (this.#closed || !this.#deliver) {
			this.#scheduled = false;
			return;
		}
		const limit = this.#yieldBetweenDeliveries ? 1 : Number.POSITIVE_INFINITY;
		let delivered = 0;
		try {
			while (!this.#closed && delivered < limit) {
				const value = this.#items.shift();
				if (value === undefined) break;
				const delivery = this.#deliver(value);
				if (delivery) await delivery;
				delivered++;
			}
		} catch (error) {
			this.#scheduled = false;
			this.close();
			this.#onDeliveryError?.(error);
			return;
		}
		this.#scheduled = false;
		this.#schedule();
	}
}
