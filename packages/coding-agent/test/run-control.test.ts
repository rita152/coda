import type { AgentTool, Clock, IdGenerator, IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type TimeRuntime, Type } from "@coda/ai";
import type { WorkerControlEvent } from "@coda/runtime";
import type { ScheduledTask, Scheduler } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { bindAgentRunControl, RunControl, RunProgressTracker } from "../src/run-control/index.ts";
import { withRunControlEvidence } from "../src/run-evidence/run-evidence.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { agentWorkPort, createTestAgent } from "./agent-runtime-adapter.ts";

interface ManualTask extends ScheduledTask {
	readonly dueAt: number;
	readonly run: () => void | Promise<void>;
	cancelled: boolean;
	ran: boolean;
}

class ManualTime implements Clock, Scheduler {
	#now = 0;
	readonly tasks: ManualTask[] = [];

	now(): number {
		return this.#now;
	}

	schedule(delayMs: number, run: () => void | Promise<void>): ScheduledTask {
		const task: ManualTask = {
			dueAt: this.#now + delayMs,
			run,
			cancelled: false,
			ran: false,
			cancel() {
				this.cancelled = true;
			},
		};
		this.tasks.push(task);
		return task;
	}

	get pending(): number {
		return this.tasks.filter((task) => !task.cancelled && !task.ran).length;
	}

	async advanceBy(durationMs: number): Promise<void> {
		this.#now += durationMs;
		while (true) {
			const next = this.tasks
				.filter((task) => !task.cancelled && !task.ran && task.dueAt <= this.#now)
				.sort((left, right) => left.dueAt - right.dueAt)[0];
			if (!next) return;
			next.ran = true;
			await next.run();
		}
	}
}

class TestIds implements IdGenerator {
	#next = 0;

