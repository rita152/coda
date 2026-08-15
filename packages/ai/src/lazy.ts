// Portions derived from Pi:
// /packages/ai/src/api/lazy.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { emptyUsage } from "./api/shared.ts";
import { createStreamDiagnostic } from "./diagnostics.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	ProviderStreams,
	StreamOptions,
	TimeRuntime,
} from "./types.ts";

interface LazyStreamOptions {
	runtime: TimeRuntime;
	signal?: AbortSignal;
	debugDiagnostics?: boolean;
	phase?: string;
}

function createSetupErrorMessage(model: Model, error: unknown, options: LazyStreamOptions): AssistantMessage {
	const aborted = options.signal?.aborted === true;
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		timestamp: options.runtime.clock.now(),
	};
	if (!aborted) {
		message.errorMessage = error instanceof Error ? error.message : String(error);
		message.diagnostics = [
			createStreamDiagnostic(model, error, {
				phase: options.phase ?? "setup",
				clock: options.runtime.clock,
				debug: options.debugDiagnostics,
			}),
		];
	}
	return message;
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	let terminal = false;
	for await (const event of source) {
		if (event.type === "done" || event.type === "error") terminal = true;
		target.push(event);
	}
	if (!terminal) throw new Error("Inner stream ended without a terminal event");
}

export function lazyStream(
	model: Model,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	options: LazyStreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	let settled = false;
	const terminate = (error: unknown) => {
		if (settled) return;
		settled = true;
		const message = createSetupErrorMessage(model, error, options);
		outer.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
	};
	const onAbort = () => terminate(options.signal?.reason ?? new Error("Aborted"));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) queueMicrotask(onAbort);

	void setup()
		.then(async (inner) => {
			options.signal?.throwIfAborted();
			await forwardStream(outer, inner);
			settled = true;
		})
		.catch(terminate)
		.finally(() => options.signal?.removeEventListener("abort", onAbort));
	return outer;
}

export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options), options),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options), options),
	};
	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
					return implementation.fetchDeferred(model, handle, options);
				},
				options,
			);
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}
	return api;
}

export function streamOptionsForLazy(options: StreamOptions): LazyStreamOptions {
	return options;
}
