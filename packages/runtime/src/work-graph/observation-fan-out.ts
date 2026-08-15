import { BoundedObservationQueue, cloneFrozen } from "@coda/agent";
import type { ObservationBus } from "./ports.ts";
import type { CodingAgentObservation } from "./types.ts";

interface Subscriber {
	readonly queue: BoundedObservationQueue<CodingAgentObservation>;
	resync: boolean;
}

function immutableData<T>(value: T): T {
	return cloneFrozen(value) as T;
}

/** Owns bounded Observation delivery, subscriber state, and the publication sequence. */
export class ObservationFanOut implements ObservationBus {
	readonly #subscribers = new Set<Subscriber>();
	#sequence = 0;

	get sequence(): number {
		return this.#sequence;
	}

	subscribe(capacity: number): AsyncIterable<CodingAgentObservation> {
		const subscriber: Subscriber = {
			queue: new BoundedObservationQueue({ capacity, capacityName: "Observation" }),
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
		for (const subscriber of this.#subscribers) subscriber.queue.close({ discard: false });
	}

	#pushObservation(subscriber: Subscriber, observation: CodingAgentObservation): void {
		if (subscriber.queue.closed || subscriber.resync) return;
		if (!subscriber.queue.enqueue(observation)) {
			subscriber.resync = true;
			subscriber.queue.replace(
				immutableData({
					type: "resync_required",
					sequence: observation.sequence,
					reason: "slow_consumer",
				} satisfies CodingAgentObservation),
			);
		}
	}

	#requireSubscriberResynchronization(
		subscriber: Subscriber,
		observation: Extract<CodingAgentObservation, { readonly type: "resync_required" }>,
	): void {
		if (subscriber.queue.closed || subscriber.resync) return;
		subscriber.resync = true;
		subscriber.queue.replace(observation);
	}

	#nextObservation(subscriber: Subscriber): Promise<IteratorResult<CodingAgentObservation>> {
		return subscriber.queue.next();
	}

	#removeSubscriber(subscriber: Subscriber): void {
		subscriber.queue.close();
		this.#subscribers.delete(subscriber);
	}
}
