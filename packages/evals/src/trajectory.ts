import type { Clock, ModelStream } from "@coda/agent";
import {
	createAssistantMessageEventStream,
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@coda/ai";
import type { LoadedFixture, TrajectoryContent } from "./fixture-types.ts";
import type { DeterministicTimeRuntime } from "./time.ts";

function trajectoryContent(block: TrajectoryContent) {
	return block.type === "text"
		? fauxText(block.text)
		: fauxToolCall(block.name, structuredClone(block.arguments), { id: block.id });
}

export function createOfflineModelStream(fixture: LoadedFixture, runtime: DeterministicTimeRuntime): ModelStream {
	const faux = createFauxCore({ runtime });
	faux.setResponses(
		fixture.trajectory.map((step) => (context) => {
			runtime.advance(step.elapsedMs);
			const serialized = JSON.stringify(context);
			for (const expected of step.expectsContext ?? []) {
				if (!serialized.includes(expected)) {
					throw new Error(`Faux Model expected compacted Context to include: ${expected}`);
				}
			}
			const content = step.content.map(trajectoryContent);
			const message = fauxAssistantMessage(content, { clock: runtime.clock });
			const cacheRead = step.usage.cacheRead ?? 0;
			const cacheWrite = step.usage.cacheWrite ?? 0;
			message.stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			message.usage = {
				input: step.usage.input,
				output: step.usage.output,
				cacheRead,
				cacheWrite,
				reasoning: step.usage.reasoning ?? 0,
				totalTokens: step.usage.input + step.usage.output + cacheRead + cacheWrite,
				cost: {
					input: step.usage.priceUsd,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: step.usage.priceUsd,
				},
			};
			return message;
		}),
	);
	return ({ context, signal }) => faux.stream(faux.getModel(), context, { runtime, signal });
}

export function createModelCallLimitStream(
	stream: ModelStream,
	clock: Clock,
	maxModelCalls: number,
): { readonly stream: ModelStream; readonly calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		stream: (request) => {
			if (calls >= maxModelCalls) {
				const output = createAssistantMessageEventStream();
				queueMicrotask(() => {
					output.push({
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							api: "evaluation-limit",
							provider: "evaluation-limit",
							model: "evaluation-limit",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
							},
							stopReason: "error",
							errorMessage: `Live evaluation stopped at the ${maxModelCalls}-call limit`,
							timestamp: clock.now(),
						},
					});
				});
				return output;
			}
			calls++;
			return stream(request);
		},
	};
}
