import type { TimeRuntime } from "@coda/ai";
import { createFauxCore, fauxAssistantMessage, Type } from "@coda/ai";
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	type AttemptId,
	type Clock,
	type IdGenerator,
	type MessageId,
	prepareStaticRun,
	type QueueItemId,
	type RunId,
	type RunResult,
	type ToolInvocationId,
	type TurnId,
} from "../src/index.ts";

const schema = Type.Object({ query: Type.String() });

const lookup: AgentTool<typeof schema, { source: string }> = {
	name: "lookup",
	description: "Look up a value",
	parameters: schema,
	replaySafety: "safe",
	parallelSafe: true,
	execute({ query }, { providerToolCallId }) {
		return {
			content: query,
			details: { source: providerToolCallId },
		};
	},
};

export function composeAgent(clock: Clock, idGenerator: IdGenerator): Agent {
	const runtime: TimeRuntime = {
		clock,
		random: { next: () => 0 },
		sleep: { wait: async () => {} },
	};
	const faux = createFauxCore({ runtime });
	faux.setResponses([fauxAssistantMessage("ready", { timestamp: clock.now() })]);
	return new Agent({
		clock,
		idGenerator,
		prepareRun: prepareStaticRun({
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			tools: [lookup],
		}),
	});
}

export function consumeRun(agent: Agent): Promise<RunResult> {
	agent.onEvent((event: AgentEvent) => {
		if (event.type === "message_update") void event.delta;
	});
	return agent.prompt("hello");
}

export type IdentityTuple = [RunId, TurnId, AttemptId, MessageId, ToolInvocationId, QueueItemId];

function assertOpaqueIdentityDomains(queueId: QueueItemId): void {
	// @ts-expect-error Opaque identity domains must not be interchangeable.
	const invalidRunId: RunId = queueId;
	void invalidRunId;
}

void assertOpaqueIdentityDomains;
