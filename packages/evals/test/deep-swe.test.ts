import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertDeepSwePaidRun,
	compareDeepSweRounds,
	createDeepSwePierJobConfig,
	createDeepSweRunLock,
	DEEP_SWE_DATASET_REVISION,
	DEEP_SWE_FIRST_20_IMAGE_LOCKS,
	DEEP_SWE_FIRST_20_TASK_IDS,
	formatDeepSweImageLockTsv,
	summarizeDeepSweJobResult,
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
				max_turns: 96,
				allow_all_commands: true,
			},
			env: { OPENCODE_API_KEY: `$${"{OPENCODE_API_KEY}"}`, NODE_USE_ENV_PROXY: "1" },
		});
		expect(config.datasets[0]).toEqual({ path: OPTIONS.datasetDir, task_names: ["abs-stepped-slices"] });
		expect(JSON.stringify(config)).not.toContain("sk-");
	});

	it("records each round separately and labels repeated tasks as development data", () => {
		const lock = createDeepSweRunLock({ ...OPTIONS, round: 4 });
		expect(lock.campaignKind).toBe("development-round");
		expect(lock.harness.maxOutputTokens).toBe(32_768);
		expect(lock.harness.maxTurns).toBe(96);
		expect(lock.harness.allowAllCommands).toBe(true);
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

	it("aggregates rewards, infrastructure errors, Coda metadata, usage, cost, and duration", () => {
		const report = summarizeDeepSweJobResult({
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
		expect(report.summary).toEqual({
			trials: 3,
			passed: 1,
			failed: 1,
			errors: 1,
			passRate: 1 / 3,
			f2pPassed: 4,
			f2pTotal: 6,
			p2pPassed: 7,
			p2pTotal: 7,
			averagePartial: 0.8,
			elapsedMs: 5_000,
			inputTokens: 30,
			cacheTokens: 3,
			outputTokens: 10,
			costUsd: 0.75,
			turnCount: 11,
			agentElapsedMs: 2_500,
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
