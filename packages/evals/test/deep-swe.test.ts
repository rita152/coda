import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertDeepSwePaidRun,
	compareDeepSweRounds,
	createDeepSwePierJobConfig,
	createDeepSweRunLock,
	DEEP_SWE_DATASET_REVISION,
	DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
	DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
	DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
	DEEP_SWE_FIRST_20_IMAGE_LOCKS,
	DEEP_SWE_FIRST_20_TASK_IDS,
	DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
	formatDeepSweImageLockTsv,
	readDeepSweEvaluationReport,
	reduceDeepSweJsonlLines,
	summarizeDeepSweJobResult,
	validateDeepSweRunControlEnvelope,
} from "../src/index.ts";

const OPTIONS = {
	datasetDir: "/srv/coda-evals/deep-swe/tasks",
	runtimeDir: "/srv/coda-evals/runtime",
	jobsDir: "/srv/coda-evals/jobs",
	harnessRevision: "abc1234-runtime",
	round: 1,
	concurrency: 5,
	maxOutputTokens: 32_768,
	maxTurns: 96,
	allowAllCommands: true,
} as const;

describe("DeepSWE evaluation runner", () => {
	it("prepares status and the task Git identity before Coda starts", () => {
		const adapter = readFileSync(new URL("../pier/coda_agent.py", import.meta.url), "utf8");
		const prepareStatus = adapter.indexOf("artifacts.prepare()");
		const preflight = adapter.indexOf("command=self._repository_preflight_command()", prepareStatus);
		const markRunning = adapter.indexOf("artifacts.mark_running()", preflight);
		const agentStart = adapter.indexOf("command=self._coda_command(agent_dir)", markRunning);
		const userName = adapter.indexOf("config user.name coda-evals");
		const userEmail = adapter.indexOf("config user.email coda-evals@localhost");

		expect(prepareStatus).toBeGreaterThanOrEqual(0);
		expect(preflight).toBeGreaterThan(prepareStatus);
		expect(markRunning).toBeGreaterThan(preflight);
		expect(agentStart).toBeGreaterThan(markRunning);
		expect(userName).toBeGreaterThan(agentStart);
		expect(userEmail).toBeGreaterThan(userName);
		expect(adapter.indexOf("config user.name coda-evals", userName + 1)).toBe(-1);
		expect(adapter.indexOf("config user.email coda-evals@localhost", userEmail + 1)).toBe(-1);
		expect(adapter).toContain('event_stream_mode: str = "semantic"');
		expect(adapter).toContain("--json-mode {shlex.quote(self._event_stream_mode)}");
		expect(adapter).toContain("--run-control-work-ms {self._run_control_work_sec * 1000}");
		expect(adapter).toContain("--run-control-grace-ms {self._run_control_grace_sec * 1000}");
		expect(adapter).toContain("artifacts.finalize(");
		expect(adapter).not.toContain("def _write_trajectory(");
	});

	it("pins the current v1.1 dataset and selects the first 20 tasks explicitly", () => {
		expect(DEEP_SWE_DATASET_REVISION).toBe("435ee89ec2f2e2289f33b0da4f992f0b7b7266b9");
		expect(DEEP_SWE_FIRST_20_TASK_IDS).toHaveLength(20);
		expect(DEEP_SWE_FIRST_20_TASK_IDS).toEqual([...DEEP_SWE_FIRST_20_TASK_IDS].sort());
		expect(new Set(DEEP_SWE_FIRST_20_TASK_IDS).size).toBe(20);
		expect(DEEP_SWE_FIRST_20_IMAGE_LOCKS).toHaveLength(20);
		for (const lock of DEEP_SWE_FIRST_20_IMAGE_LOCKS) {
			expect(lock.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
		expect(formatDeepSweImageLockTsv().trim().split("\n")).toHaveLength(20);
	});

	it("generates a secret-free Pier job with custom concurrency and a Coda adapter", () => {
		const config = createDeepSwePierJobConfig({ ...OPTIONS, concurrency: 7, taskIds: ["abs-stepped-slices"] });

		expect(config.n_concurrent_trials).toBe(7);
		expect(config.n_attempts).toBe(1);
		expect(config.agents[0]).toMatchObject({
			import_path: "coda_agent:CodaAgent",
			model_name: "opencode-go/deepseek-v4-flash",
			kwargs: {
				reasoning_effort: "max",
				max_output_tokens: 32_768,
				event_stream_mode: "semantic",
				max_turns: 96,
				run_control_work_sec: DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
				run_control_grace_sec: DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
				run_control_stationary_turns: 4,
				adapter_finalize_margin_sec: DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
				pier_hard_timeout_sec: DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
				allow_all_commands: true,
			},
			env: { OPENCODE_API_KEY: `$${"{OPENCODE_API_KEY}"}`, NODE_USE_ENV_PROXY: "1" },
		});
		expect(config.agents[0].max_timeout_sec).toBe(DEEP_SWE_PIER_HARD_TIMEOUT_SEC);
		expect(config.datasets[0]).toEqual({ path: OPTIONS.datasetDir, task_names: ["abs-stepped-slices"] });
		expect(JSON.stringify(config)).not.toContain("sk-");
	});

	it("records each round separately and labels repeated tasks as development data", () => {
		const lock = createDeepSweRunLock({ ...OPTIONS, round: 4 });
		expect(lock.schemaVersion).toBe(2);
		expect(lock.campaignKind).toBe("development-round");
		expect(lock.harness.maxOutputTokens).toBe(32_768);
		expect(lock.harness.eventStream).toEqual({ mode: "semantic", schemaVersion: 1 });
		expect(lock.harness.maxTurns).toBe(96);
		expect(lock.harness.allowAllCommands).toBe(true);
		expect(lock.harness.runControl).toEqual({
			workSec: DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
			graceSec: DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
			maxStationaryTurns: 4,
			adapterFinalizeMarginSec: DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
			pierHardTimeoutSec: DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
		});
		expect(lock.execution).toMatchObject({ round: 4, concurrency: 5, providerAllowlist: ["opencode.ai"] });
		expect(lock.execution.taskIds).toEqual(DEEP_SWE_FIRST_20_TASK_IDS);
		expect(lock.images).toHaveLength(20);
	});

	it("records a true no-budget round with the model's 384k output limit", () => {
		const options = {
			...OPTIONS,
			round: 5,
			maxOutputTokens: 384_000,
			disableRunBudget: true,
		};
		const config = createDeepSwePierJobConfig(options);
		const lock = createDeepSweRunLock(options);

		expect(config.agents[0].kwargs).toMatchObject({
			max_output_tokens: 384_000,
			run_budget_enabled: false,
			run_control_work_sec: DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
			run_control_grace_sec: DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
		});
		expect(config.agents[0].kwargs).not.toHaveProperty("max_turns");
		expect(lock.harness).toMatchObject({
			maxOutputTokens: 384_000,
			runBudgetEnabled: false,
		});
		expect(lock.harness).not.toHaveProperty("maxTurns");
	});

	it("rejects invalid concurrency, globs, duplicate tasks, and relative paths", () => {
		expect(() => createDeepSwePierJobConfig({ ...OPTIONS, concurrency: 0 })).toThrow("concurrency");
		expect(() => createDeepSwePierJobConfig({ ...OPTIONS, taskIds: ["abs-*"] })).toThrow("literal");
		expect(() =>
			createDeepSwePierJobConfig({ ...OPTIONS, taskIds: ["abs-stepped-slices", "abs-stepped-slices"] }),
		).toThrow("unique");
		expect(() => createDeepSwePierJobConfig({ ...OPTIONS, jobsDir: "jobs" })).toThrow("absolute");
	});

	it("requires work + grace + adapter finalize margin to remain below Pier's hard timeout", () => {
		expect(
			validateDeepSweRunControlEnvelope({
				workSec: DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
				graceSec: DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
				adapterFinalizeMarginSec: DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
				pierHardTimeoutSec: DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
			}),
		).toEqual({
			workSec: 4_500,
			graceSec: 600,
			adapterFinalizeMarginSec: 240,
			pierHardTimeoutSec: 5_400,
		});
		expect(() =>
			createDeepSwePierJobConfig({
				...OPTIONS,
				runControlWorkSec: 4_500,
				runControlGraceSec: 600,
				adapterFinalizeMarginSec: 300,
				pierHardTimeoutSec: 5_400,
			}),
		).toThrow("workSec + graceSec + adapterFinalizeMarginSec < pierHardTimeoutSec");
	});

	it("fails closed before paid requests unless all three opt-ins are present", () => {
		expect(() => assertDeepSwePaidRun({ allowPaidRequests: false, confirmed: true, hasApiKey: true })).toThrow(
			"CODA_EVALS_DEEP_SWE",
		);
		expect(() => assertDeepSwePaidRun({ allowPaidRequests: true, confirmed: false, hasApiKey: true })).toThrow(
			"--confirm-spend",
		);
		expect(() => assertDeepSwePaidRun({ allowPaidRequests: true, confirmed: true, hasApiKey: false })).toThrow(
			"OPENCODE_API_KEY",
		);
		expect(() => assertDeepSwePaidRun({ allowPaidRequests: true, confirmed: true, hasApiKey: true })).not.toThrow();
	});

	it("separates job wall time from concurrent cumulative trial time", () => {
		const report = summarizeDeepSweJobResult({
			started_at: "2026-08-12T00:00:00Z",
			finished_at: "2026-08-12T00:01:40Z",
			trial_results: [
				{
					task_name: "a-task",
					trial_name: "a-task__one",
					started_at: "2026-08-12T00:00:05Z",
					finished_at: "2026-08-12T00:01:25Z",
					agent_result: { metadata: { run_outcome: "success", elapsed_ms: 80_000 } },
				},
				{
					task_name: "b-task",
					trial_name: "b-task__one",
					started_at: "2026-08-12T00:00:15Z",
					finished_at: "2026-08-12T00:01:35Z",
					agent_result: { metadata: { run_outcome: "success", elapsed_ms: 80_000 } },
				},
			],
		});

		expect(report.summary.wallElapsedMs).toBe(100_000);
		expect(report.summary.cumulativeTrialElapsedMs).toEqual({
			knownTotal: 160_000,
			observedTrials: 2,
			expectedTrials: 2,
			status: "complete",
			sources: ["pier_result"],
		});
		expect(report.summary.cumulativeAgentElapsedMs).toEqual({
			knownTotal: 160_000,
			observedTrials: 2,
			expectedTrials: 2,
			status: "complete",
			sources: ["run_evidence"],
		});
	});

	it("distinguishes a measured zero from missing resource data", () => {
		const completeZero = summarizeDeepSweJobResult({
			trial_results: [
				{
					task_name: "zero-task",
					trial_name: "zero-task__one",
					agent_result: {
						n_input_tokens: 0,
						n_cache_tokens: 0,
						n_output_tokens: 0,
						cost_usd: 0,
						n_agent_steps: 0,
						metadata: { run_outcome: "success", elapsed_ms: 0 },
					},
				},
			],
		});
		expect(completeZero.summary.inputTokens).toMatchObject({
			knownTotal: 0,
			observedTrials: 1,
			status: "complete",
		});
		expect(completeZero.summary.costUsd).toMatchObject({ knownTotalUsd: 0, status: "complete" });
		expect(completeZero.summary.turnCount).toMatchObject({ knownTotal: 0, status: "complete" });
		expect(completeZero.summary.cumulativeAgentElapsedMs).toMatchObject({ knownTotal: 0, status: "complete" });

		const unavailable = summarizeDeepSweJobResult({
			trial_results: [{ task_name: "missing-task", trial_name: "missing-task__one" }],
		});
		expect(unavailable.summary.inputTokens).toMatchObject({
			knownTotal: null,
			observedTrials: 0,
			status: "unavailable",
		});
		expect(unavailable.summary.costUsd).toMatchObject({ knownTotalUsd: null, status: "unavailable" });
	});

	it("keeps pass rate on observed trials while exposing an incomplete expected count", () => {
		const report = summarizeDeepSweJobResult({
			n_total_trials: 2,
			trial_results: [
				{
					task_name: "observed-task",
					trial_name: "observed-task__one",
					verifier_result: { rewards: { reward: 1 } },
				},
			],
		});
		expect(report.summary).toMatchObject({ trials: 1, expectedTrials: 2, passRate: 1 });
		expect(report.summary.inputTokens).toMatchObject({ expectedTrials: 2, status: "unavailable" });
	});

	it("recovers partial Attempt resources with a constant-space line reducer", async () => {
		async function* eventLines(): AsyncGenerator<string> {
			yield JSON.stringify({ type: "run_start", timestamp: 1_000 });
			for (let index = 0; index < 10_000; index++) {
				yield JSON.stringify({ type: "message_update", timestamp: 1_001, delta: { type: "text_delta" } });
			}
			yield JSON.stringify({ type: "turn_start", timestamp: 1_100 });
			yield JSON.stringify({
				type: "attempt_end",
				timestamp: 2_000,
				candidate: {
					message: {
						stopReason: "length",
						usage: {
							input: 10,
							cacheRead: 3,
							cacheWrite: 2,
							output: 4,
							cost: { total: 0.1 },
						},
					},
				},
			});
			yield JSON.stringify({
				type: "attempt_end",
				timestamp: 3_000,
				candidate: {
					message: {
						usage: { input: 20, output: 6 },
					},
				},
			});
			yield "{truncated";
		}

		const reduction = await reduceDeepSweJsonlLines(eventLines());
		expect(reduction.resources.inputTokens).toEqual({
			knownTotal: 35,
			status: "partial",
			source: "terminal_events",
		});
		expect(reduction.resources.cacheTokens.knownTotal).toBe(3);
		expect(reduction.resources.outputTokens.knownTotal).toBe(10);
		expect(reduction.resources.costUsd).toEqual({
			knownTotalUsd: 0.1,
			status: "partial",
			source: "terminal_events",
			pricedAttempts: 1,
			unpricedAttempts: 1,
			attemptCoverage: "partial",
		});
		expect(reduction.resources.turnCount).toMatchObject({ knownTotal: 1, status: "partial" });
		expect(reduction.resources.agentElapsedMs).toMatchObject({ knownTotal: 2_000, status: "partial" });
		expect(reduction.lengthTruncationCount).toBe(1);

		async function* zeroStepRun(): AsyncGenerator<string> {
			yield JSON.stringify({ type: "run_start", timestamp: 5_000 });
		}
		const zeroStepReduction = await reduceDeepSweJsonlLines(zeroStepRun());
		expect(zeroStepReduction.resources.turnCount).toEqual({
			knownTotal: 0,
			status: "partial",
			source: "terminal_events",
		});
	});

	it("keeps partial Run Evidence cost explicitly incomplete", async () => {
		async function* eventLines(): AsyncGenerator<string> {
			yield JSON.stringify({ type: "run_start", timestamp: 1_000 });
			yield JSON.stringify({ type: "turn_start", timestamp: 1_100 });
			yield JSON.stringify({
				type: "run_evidence",
				elapsedMs: 500,
				usage: {
					inputTokens: 4,
					cacheReadTokens: 5,
					cacheWriteTokens: 6,
					outputTokens: 7,
					cost: {
						status: "partial",
						knownTotalUsd: 0.25,
						pricedAttempts: 1,
						unpricedAttempts: 2,
					},
				},
			});
		}

		const reduction = await reduceDeepSweJsonlLines(eventLines());
		expect(reduction.resources.inputTokens).toEqual({
			knownTotal: 15,
			status: "complete",
			source: "run_evidence",
		});
		expect(reduction.resources.costUsd).toMatchObject({
			knownTotalUsd: 0.25,
			status: "partial",
			pricedAttempts: 1,
			unpricedAttempts: 2,
			attemptCoverage: "complete",
		});
	});

	it("upgrades round 5-11 schema-v1 reports without interpreting absent values as zero", () => {
		for (let round = 5; round <= 11; round++) {
			const report = readDeepSweEvaluationReport({
				schemaVersion: 1,
				benchmark: "deep-swe",
				summary: { trials: 2, elapsedMs: 80_000, inputTokens: 10 },
				trials: [
					{
						taskId: `known-${round}`,
						trialName: `known-${round}__one`,
						status: "passed",
						inputTokens: 10,
						costUsd: 0,
						elapsedMs: 80_000,
					},
					{ taskId: `missing-${round}`, trialName: `missing-${round}__one`, status: "error" },
				],
			});
			expect(report.schemaVersion).toBe(2);
			expect(report.summary.inputTokens).toMatchObject({
				knownTotal: 10,
				observedTrials: 1,
				expectedTrials: 2,
				status: "partial",
			});
			expect(report.summary.costUsd).toMatchObject({ knownTotalUsd: 0, status: "partial" });
			expect(report.summary.wallElapsedMs).toBeNull();
		}
	});

	it("aggregates rewards, infrastructure errors, Coda metadata, usage, cost, and duration", () => {
		const report = summarizeDeepSweJobResult({
			started_at: "2026-08-12T00:00:00Z",
			finished_at: "2026-08-12T00:00:05Z",
			trial_results: [
				{
					task_name: "datacurve/b-task",
					trial_name: "b-task__one",
					task_id: { path: "/tasks/b-task" },
					started_at: "2026-08-12T00:00:00Z",
					finished_at: "2026-08-12T00:00:03Z",
					verifier_result: {
						rewards: {
							reward: 0,
							f2p: 0.5,
							f2p_passed: 2,
							f2p_total: 4,
							p2p: 1,
							p2p_passed: 3,
							p2p_total: 3,
							partial: 0.6,
						},
					},
					agent_result: {
						n_input_tokens: 10,
						n_cache_tokens: 3,
						n_output_tokens: 4,
						cost_usd: 0.25,
						n_agent_steps: 7,
						peak_context_tokens: 9,
						metadata: {
							coda_exit_code: 1,
							committed: false,
							run_outcome: "error",
							length_truncation_count: 1,
							budget_exhaustion_limits: ["turns"],
							elapsed_ms: 1_500,
							changed_paths: ["src/index.ts"],
							tool_issue_count: 2,
							tool_rejection_count: 3,
							policy_rejection_count: 2,
							invalid_tool_call_count: 1,
							unresolved_failure_count: 1,
						},
					},
				},
				{
					task_name: "a-task",
					trial_name: "a-task__one",
					started_at: "2026-08-12T00:00:00Z",
					finished_at: "2026-08-12T00:00:02Z",
					verifier_result: {
						rewards: {
							reward: 1,
							f2p: 1,
							f2p_passed: 2,
							f2p_total: 2,
							p2p: 1,
							p2p_passed: 4,
							p2p_total: 4,
							partial: 1,
						},
					},
					agent_result: {
						n_input_tokens: 20,
						n_output_tokens: 6,
						cost_usd: 0.5,
						n_agent_steps: 4,
						metadata: { coda_exit_code: 0, committed: true, elapsed_ms: 1_000 },
					},
				},
				{
					task_name: "c-task",
					trial_name: "c-task__one",
					exception_info: { exception_type: "AgentTimeoutError", exception_message: "timed out" },
				},
			],
		});

		expect(report.trials.map(({ taskId }) => taskId)).toEqual(["a-task", "b-task", "c-task"]);
		expect(report.schemaVersion).toBe(2);
		expect(report.summary).toMatchObject({
			trials: 3,
			expectedTrials: 3,
			passed: 1,
			failed: 1,
			errors: 1,
			passRate: 1 / 3,
			f2pPassed: 4,
			f2pTotal: 6,
			p2pPassed: 7,
			p2pTotal: 7,
			averagePartial: 0.8,
			wallElapsedMs: 5_000,
			cumulativeTrialElapsedMs: {
				knownTotal: 5_000,
				observedTrials: 2,
				expectedTrials: 3,
				status: "partial",
				sources: ["pier_result"],
			},
			inputTokens: { knownTotal: 30, observedTrials: 2, expectedTrials: 3, status: "partial" },
			cacheTokens: { knownTotal: 3, observedTrials: 1, expectedTrials: 3, status: "partial" },
			outputTokens: { knownTotal: 10, observedTrials: 2, expectedTrials: 3, status: "partial" },
			costUsd: { knownTotalUsd: 0.75, observedTrials: 2, expectedTrials: 3, status: "partial" },
			turnCount: { knownTotal: 11, observedTrials: 2, expectedTrials: 3, status: "partial" },
			cumulativeAgentElapsedMs: {
				knownTotal: 2_500,
				observedTrials: 2,
				expectedTrials: 3,
				status: "partial",
			},
			committedTrials: 2,
			nonzeroCodaExits: 1,
			toolIssueCount: 2,
			toolRejectionCount: 3,
			policyRejectionCount: 2,
			invalidToolCallCount: 1,
			unresolvedFailureCount: 1,
			lengthTruncationCount: 1,
			budgetExhaustedTrials: 1,
		});
		expect(report.trials[1]).toMatchObject({
			codaExitCode: 1,
			committed: true,
			runOutcome: "error",
			turnCount: 7,
			peakContextTokens: 9,
			agentElapsedMs: 1_500,
			changedPathCount: 1,
			toolIssueCount: 2,
			toolRejectionCount: 3,
			policyRejectionCount: 2,
			invalidToolCallCount: 1,
			unresolvedFailureCount: 1,
			lengthTruncationCount: 1,
			budgetExhaustionLimits: ["turns"],
			resources: {
				inputTokens: { knownTotal: 10, status: "complete", source: "run_evidence" },
				costUsd: { knownTotalUsd: 0.25, status: "complete", source: "run_evidence" },
			},
		});
	});

	it("compares independently versioned development rounds and per-task movement", () => {
		const base = summarizeDeepSweJobResult({
			trial_results: [
				{
					task_name: "a-task",
					trial_name: "a-task__base",
					verifier_result: { rewards: { reward: 0, partial: 0.25 } },
				},
			],
		});
		const improved = summarizeDeepSweJobResult({
			trial_results: [
				{
					task_name: "a-task",
					trial_name: "a-task__improved",
					verifier_result: { rewards: { reward: 1, partial: 1 } },
				},
			],
		});
		const comparison = compareDeepSweRounds([
			{
				round: 2,
				harnessRevision: "revision-two",
				maxOutputTokens: 32_768,
				maxTurns: 96,
				allowAllCommands: true,
				report: improved,
			},
			{ round: 1, harnessRevision: "revision-one", maxOutputTokens: 16_384, maxTurns: 64, report: base },
		]);

		expect(comparison.campaignKind).toBe("development-rounds");
		expect(comparison.rounds.map(({ round }) => round)).toEqual([1, 2]);
		expect(comparison.rounds[1]).toMatchObject({
			maxOutputTokens: 32_768,
			maxTurns: 96,
			allowAllCommands: true,
			deltaPassedFromPrevious: 1,
			deltaPassRateFromPrevious: 1,
			deltaAveragePartialFromPrevious: 0.75,
		});
		expect(comparison.tasks[0]?.rounds.map(({ reward }) => reward)).toEqual([0, 1]);
	});
});
