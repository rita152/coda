import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertDeepSwePaidRun,
	compareDeepSweRounds,
	createDeepSwePierJobConfig,
	createDeepSweRunLock,
	DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
	DEEP_SWE_DEFAULT_MAX_OUTPUT_TOKENS,
	DEEP_SWE_DEFAULT_MAX_TURNS,
	DEEP_SWE_DEFAULT_MODEL,
	DEEP_SWE_DEFAULT_REASONING,
	DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
	DEEP_SWE_DEFAULT_RUN_CONTROL_STATIONARY_TURNS,
	DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
	DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
	type DeepSwePierJobOptions,
	type DeepSweRoundReport,
	formatDeepSweImageLockTsv,
	readDeepSweEvaluationReport,
	summarizeDeepSweJobResult,
} from "./deep-swe.ts";
import {
	DEEP_SWE_REPORT_RECOVERY_METADATA_KEY,
	type DeepSweJsonlReduction,
	reduceDeepSweJsonlFile,
} from "./deep-swe-resources.ts";

type DeepSweCommand = "compare" | "config" | "images" | "report" | "run";

interface ParsedArguments {
	readonly command: DeepSweCommand;
	readonly confirmed: boolean;
	readonly concurrency: number;
	readonly round: number;
	readonly taskIds: readonly string[];
	readonly quiet: boolean;
	readonly datasetDir?: string;
	readonly runtimeDir?: string;
	readonly jobsDir?: string;
	readonly harnessRevision?: string;
	readonly model: string;
	readonly reasoningEffort: string;
	readonly maxOutputTokens: number;
	readonly maxTurns: number;
	readonly disableRunBudget: boolean;
	readonly runControlWorkSec: number;
	readonly runControlGraceSec: number;
	readonly runControlStationaryTurns: number;
	readonly adapterFinalizeMarginSec: number;
	readonly pierHardTimeoutSec: number;
	readonly allowAllCommands: boolean;
	readonly adapterDir?: string;
	readonly pierCommand: string;
	readonly configOutput?: string;
	readonly lockOutput?: string;
	readonly resultPaths: readonly string[];
}

const HELP = `Usage: deep-swe <command> [options]

Commands:
  compare  Compare two or more separately recorded round results
  config   Write a secret-free Pier config and Coda run lock
  images   Print the pinned first-20 image lock as TSV
  report   Summarize a Pier result.json
  run      Run one paid, separately recorded Pier development round

Run/config options:
  --dataset-dir <absolute-path>       Pinned DeepSWE tasks directory
  --runtime-dir <absolute-path>       Linux Coda runtime bundle
  --jobs-dir <absolute-path>          Append-only Pier jobs directory
  --harness-revision <revision>       Git/content revision of the runtime bundle
  --round <positive-int>              Development round number
  --concurrency <positive-int>        Concurrent Pier trials
  --task <literal-id>                 Task selection; repeat (default: frozen first 20)
  --model <provider/model>            Default: ${DEEP_SWE_DEFAULT_MODEL}
  --reasoning <level>                 Default: ${DEEP_SWE_DEFAULT_REASONING}
  --max-output-tokens <positive-int>  Default: ${DEEP_SWE_DEFAULT_MAX_OUTPUT_TOKENS}
  --max-turns <positive-int>          Default: ${DEEP_SWE_DEFAULT_MAX_TURNS}
	--no-run-budget                     Disable economic Coda RunBudget limits
  --run-control-work-sec <positive-int>
                                      Default: ${DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC}
  --run-control-grace-sec <positive-int>
                                      Default: ${DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC}
  --run-control-stationary-turns <n>  Default: ${DEEP_SWE_DEFAULT_RUN_CONTROL_STATIONARY_TURNS}
  --adapter-finalize-margin-sec <n>   Default: ${DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC}
  --pier-hard-timeout-sec <n>         Default: ${DEEP_SWE_PIER_HARD_TIMEOUT_SEC}
  --allow-all-commands                Bypass Coda command classification and the outer Sandbox
  --adapter-dir <absolute-path>       Directory containing coda_agent.py (run only)
  --pier-command <path-or-name>       Default: pier
  --config-output <path>              Generated config destination
  --lock-output <path>                Generated run-lock destination
  --quiet                             Suppress Pier per-trial progress
  --confirm-spend                     Required by run

Report options:
  --result <path>                     Pier result.json; repeat for compare

Paid runs also require CODA_EVALS_DEEP_SWE=1 and OPENCODE_API_KEY.`;

