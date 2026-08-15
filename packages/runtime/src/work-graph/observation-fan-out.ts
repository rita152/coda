import type { ObservationBus } from "./ports.ts";
import type { CodingAgentObservation } from "./types.ts";

interface Subscriber {
	readonly capacity: number;
	readonly queue: CodingAgentObservation[];
	readonly waiters: Array<(value: IteratorResult<CodingAgentObservation>) => void>;
	closed: boolean;
	resync: boolean;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const entry of Object.values(value)) deepFreeze(entry);
	return value;
}

function immutableData<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

/** Owns bounded Observation delivery, subscriber state, and the publication sequence. */
export class ObservationFanOut implements ObservationBus {
	readonly #subscribers = new Set<Subscriber>();
	#sequence = 0;

	get sequence(): number {
		return this.#sequence;
	}

	subscribe(capacity: number): AsyncIterable<CodingAgentObservation> {
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new Error("Observation capacity must be a positive safe integer");
		}
		const subscriber: Subscriber = {
			capacity,
			queue: [],
			waiters: [],
			closed: false,
			resync: false,
		};
		this.#subscribers.add(subscriber);
		const fanOut = this;
		return Object.freeze({
			async *[Symbol.asyncIterator]() {
				try {
					while (true) {
						const next = await fanOut.#nextObservation(subscriber);
						if (next.done) return;
						yield next.value;
						if (next.value.type === "resync_required" || next.value.type === "closed") return;
					}
				} finally {
					fanOut.#removeSubscriber(subscriber);
				}
			},
		});
	}

	publish(factory: (sequence: number) => CodingAgentObservation): number {
		const sequence = ++this.#sequence;
		const observation = immutableData(factory(sequence));
		for (const subscriber of this.#subscribers) {
			if (observation.type === "resync_required") {
				this.#requireSubscriberResynchronization(subscriber, observation);
			} else {
				this.#pushObservation(subscriber, observation);
			}
		}
		return sequence;
	}

	closeAll(): void {
		for (const subscriber of this.#subscribers) {
			subscriber.closed = true;
			if (subscriber.queue.length === 0) {
				for (const waiter of subscriber.waiters.splice(0)) waiter({ done: true, value: undefined });
			}
		}
	}

	#pushObservation(subscriber: Subscriber, observation: CodingAgentObservation): void {
		if (subscriber.closed || subscriber.resync) return;
		const waiter = subscriber.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: observation });
			return;
		}
		if (subscriber.queue.length >= subscriber.capacity) {
			subscriber.queue.splice(0);
			subscriber.resync = true;
			subscriber.queue.push(
				immutableData({
					type: "resync_required",
					sequence: observation.sequence,
					reason: "slow_consumer",
				} satisfies CodingAgentObservation),
			);
			return;
		}
		subscriber.queue.push(observation);
	}

	#requireSubscriberResynchronization(
		subscriber: Subscriber,
		observation: Extract<CodingAgentObservation, { readonly type: "resync_required" }>,
	): void {
		if (subscriber.closed || subscriber.resync) return;
		subscriber.queue.splice(0);
		subscriber.resync = true;
		const waiter = subscriber.waiters.shift();
		if (waiter) waiter({ done: false, value: observation });
		else subscriber.queue.push(observation);
	}

	#nextObservation(subscriber: Subscriber): Promise<IteratorResult<CodingAgentObservation>> {
		const queued = subscriber.queue.shift();
		if (queued) return Promise.resolve({ done: false, value: queued });
		if (subscriber.closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => subscriber.waiters.push(resolve));
	}

	#removeSubscriber(subscriber: Subscriber): void {
		subscriber.closed = true;
		this.#subscribers.delete(subscriber);
		for (const waiter of subscriber.waiters.splice(0)) waiter({ done: true, value: undefined });
		subscriber.queue.splice(0);
	}
}
