import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeepSweCli } from "../src/deep-swe-cli.ts";
import type { DeepSweEvaluationReport } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "coda-deep-swe-report-"));
	temporaryDirectories.push(path);
	return path;
}

function captureStdout(): { readonly output: () => string } {
	let captured = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	});
	return { output: () => captured };
}

describe("DeepSWE report CLI", () => {
	it("renders an Arktype-style timeout recovery as an explicit terminal-event lower bound", async () => {
		const jobDir = await temporaryDirectory();
		const trialName = "arktype-json-schema-refs-depende__timeout";
		const trialDir = join(jobDir, trialName);
		await mkdir(join(trialDir, "agent"), { recursive: true });
		await writeFile(
			join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 1,
				started_at: "2026-08-13T10:00:00Z",
				finished_at: "2026-08-13T11:31:40Z",
			}),
		);
		await writeFile(
			join(trialDir, "result.json"),
			JSON.stringify({
				task_name: "datacurve/arktype-json-schema-refs-dependencies",
				trial_name: trialName,
				started_at: "2026-08-13T10:00:00Z",
				finished_at: "2026-08-13T11:31:40Z",
				agent_result: {
					n_input_tokens: null,
					n_cache_tokens: null,
					n_output_tokens: null,
					cost_usd: null,
					n_agent_steps: null,
					metadata: null,
				},
				exception_info: {
					exception_type: "AgentTimeoutError",
					exception_message: "Agent execution timed out after 5400.0 seconds",
				},
				verifier_result: { rewards: { reward: 0, partial: 0.985 } },
			}),
		);
		const events = [
			{ type: "run_start", timestamp: 1_000 },
			{ type: "turn_start", timestamp: 1_100 },
			{
				type: "attempt_end",
				timestamp: 2_000,
				candidate: {
					message: {
						usage: {
							input: 10,
							cacheRead: 30,
							cacheWrite: 5,
							output: 7,
							cost: { total: 0.125 },
						},
					},
				},
			},
			{
				type: "attempt_end",
				timestamp: 3_000,
				candidate: {
					message: {
						usage: {
							input: 20,
							cacheRead: 40,
							cacheWrite: 0,
							output: 8,
							cost: { total: 0.0161856516 },
						},
					},
				},
			},
		];
		await writeFile(
			join(trialDir, "agent", "coda.jsonl"),
			`${events.map((event) => JSON.stringify(event)).join("\n")}\n{"type":"attempt_end"`,
		);

		const stdout = captureStdout();
		expect(await runDeepSweCli(["report", "--result", join(jobDir, "result.json")])).toBe(0);
		const report = JSON.parse(stdout.output()) as DeepSweEvaluationReport;

		expect(report.schemaVersion).toBe(3);
		expect(report.summary.wallElapsedMs).toBe(5_500_000);
		expect(report.summary.inputTokens).toMatchObject({
			knownTotal: 105,
			observedTrials: 1,
			expectedTrials: 1,
			status: "partial",
			sources: ["terminal_events"],
		});
		expect(report.summary.costUsd).toEqual({
			knownTotalUsd: 0.1411856516,
			observedTrials: 1,
			expectedTrials: 1,
			status: "partial",
			sources: ["terminal_events"],
			pricedAttempts: 2,
			unpricedAttempts: 0,
			attemptCoverage: "partial",
		});
		expect(report.trials[0]).toMatchObject({
			status: "error",
			exceptionType: "AgentTimeoutError",
			resources: {
				inputTokens: { knownTotal: 105, status: "partial", source: "terminal_events" },
				costUsd: {
					knownTotalUsd: 0.1411856516,
					status: "partial",
					source: "terminal_events",
					pricedAttempts: 2,
					unpricedAttempts: 0,
				},
			},
		});
	});

	it("upgrades a legacy schema-v1 summary passed directly to report", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "round-5-summary.json");
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				benchmark: "deep-swe",
				summary: { trials: 1, inputTokens: 0, costUsd: 0 },
				trials: [
					{
						taskId: "legacy-task",
						trialName: "legacy-task__one",
						status: "passed",
						inputTokens: 0,
						costUsd: 0,
					},
				],
			}),
		);
		const stdout = captureStdout();
		expect(await runDeepSweCli(["report", "--result", path])).toBe(0);
		const report = JSON.parse(stdout.output()) as DeepSweEvaluationReport;

		expect(report.schemaVersion).toBe(3);
		expect(report.summary.inputTokens).toMatchObject({ knownTotal: 0, status: "complete" });
		expect(report.summary.costUsd).toMatchObject({ knownTotalUsd: 0, status: "complete" });
	});
});