function parsePositiveInteger(value: string | undefined, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} requires a positive integer`);
	return parsed;
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
	const command = arguments_[0];
	if (command === undefined || command === "--help" || command === "-h") {
		throw new Error(HELP);
	}
	if (!(["compare", "config", "images", "report", "run"] as const).includes(command as DeepSweCommand)) {
		throw new Error(`Unknown DeepSWE command: ${command}\n\n${HELP}`);
	}

	let confirmed = false;
	let concurrency = 5;
	let round = 1;
	let quiet = false;
	let datasetDir: string | undefined;
	let runtimeDir: string | undefined;
	let jobsDir: string | undefined;
	let harnessRevision: string | undefined;
	let model = DEEP_SWE_DEFAULT_MODEL;
	let reasoningEffort = DEEP_SWE_DEFAULT_REASONING;
	let maxOutputTokens = DEEP_SWE_DEFAULT_MAX_OUTPUT_TOKENS;
	let maxTurns = DEEP_SWE_DEFAULT_MAX_TURNS;
	let maxTurnsExplicit = false;
	let disableRunBudget = false;
	let runControlWorkSec = DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC;
	let runControlGraceSec = DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC;
	let runControlStationaryTurns = DEEP_SWE_DEFAULT_RUN_CONTROL_STATIONARY_TURNS;
	let adapterFinalizeMarginSec = DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC;
	let pierHardTimeoutSec = DEEP_SWE_PIER_HARD_TIMEOUT_SEC;
	let allowAllCommands = false;
	let adapterDir: string | undefined;
	let pierCommand = "pier";
	let configOutput: string | undefined;
	let lockOutput: string | undefined;
	const resultPaths: string[] = [];
	const taskIds: string[] = [];
	const valueAfter = (index: number, option: string): string => {
		const value = arguments_[index + 1];
		if (!value) throw new Error(`${option} requires a value`);
		return value;
	};

	for (let index = 1; index < arguments_.length; index++) {
		const argument = arguments_[index]!;
		if (argument === "--confirm-spend") confirmed = true;
		else if (argument === "--quiet") quiet = true;
		else if (argument === "--concurrency") concurrency = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--round") round = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--task") taskIds.push(valueAfter(index++, argument));
		else if (argument === "--dataset-dir") datasetDir = valueAfter(index++, argument);
		else if (argument === "--runtime-dir") runtimeDir = valueAfter(index++, argument);
		else if (argument === "--jobs-dir") jobsDir = valueAfter(index++, argument);
		else if (argument === "--harness-revision") harnessRevision = valueAfter(index++, argument);
		else if (argument === "--model") model = valueAfter(index++, argument);
		else if (argument === "--reasoning") reasoningEffort = valueAfter(index++, argument);
		else if (argument === "--max-output-tokens")
			maxOutputTokens = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--max-turns") {
			maxTurns = parsePositiveInteger(arguments_[++index], argument);
			maxTurnsExplicit = true;
		} else if (argument === "--no-run-budget") disableRunBudget = true;
		else if (argument === "--run-control-work-sec")
			runControlWorkSec = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--run-control-grace-sec")
			runControlGraceSec = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--run-control-stationary-turns")
			runControlStationaryTurns = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--adapter-finalize-margin-sec")
			adapterFinalizeMarginSec = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--pier-hard-timeout-sec")
			pierHardTimeoutSec = parsePositiveInteger(arguments_[++index], argument);
		else if (argument === "--allow-all-commands") allowAllCommands = true;
		else if (argument === "--adapter-dir") adapterDir = valueAfter(index++, argument);
		else if (argument === "--pier-command") pierCommand = valueAfter(index++, argument);
		else if (argument === "--config-output") configOutput = valueAfter(index++, argument);
		else if (argument === "--lock-output") lockOutput = valueAfter(index++, argument);
		else if (argument === "--result") resultPaths.push(valueAfter(index++, argument));
		else throw new Error(`Unknown DeepSWE option: ${argument}`);
	}

	if (disableRunBudget && maxTurnsExplicit) {
		throw new Error("--no-run-budget and --max-turns cannot be combined");
	}
	return {
		command: command as DeepSweCommand,
		confirmed,
		concurrency,
		round,
		taskIds,
		quiet,
		...(datasetDir ? { datasetDir } : {}),
		...(runtimeDir ? { runtimeDir } : {}),
		...(jobsDir ? { jobsDir } : {}),
		...(harnessRevision ? { harnessRevision } : {}),
		model,
		reasoningEffort,
		maxOutputTokens,
		maxTurns,
		disableRunBudget,
		runControlWorkSec,
		runControlGraceSec,
		runControlStationaryTurns,
		adapterFinalizeMarginSec,
		pierHardTimeoutSec,
		allowAllCommands,
		...(adapterDir ? { adapterDir } : {}),
		pierCommand,
		...(configOutput ? { configOutput } : {}),
		...(lockOutput ? { lockOutput } : {}),
		resultPaths,
	};
}

function requiredPath(value: string | undefined, option: string): string {
	if (!value) throw new Error(`${option} is required`);
	if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path`);
	return value;
}

