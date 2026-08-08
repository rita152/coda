import {
	type AssistantMessage,
	type Clock,
	type Context,
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	type TimeRuntime,
} from "@coda/ai";
import type { AgentOptions, IdGenerator, IdKind, ModelStream } from "../src/index.ts";

export class TestClock implements Clock {
	#value: number;

	constructor(value = 1_000) {
		this.#value = value;
	}

	now(): number {
		return this.#value++;
	}
}

export class TestIds implements IdGenerator {
	readonly allocated: { kind: IdKind; value: string }[] = [];
	#next = 1;

	generate(kind: IdKind): string {
		const value = `${kind}:${this.#next++}`;
		this.allocated.push({ kind, value });
		return value;
	}
}

export function testTimeRuntime(clock: Clock): TimeRuntime {
	return {
		clock,
		random: { next: () => 0 },
		sleep: { wait: async () => {} },
	};
}

export function createFauxRuntime(
	responses: readonly FauxResponseStep[],
	clock: Clock,
	contexts: Context[] = [],
): ModelStream {
	const runtime = testTimeRuntime(clock);
	const faux = createFauxCore({ runtime, chunkCharacters: 2 });
	faux.setResponses([...responses]);
	return ({ context, signal }) => {
		contexts.push(structuredClone(context));
		return faux.streamSimple(faux.getModel(), context, { signal, runtime });
	};
}

export function response(text: string, clock: Clock): AssistantMessage {
	return fauxAssistantMessage(text, { timestamp: clock.now() });
}

export function baseOptions(
	responses: readonly FauxResponseStep[],
	options: { clock?: TestClock; ids?: TestIds; contexts?: Context[] } = {},
): AgentOptions & { clock: TestClock; idGenerator: TestIds } {
	const clock = options.clock ?? new TestClock();
	const idGenerator = options.ids ?? new TestIds();
	return {
		clock,
		idGenerator,
		stream: createFauxRuntime(responses, clock, options.contexts),
		tools: [],
		policyGate: { check: async () => ({ decision: "allow" }) },
	};
}