	generate(kind: IdKind): string {
		return `${kind}:${++this.#next}`;
	}
}

function timeRuntime(clock: Clock): TimeRuntime {
	return {
		clock,
		random: { next: () => 0 },
		sleep: { wait: async () => undefined },
	};
}

describe("RunControl", () => {
	it("requests wrap-up exactly once, enters finalizing at a boundary, and hard-stops after grace", async () => {
		const time = new ManualTime();
		const requests: string[] = [];
		const stops: string[] = [];
		const control = new RunControl({
			configuration: { workDurationMs: 100, graceDurationMs: 25, maxStationaryTurns: 3 },
			clock: time,
			scheduler: time,
			requestWrapUp: (trigger) => requests.push(trigger),
			hardStop: (reason) => stops.push(reason),
		});

		await time.advanceBy(100);
		expect(requests).toEqual(["work_deadline"]);
		expect(control.report()).toMatchObject({
			phase: "wrap_up_requested",
			reason: "work_deadline",
			trigger: "work_deadline",
			wrapUpRequestedAt: 100,
			graceDeadlineAt: 125,
		});
		expect(control.requestWrapUp("stagnation")).toBe(false);
		expect(requests).toEqual(["work_deadline"]);
		expect(control.markFinalizing()).toBe(true);
		expect(control.report().phase).toBe("finalizing");

		await time.advanceBy(25);
		expect(stops).toEqual(["grace_deadline_exceeded"]);
		expect(control.report()).toMatchObject({
			phase: "terminal",
			reason: "grace_deadline_exceeded",
			terminalAt: 125,
		});
		expect(time.pending).toBe(0);
	});

	it("cancels every timer on normal completion", async () => {
		const time = new ManualTime();
		const requests: string[] = [];
		const control = new RunControl({
			configuration: { workDurationMs: 100, graceDurationMs: 50 },
			clock: time,
			scheduler: time,
			requestWrapUp: (trigger) => requests.push(trigger),
			hardStop: () => {
				throw new Error("normal completion must cancel the hard stop");
			},
		});

		control.complete(20);
		expect(control.report()).toMatchObject({ phase: "terminal", reason: "run_ended", terminalAt: 20 });
		expect(time.pending).toBe(0);
		await time.advanceBy(1_000);
		expect(requests).toEqual([]);
	});

	it("keeps the grace stop absolute when the work timer is delivered late", async () => {
		const time = new ManualTime();
		const requests: string[] = [];
		const stops: string[] = [];
		const control = new RunControl({
			configuration: { workDurationMs: 100, graceDurationMs: 25 },
			clock: time,
			scheduler: time,
			requestWrapUp: (trigger) => requests.push(trigger),
			hardStop: (reason) => stops.push(reason),
		});

		await time.advanceBy(200);
		expect(requests).toEqual(["work_deadline"]);
		expect(stops).toEqual(["grace_deadline_exceeded"]);
		expect(control.report()).toMatchObject({
			workDeadlineAt: 100,
			graceDeadlineAt: 125,
			phase: "terminal",
			reason: "grace_deadline_exceeded",
		});
	});

	it("drives wrap-up and hard-stop from the reliable Control lifecycle alone", async () => {
		const time = new ManualTime();
		const deliveries: string[] = [];
		let cancellations = 0;
		let listener!: (event: WorkerControlEvent) => Promise<void> | void;
		const binding = bindAgentRunControl({
			work: {
				deliver: async (_kind, input) => {
					deliveries.push(String(input));
				},
				cancel: async () => {
					cancellations++;
				},
				subscribeControl: (next) => {
					listener = next;
					return () => undefined;
				},
				subscribeResult: () => () => undefined,
			},
			configuration: { workDurationMs: 100, graceDurationMs: 25 },
			clock: time,
			scheduler: time,
		});
		listener({
			type: "run_start",
			runId: "run:control",
			sequence: 1,
			timestamp: 0,
			source: "prompt",
			inputMessage: {
				id: "message:control",
				message: { role: "user", content: "start", timestamp: 0 },
			},
		} as unknown as WorkerControlEvent);

		await time.advanceBy(100);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("RunControl requested finalization");
		await time.advanceBy(25);
		expect(cancellations).toBe(1);
		binding.dispose();
	});

	it("closes the active Control when its Work Item settles without a durable run_end Control event", async () => {
		const time = new ManualTime();
		let listener!: (event: WorkerControlEvent) => Promise<void> | void;
		let settle!: (result: import("@coda/runtime").WorkResult) => Promise<void> | void;
		let deliveries = 0;
		let cancellations = 0;
		const binding = bindAgentRunControl({
			work: {
				deliver: async () => {
					deliveries++;
				},
				cancel: async () => {
					cancellations++;
				},
				subscribeControl: (next) => {
					listener = next;
					return () => undefined;
				},
				subscribeResult: (next) => {
					settle = next;
					return () => undefined;
				},
			},
			configuration: { workDurationMs: 100, graceDurationMs: 25 },
			clock: time,
			scheduler: time,
		});
		listener({
			type: "run_start",
			runId: "run:barrier-failed",
			sequence: 1,
			timestamp: 0,
			source: "prompt",
			inputMessage: { id: "message:1", message: { role: "user", content: "start", timestamp: 0 } },
		} as unknown as WorkerControlEvent);
		settle({ timing: { acceptedAt: 0, settledAt: 10 } } as import("@coda/runtime").WorkResult);

		await time.advanceBy(1_000);
		expect(deliveries).toBe(0);
		expect(cancellations).toBe(0);
		expect(binding.reportForRun("run:barrier-failed")).toMatchObject({
			phase: "terminal",
			reason: "work_item_settled",
			terminalAt: 10,
		});
		expect(time.pending).toBe(0);
		binding.dispose();
	});

	it("resets stationarity only for novel workspace, verification, read, failure, or requirement evidence", () => {
		const tracker = new RunProgressTracker();
		const settle = () => {
			tracker.beginTurn();
			return tracker.finishTurn();
		};

		expect(settle()).toBe(1);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "read", fingerprint: "read:a" })).toBe(true);
		expect(tracker.finishTurn()).toBe(0);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "read", fingerprint: "read:a" })).toBe(false);
		expect(tracker.finishTurn()).toBe(1);

		tracker.beginTurn();
		expect(tracker.observe({ kind: "workspace_content", path: "a.ts", digest: "sha:a" })).toBe(true);
		expect(tracker.finishTurn()).toBe(0);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "workspace_content", path: "a.ts", digest: "sha:a" })).toBe(false);
		expect(tracker.finishTurn()).toBe(1);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "workspace_content", path: "a.ts", digest: "sha:b" })).toBe(true);
		expect(tracker.finishTurn()).toBe(0);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "workspace_content", path: "a.ts", digest: "sha:a" })).toBe(false);
		expect(tracker.finishTurn()).toBe(1);

		tracker.beginTurn();
		expect(tracker.observe({ kind: "verification", target: "npm test", status: "failed" })).toBe(true);
		expect(tracker.finishTurn()).toBe(0);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "verification", target: "npm test", status: "failed" })).toBe(false);
		expect(tracker.finishTurn()).toBe(1);
		tracker.beginTurn();
		expect(tracker.observe({ kind: "verification", target: "npm test", status: "passed" })).toBe(true);
		expect(tracker.finishTurn()).toBe(0);

		tracker.beginTurn();
		expect(tracker.observe({ kind: "failure", fingerprint: "edit:no_match" })).toBe(true);
		expect(tracker.observe({ kind: "failure", fingerprint: "edit:no_match" })).toBe(false);
		expect(tracker.observe({ kind: "requirement_evidence", requirementId: "R1", evidenceId: "test:a" })).toBe(true);
		expect(tracker.observe({ kind: "requirement_evidence", requirementId: "R1", evidenceId: "test:a" })).toBe(false);
		expect(tracker.finishTurn()).toBe(0);
	});

	it("enters wrap-up after settled stationary Turns without treating an in-flight Tool as another Turn", async () => {
		const time = new ManualTime();
		const requests: string[] = [];
		const control = new RunControl({
			configuration: { workDurationMs: 10_000, graceDurationMs: 100, maxStationaryTurns: 2 },
			clock: time,
			scheduler: time,
			requestWrapUp: (trigger) => requests.push(trigger),
			hardStop: () => undefined,
		});

		control.beginTurn();
		await time.advanceBy(5_000);
		expect(control.report().progress.consecutiveStationaryTurns).toBe(0);
		expect(requests).toEqual([]);
		expect(control.finishTurn()).toBe(1);
		control.beginTurn();
		expect(control.finishTurn()).toBe(2);
		expect(requests).toEqual(["stagnation"]);
		expect(control.report()).toMatchObject({ phase: "wrap_up_requested", trigger: "stagnation" });
	});

	it("queues deadline Steering behind a long Tool and consumes it at the next model boundary", async () => {
		const time = new ManualTime();
		const runtime = timeRuntime(time);
		const faux = createFauxCore({ runtime, chunkCharacters: 100 });
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let notifyStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		let toolAborted = false;
		const parameters = Type.Object({ path: Type.String() });
		const slowTool: AgentTool<typeof parameters> = {
			name: "slow",
			description: "A deliberately slow Tool",
			parameters,
			replaySafety: "safe",
			execute: async (_arguments, context) => {
				notifyStarted();
				context.signal.addEventListener("abort", () => {
					toolAborted = true;
				});
				await toolGate;
				return { content: "settled", observation: { status: "ok", truncated: false } };
			},
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", { path: "a" }, { id: "slow:1" }), {
				stopReason: "toolUse",
				timestamp: 0,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({ role: "user" });
				expect(JSON.stringify(context.messages.at(-1))).toContain("RunControl requested finalization");
				return fauxAssistantMessage("wrapped up", { timestamp: time.now() });
			},
		]);
		const agent = createTestAgent({
			clock: time,
			idGenerator: new TestIds(),
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			tools: [slowTool],
		});
		const binding = bindAgentRunControl({
			work: agentWorkPort(agent),
			configuration: { workDurationMs: 100, graceDurationMs: 500, maxStationaryTurns: 4 },
			clock: time,
			scheduler: time,
		});
		const phases: string[] = [];
		agent.onSemanticEvent((event) => {
			if (event.type === "turn_start") phases.push(binding.reportForRun(String(event.runId))?.phase ?? "missing");
		});

		const operation = agent.prompt("start");
		await toolStarted;
		await time.advanceBy(100);
		const runId = String(agent.state.activeRun?.id);
		expect(binding.reportForRun(runId)?.phase).toBe("wrap_up_requested");
		expect(agent.state.pendingSteering).toHaveLength(1);
		expect(toolAborted).toBe(false);

		releaseTool();
		await expect(operation).resolves.toMatchObject({ outcome: "success" });
		expect(phases).toEqual(["running", "finalizing"]);
		expect(binding.reportForRun(runId)).toMatchObject({
			phase: "terminal",
			reason: "run_ended",
			trigger: "work_deadline",
		});
		expect(time.pending).toBe(0);
		binding.dispose();
	});

	it("aborts an in-flight Tool only at the grace deadline and preserves the explicit stop reason", async () => {
		const time = new ManualTime();
		const runtime = timeRuntime(time);
		const faux = createFauxCore({ runtime, chunkCharacters: 100 });
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let notifyStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		let toolAborted = false;
		const parameters = Type.Object({});
		const slowTool: AgentTool<typeof parameters> = {
			name: "slow",
			description: "A deliberately slow Tool",
			parameters,
			replaySafety: "safe",
			execute: async (_arguments, context) => {
				notifyStarted();
				context.signal.addEventListener("abort", () => {
					toolAborted = true;
				});
				await toolGate;
				return { content: "settled", observation: { status: "ok", truncated: false } };
			},
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}, { id: "slow:1" }), {
				stopReason: "toolUse",
				timestamp: 0,
			}),
		]);
		const agent = createTestAgent({
			clock: time,
			idGenerator: new TestIds(),
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			tools: [slowTool],
		});
		const binding = bindAgentRunControl({
			work: agentWorkPort(agent),
			configuration: { workDurationMs: 100, graceDurationMs: 25 },
			clock: time,
			scheduler: time,
		});
		const session = await new InMemorySessionManager({ clock: time, idGenerator: new TestIds() }).open({
			workspace: { id: "workspace", path: "/workspace" },
			mode: "interactive",
		});
		agent.onSemanticEvent((event) => session.accept(event));

		const operation = agent.prompt("start");
		await toolStarted;
		const runId = String(agent.state.activeRun?.id);
		await time.advanceBy(100);
		expect(agent.state.pendingSteering).toHaveLength(1);
		expect(toolAborted).toBe(false);

		await time.advanceBy(25);
		expect(toolAborted).toBe(true);
		expect(binding.reportForRun(runId)).toMatchObject({
			phase: "terminal",
			reason: "grace_deadline_exceeded",
			trigger: "work_deadline",
			terminalAt: 125,
		});

		releaseTool();
		await expect(operation).resolves.toMatchObject({ outcome: "aborted" });
		expect(binding.reportForRun(runId)).toMatchObject({
			phase: "terminal",
			reason: "grace_deadline_exceeded",
		});
		const runControl = binding.reportForRun(runId);
		expect(runControl).toBeDefined();
		expect(withRunControlEvidence(session.runEvidence.at(-1)!, runControl!)).toMatchObject({
			schemaVersion: 4,
			outcome: "aborted",
			runControl: {
				phase: "terminal",
				reason: "grace_deadline_exceeded",
				trigger: "work_deadline",
			},
		});
		expect(time.pending).toBe(0);
		binding.dispose();
		await session.close();
	});
});