function jobOptions(arguments_: ParsedArguments): DeepSwePierJobOptions {
	if (!arguments_.harnessRevision) throw new Error("--harness-revision is required");
	return {
		datasetDir: requiredPath(arguments_.datasetDir, "--dataset-dir"),
		runtimeDir: requiredPath(arguments_.runtimeDir, "--runtime-dir"),
		jobsDir: requiredPath(arguments_.jobsDir, "--jobs-dir"),
		harnessRevision: arguments_.harnessRevision,
		round: arguments_.round,
		concurrency: arguments_.concurrency,
		...(arguments_.taskIds.length > 0 ? { taskIds: arguments_.taskIds } : {}),
		model: arguments_.model,
		reasoningEffort: arguments_.reasoningEffort,
		maxOutputTokens: arguments_.maxOutputTokens,
		maxTurns: arguments_.maxTurns,
		disableRunBudget: arguments_.disableRunBudget,
		runControlWorkSec: arguments_.runControlWorkSec,
		runControlGraceSec: arguments_.runControlGraceSec,
		runControlStationaryTurns: arguments_.runControlStationaryTurns,
		adapterFinalizeMarginSec: arguments_.adapterFinalizeMarginSec,
		pierHardTimeoutSec: arguments_.pierHardTimeoutSec,
		allowAllCommands: arguments_.allowAllCommands,
		quiet: arguments_.quiet,
	};
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readPierJobResult(path: string): Promise<unknown> {
	const result = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	if (Array.isArray(result.trial_results)) {
		const trialResults = await Promise.all(
			result.trial_results.map(async (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
				const trial = value as Record<string, unknown>;
				return typeof trial.trial_name === "string"
					? enrichTrialDiagnostics(trial, join(dirname(path), trial.trial_name))
					: trial;
			}),
		);
		return { ...result, trial_results: trialResults };
	}
	if (typeof result.task_name === "string") {
		return { ...result, trial_results: [await enrichTrialDiagnostics(result, dirname(path))] };
	}

	const jobDir = dirname(path);
	const entries = (await readdir(jobDir, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => left.name.localeCompare(right.name));
	const trialResults: unknown[] = [];
	for (const entry of entries) {
		const trialPath = join(jobDir, entry.name, "result.json");
		try {
			const trial = JSON.parse(await readFile(trialPath, "utf8")) as Record<string, unknown>;
			if (typeof trial.task_name === "string") {
				trialResults.push(await enrichTrialDiagnostics(trial, join(jobDir, entry.name)));
			}
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") throw error;
		}
	}
	if (trialResults.length === 0) throw new Error(`Pier job has no completed trial result files: ${jobDir}`);
	return { ...result, trial_results: trialResults };
}

async function enrichTrialDiagnostics(
	trial: Record<string, unknown>,
	trialDir: string,
): Promise<Record<string, unknown>> {
	let reduction: DeepSweJsonlReduction;
	try {
		reduction = await reduceDeepSweJsonlFile(join(trialDir, "agent", "coda.jsonl"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return trial;
		throw error;
	}
	const agent =
		typeof trial.agent_result === "object" && trial.agent_result !== null
			? (trial.agent_result as Record<string, unknown>)
			: {};
	const metadata =
		typeof agent.metadata === "object" && agent.metadata !== null ? (agent.metadata as Record<string, unknown>) : {};
	return {
		...trial,
		agent_result: {
			...agent,
			metadata: {
				...metadata,
				length_truncation_count: metadata.length_truncation_count ?? reduction.lengthTruncationCount,
				budget_exhaustion_limits: metadata.budget_exhaustion_limits ?? reduction.budgetExhaustionLimits,
				tool_rejection_count: metadata.tool_rejection_count ?? reduction.toolRejectionCount,
				policy_rejection_count: metadata.policy_rejection_count ?? reduction.policyRejectionCount,
				invalid_tool_call_count: metadata.invalid_tool_call_count ?? reduction.invalidToolCallCount,
				[DEEP_SWE_REPORT_RECOVERY_METADATA_KEY]: reduction,
			},
		},
	};
}

function isVersionedDeepSweReport(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const report = value as Record<string, unknown>;
	return (
		report.benchmark === "deep-swe" &&
		(report.schemaVersion === 1 || report.schemaVersion === 2) &&
		Array.isArray(report.trials)
	);
}

async function readEvaluationReport(path: string) {
	const input: unknown = JSON.parse(await readFile(path, "utf8"));
	return isVersionedDeepSweReport(input)
		? readDeepSweEvaluationReport(input)
		: summarizeDeepSweJobResult(await readPierJobResult(path));
}

async function tryReadJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRoundReport(path: string): Promise<DeepSweRoundReport> {
	const jobDir = dirname(path);
	const pathRound = /(?:^|-)round-(\d+)(?:-|\.)/.exec(basename(path));
	const adjacentConfig = pathRound ? join(jobDir, `round-${pathRound[1]}-config.json`) : undefined;
	const config =
		(await tryReadJson(join(jobDir, "config.json"))) ??
		(adjacentConfig ? await tryReadJson(adjacentConfig) : undefined) ??
		{};
	const name = typeof config.job_name === "string" ? config.job_name : "";
	const nameRound = /(?:^|-)r(\d+)(?:-|$)/.exec(name);
	const roundText = nameRound?.[1] ?? pathRound?.[1];
	if (!roundText) throw new Error(`Could not determine round number from Pier job or report name: ${name || path}`);
	const agents = Array.isArray(config.agents) ? config.agents : [];
	const agent = typeof agents[0] === "object" && agents[0] !== null ? (agents[0] as Record<string, unknown>) : {};
	const kwargs =
		typeof agent.kwargs === "object" && agent.kwargs !== null ? (agent.kwargs as Record<string, unknown>) : {};
	const harnessRevision = typeof kwargs.harness_revision === "string" ? kwargs.harness_revision : "unknown";
	const maxOutputTokens = typeof kwargs.max_output_tokens === "number" ? kwargs.max_output_tokens : 16_384;
	const runBudgetEnabled = kwargs.run_budget_enabled !== false;
	const maxTurns =
		runBudgetEnabled && typeof kwargs.max_turns === "number" ? kwargs.max_turns : DEEP_SWE_DEFAULT_MAX_TURNS;
	const allowAllCommands = kwargs.allow_all_commands === true;
	return {
		round: Number(roundText),
		harnessRevision,
		maxOutputTokens,
		runBudgetEnabled,
		...(runBudgetEnabled ? { maxTurns } : {}),
		allowAllCommands,
		report: await readEvaluationReport(path),
	};
}

async function writeJobFiles(
	arguments_: ParsedArguments,
	options: DeepSwePierJobOptions,
): Promise<{ readonly configPath: string; readonly lockPath: string; readonly jobName: string }> {
	const config = createDeepSwePierJobConfig(options);
	const configPath = resolve(
		arguments_.configOutput ?? join(options.jobsDir, ".coda-configs", `${config.job_name}.json`),
	);
	const lockPath = resolve(
		arguments_.lockOutput ?? join(options.jobsDir, ".coda-configs", `${config.job_name}.lock.json`),
	);
	await writeJson(configPath, config);
	await writeJson(lockPath, createDeepSweRunLock(options));
	return { configPath, lockPath, jobName: config.job_name };
}

function runProcess(command: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, arguments_, { env: environment, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) reject(new Error(`${command} exited from signal ${signal}`));
			else resolvePromise(code ?? 1);
		});
	});
}

