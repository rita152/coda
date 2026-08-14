import { Agent, AgentError, type AgentInput, type PreparedRun, type QueueItemId } from "@coda/agent";
import type {
	AgentRuntime,
	AgentRuntimeEvent,
	AgentRuntimeListener,
	AgentRuntimeSnapshot,
	OpenAgentRuntimeOptions,
	RuntimeCommand,
	RuntimeCommandResult,
	RuntimeId,
	RuntimePreparedRun,
	RuntimeSessionId,
} from "./types.ts";

function immutableConfiguration<TConfiguration extends object>(
	configuration: TConfiguration,
): Readonly<TConfiguration> {
	return Object.freeze({ ...configuration });
}

function immutableSnapshot<TSnapshot>(snapshot: TSnapshot): Readonly<TSnapshot> {
	if (typeof snapshot === "object" && snapshot !== null) {
		return Object.freeze({ ...snapshot }) as Readonly<TSnapshot>;
	}
	return snapshot as Readonly<TSnapshot>;
}

class DefaultAgentRuntime<TConfiguration extends object, TActiveSnapshot>
	implements AgentRuntime<TConfiguration, TActiveSnapshot>
{
	readonly runtimeId: RuntimeId;
	readonly sessionId: RuntimeSessionId;
	readonly #options: OpenAgentRuntimeOptions<TConfiguration, TActiveSnapshot>;
	readonly #agent: Agent;
	readonly #listeners = new Set<AgentRuntimeListener>();
	readonly #detachEvents: () => void;
	#desired: Readonly<TConfiguration>;
	#active?: AgentRuntimeSnapshot<TConfiguration, TActiveSnapshot>["activeRun"];
	#closed = false;
	#closeOperation?: Promise<void>;

	constructor(options: OpenAgentRuntimeOptions<TConfiguration, TActiveSnapshot>) {
		this.#options = options;
		this.runtimeId = String(options.runtimeId) as RuntimeId;
		this.sessionId = String(options.session.id) as RuntimeSessionId;
		if (this.runtimeId.length === 0) throw new Error("Agent Runtime identity must not be empty");
		if (this.sessionId.length === 0) throw new Error("Runtime Session identity must not be empty");
		this.#desired = immutableConfiguration(options.configuration);
		this.#agent = new Agent({
			clock: options.clock,
			idGenerator: options.idGenerator,
			prepareRun: async (preparation) => {
				this.#assertOpen();
				const configuration = this.#desired;
				const candidate = await options.prepareRun({
					...preparation,
					runtimeId: this.runtimeId,
					sessionId: this.sessionId,
					configuration,
				});
				const prepared = immutableSnapshot(candidate.snapshot);
				this.#active = Object.freeze({
					runId: String(preparation.runId),
					configuration,
					prepared,
				});
				const dispose = candidate.dispose;
				const run: RuntimePreparedRun<TActiveSnapshot> = Object.freeze({
					stream: candidate.stream,
					tools: candidate.tools,
					...(candidate.systemPrompt === undefined ? {} : { systemPrompt: candidate.systemPrompt }),
					...(candidate.recoverFailedAttempt === undefined
						? {}
						: { recoverFailedAttempt: candidate.recoverFailedAttempt }),
					snapshot: prepared,
					dispose: async () => {
						try {
							await dispose?.();
						} finally {
							if (this.#active?.runId === String(preparation.runId)) this.#active = undefined;
						}
					},
				});
				return run as PreparedRun;
			},
			...(options.retry === undefined ? {} : { retry: options.retry }),
			...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
			...(options.session.seed === undefined ? {} : { seed: options.session.seed }),
			...(options.autoDrainFollowUps === undefined ? {} : { autoDrainFollowUps: options.autoDrainFollowUps }),
		});
		this.#detachEvents = this.#agent.onEvent(async (event) => {
			const failures: unknown[] = [];
			try {
				await options.session.accept(event);
			} catch (error) {
				failures.push(error);
			}
			const routed: AgentRuntimeEvent = Object.freeze({
				type: "agent",
				runtimeId: this.runtimeId,
				sessionId: this.sessionId,
				runId: String(event.runId),
				event,
			});
			for (const listener of [...this.#listeners]) {
				try {
					await listener(routed);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Agent Runtime event routing failed");
		});
	}

	snapshot(): AgentRuntimeSnapshot<TConfiguration, TActiveSnapshot> {
		return Object.freeze({
			runtimeId: this.runtimeId,
			sessionId: this.sessionId,
			closed: this.#closed,
			desired: this.#desired,
			...(this.#active === undefined ? {} : { activeRun: this.#active }),
			agent: this.#agent.state,
		});
	}

	updateConfiguration(configuration: TConfiguration): void {
		this.#assertOpen();
		this.#desired = immutableConfiguration(configuration);
	}

	prompt(input: AgentInput) {
		this.#assertOpen();
		return this.#agent.prompt(input);
	}

	steer(input: AgentInput): QueueItemId {
		this.#assertOpen();
		return this.#agent.steer(input);
	}

	followUp(input: AgentInput): QueueItemId {
		this.#assertOpen();
		return this.#agent.followUp(input);
	}

	cancel(queueItemId?: QueueItemId): void {
		this.#assertOpen();
		if (queueItemId === undefined) this.#agent.abort();
		else this.#agent.cancelQueueItem(queueItemId);
	}

	dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult> {
		switch (command.type) {
			case "prompt":
				return this.prompt(command.input);
			case "steer":
				return Promise.resolve(this.steer(command.input));
			case "follow_up":
				return Promise.resolve(this.followUp(command.input));
			case "run_next_follow_up":
				this.#assertOpen();
				return this.#agent.runNextFollowUp();
			case "resume_follow_ups":
				this.#assertOpen();
				return this.#agent.resumeFollowUps();
			case "cancel":
				this.cancel(command.queueItemId);
				return Promise.resolve(undefined);
		}
	}

	waitForIdle(): Promise<void> {
		return this.#agent.waitForIdle();
	}

	subscribe(listener: AgentRuntimeListener): () => void {
		this.#assertOpen();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.#closeOperation) return this.#closeOperation;
		this.#closed = true;
		const operation = (async () => {
			const failures: unknown[] = [];
			if (this.#agent.state.status === "running") {
				try {
					this.#agent.abort();
				} catch (error) {
					if (!(error instanceof AgentError && error.code === "invalid_lifecycle")) failures.push(error);
				}
			}
			try {
				await this.#agent.waitForIdle();
			} catch (error) {
				failures.push(error);
			}
			this.#detachEvents();
			try {
				await this.#options.session.close();
			} catch (error) {
				failures.push(error);
			}
			const closed: AgentRuntimeEvent = Object.freeze({
				type: "closed",
				runtimeId: this.runtimeId,
				sessionId: this.sessionId,
			});
			for (const listener of [...this.#listeners]) {
				try {
					await listener(closed);
				} catch (error) {
					failures.push(error);
				}
			}
			this.#listeners.clear();
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Agent Runtime close failed");
		})();
		this.#closeOperation = operation;
		return operation;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error(`Agent Runtime ${this.runtimeId} is closed`);
	}
}

export async function openAgentRuntime<TConfiguration extends object, TActiveSnapshot>(
	options: OpenAgentRuntimeOptions<TConfiguration, TActiveSnapshot>,
): Promise<AgentRuntime<TConfiguration, TActiveSnapshot>> {
	return new DefaultAgentRuntime(options);
}
