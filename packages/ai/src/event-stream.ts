// Portions derived from Pi:
// /packages/ai/src/utils/event-stream.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

export class EventStream<T, R = T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiting: ((value: IteratorResult<T>) => void)[] = [];
	private readonly finalResultPromise: Promise<R>;
	private readonly isComplete: (event: T) => boolean;
	private readonly extractResult: (event: T) => R;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: unknown) => void;
	private done = false;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise<R>((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
	}

	push(event: T): void {
		if (this.done) return;

		const terminal = this.isComplete(event);
		if (terminal) {
			this.done = true;
			try {
				this.resolveFinalResult(this.extractResult(event));
			} catch (error) {
				this.rejectFinalResult(error);
			}
		}

		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);

		if (terminal && waiter) this.finishWaitingConsumers();
	}

	end(result: R): void;
	end(...args: [] | [result: R]): void {
		if (args.length === 0) {
			const error = new Error("EventStream.end() requires a result");
			if (!this.done) {
				this.done = true;
				this.rejectFinalResult(error);
				this.finishWaitingConsumers();
			}
			throw error;
		}
		if (this.done) return;

		const [result] = args;
		this.done = true;
		this.resolveFinalResult(result);
		this.finishWaitingConsumers();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
				continue;
			}
			if (this.done) return;

			const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
			if (result.done) return;
			yield result.value;
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}

	private finishWaitingConsumers(): void {
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