async function runPaidJob(arguments_: ParsedArguments): Promise<number> {
	assertDeepSwePaidRun({
		allowPaidRequests: process.env.CODA_EVALS_DEEP_SWE === "1",
		confirmed: arguments_.confirmed,
		hasApiKey: Boolean(process.env.OPENCODE_API_KEY),
	});
	const adapterDir = requiredPath(arguments_.adapterDir, "--adapter-dir");
	const options = jobOptions(arguments_);
	const files = await writeJobFiles(arguments_, options);
	process.stderr.write(`DeepSWE config: ${files.configPath}\nDeepSWE lock: ${files.lockPath}\n`);
	const pythonPath = process.env.PYTHONPATH ? `${adapterDir}${delimiter}${process.env.PYTHONPATH}` : adapterDir;
	const exitCode = await runProcess(arguments_.pierCommand, ["run", "--config", files.configPath, "--yes"], {
		...process.env,
		PYTHONPATH: pythonPath,
	});
	if (exitCode !== 0) return exitCode;

	const jobDir = join(options.jobsDir, files.jobName);
	const resultPath = join(jobDir, "result.json");
	const report = summarizeDeepSweJobResult(await readPierJobResult(resultPath));
	await writeJson(join(jobDir, "coda-summary.json"), report);
	process.stdout.write(`${JSON.stringify(report)}\n`);
	return 0;
}

export async function runDeepSweCli(arguments_: readonly string[]): Promise<number> {
	const parsed = parseArguments(arguments_);
	if (parsed.command === "images") {
		process.stdout.write(formatDeepSweImageLockTsv());
		return 0;
	}
	if (parsed.command === "report") {
		const resultPath = parsed.resultPaths[0];
		if (!resultPath || parsed.resultPaths.length !== 1) throw new Error("report requires exactly one --result");
		process.stdout.write(`${JSON.stringify(await readEvaluationReport(resultPath), undefined, 2)}\n`);
		return 0;
	}
	if (parsed.command === "compare") {
		if (parsed.resultPaths.length < 2) throw new Error("compare requires at least two --result paths");
		process.stdout.write(
			`${JSON.stringify(compareDeepSweRounds(await Promise.all(parsed.resultPaths.map(readRoundReport))), undefined, 2)}\n`,
		);
		return 0;
	}
	if (parsed.command === "config") {
		const files = await writeJobFiles(parsed, jobOptions(parsed));
		process.stdout.write(`${JSON.stringify(files)}\n`);
		return 0;
	}
	return runPaidJob(parsed);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	runDeepSweCli(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`coda DeepSWE evals: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
