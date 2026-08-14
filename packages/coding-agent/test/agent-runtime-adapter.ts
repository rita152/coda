import { Agent, type AgentOptions, prepareStaticRun, type StaticRunPreparation } from "@coda/agent";
import type { RuntimeInputPort } from "@coda/runtime";

export type TestAgentOptions = Omit<AgentOptions, "prepareRun"> & StaticRunPreparation;

export function createTestAgent(options: TestAgentOptions): Agent {
	const { stream, tools, systemPrompt, recoverFailedAttempt, ...kernel } = options;
	return new Agent({
		...kernel,
		prepareRun: prepareStaticRun({
			stream,
			tools,
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			...(recoverFailedAttempt === undefined ? {} : { recoverFailedAttempt }),
		}),
	});
}

export function agentRuntimePort(agent: Agent): RuntimeInputPort {
	return {
		snapshot: () => ({ agent: agent.state }),
		prompt: (input) => agent.prompt(input),
		steer: (input) => agent.steer(input),
		followUp: (input) => agent.followUp(input),
		cancel: (queueItemId) => {
			if (queueItemId === undefined) agent.abort();
			else agent.cancelQueueItem(queueItemId);
		},
		dispatch: async (command) => {
			switch (command.type) {
				case "prompt":
					return agent.prompt(command.input);
				case "steer":
					return agent.steer(command.input);
				case "follow_up":
					return agent.followUp(command.input);
				case "run_next_follow_up":
					return agent.runNextFollowUp();
				case "resume_follow_ups":
					return agent.resumeFollowUps();
				case "cancel":
					if (command.queueItemId === undefined) agent.abort();
					else agent.cancelQueueItem(command.queueItemId);
					return undefined;
			}
		},
		subscribe: (listener) => agent.onEvent(listener),
	};
}
