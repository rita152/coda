import { Agent, AgentError, type AgentOptions, prepareStaticRun, type StaticRunPreparation } from "@coda/agent";
import type { Model } from "@coda/ai";
import type { WorkResult } from "@coda/runtime";
import type { SessionWorkController } from "../src/runtime/session-work-controller.ts";

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

type AgentWorkPort = Pick<
	SessionWorkController,
	"beginPrompt" | "cancel" | "deliver" | "isBusy" | "prompt" | "state" | "subscribe" | "waitForIdle"
>;

const model = Object.freeze({
	id: "test",
	name: "Test",
	api: "faux",
	provider: "faux",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_000,
}) as Model;

export function agentWorkPort(agent: Agent): AgentWorkPort {
	const prompt: SessionWorkController["prompt"] = (input) => {
		const operation = agent.prompt(input);
		return operation.then(
			(result) =>
				({
					itemId: "root",
					dependencies: [],
					runtimeId: "test-worker",
					sessionId: "test-session",
					state: result.outcome === "success" ? "succeeded" : result.outcome === "aborted" ? "canceled" : "failed",
					run: {
						runId: result.runId,
						outcome: result.outcome,
						...(result.failure ? { failure: result.failure } : {}),
					},
					placement: {
						placementId: "test-placement",
						root: "/test",
						baseIdentity: "test",
						kind: "memory",
					},
					publication: { state: "not_required" },
					diagnostics: [],
					timing: { acceptedAt: 0, settledAt: 0 },
					budget: { modelAttempts: 0, toolInvocations: 0, totalTokens: 0, elapsedMs: 0 },
				}) as unknown as WorkResult,
		);
	};
	return {
		state: () => ({
			closed: false,
			status: agent.state.status,
			...(agent.state.activeRun ? { activeRun: agent.state.activeRun } : {}),
			messages: agent.state.messages,
			pendingSteering: agent.state.pendingSteering,
			pendingFollowUps: agent.state.pendingFollowUps,
			...(agent.state.lastRun ? { lastRun: agent.state.lastRun } : {}),
			selection: { model, reasoning: "off" },
		}),
		isBusy: () => agent.state.status !== "idle",
		beginPrompt: async (input, resources) => ({ result: prompt(input, resources) }),
		prompt,
		deliver: async (kind, input) => {
			if (kind === "steering") agent.steer(input);
			else agent.followUp(input);
		},
		cancel: async () => {
			try {
				agent.abort();
			} catch (error) {
				if (!(error instanceof AgentError && error.code === "invalid_lifecycle")) throw error;
			}
		},
		waitForIdle: () => agent.waitForIdle(),
		subscribe: (listener) => agent.onEvent(listener),
	};
}
