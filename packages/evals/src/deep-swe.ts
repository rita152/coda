import { isAbsolute } from "node:path";
import { createDeepSweExperimentPlan, type DeepSweExperimentPlan } from "./deep-swe-experiment.ts";

export const DEEP_SWE_VERSION = "v1.1";
export const DEEP_SWE_DATASET_REVISION = "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9";
export const DEEP_SWE_PIER_VERSION = "0.3.1";
export const DEEP_SWE_PIER_REVISION = "df89f994623a0a6a57229103b6fe910766693c30";
export const DEEP_SWE_DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
export const DEEP_SWE_DEFAULT_REASONING = "max";
export const DEEP_SWE_DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
export const DEEP_SWE_DEFAULT_MAX_TURNS = 64;
export const DEEP_SWE_PROVIDER_HOST = "opencode.ai";
export const DEEP_SWE_EVENT_STREAM_MODE = "semantic";
/** Must match the semantic selection policy owned by Coding Agent's JsonEventWriter. */
export const DEEP_SWE_EVENT_STREAM_SCHEMA_VERSION = 1;
export const DEEP_SWE_PIER_HARD_TIMEOUT_SEC = 5_400;
export const DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC = 4_500;
export const DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC = 600;
export const DEEP_SWE_DEFAULT_RUN_CONTROL_STATIONARY_TURNS = 4;
export const DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC = 240;

export interface DeepSweImageLock {
	readonly taskId: string;
	readonly image: string;
	readonly digest: `sha256:${string}`;
}

const DEEP_SWE_IMAGE_REPOSITORY = "public.ecr.aws/d3j8x8q7/swe-bench-202605";
const OPENCODE_API_KEY_TEMPLATE = `\${OPENCODE_API_KEY}`;

export const DEEP_SWE_FIRST_20_IMAGE_LOCKS: readonly DeepSweImageLock[] = Object.freeze([
	{
		taskId: "abs-module-cache-flags",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh75679ajj3b8dtd7se3h7z0a1833y6r-v1.1`,
		digest: "sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1",
	},
	{
		taskId: "abs-stepped-slices",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh7d5m4ed35zfp7gyhx7wdahed82yw72-v1.1`,
		digest: "sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1",
	},
	{
		taskId: "actionlint-action-pinning-lint",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh79dnvkvq8j9bs22ededmsc79823akj-v1.1`,
		digest: "sha256:522a6e93a31656d03cc79474dafc5542bb27109051914d5566d7d29789c2a1a6",
	},
	{
		taskId: "adaptix-name-mapping-aliases",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh73dq4n55jdxasppe6jjmth4183d47n-v1.1`,
		digest: "sha256:528654670f3c591e6491fc6fa01a0b8905bc8dee1b0557c5e76231bcc206f8fe",
	},
	{
		taskId: "aiomonitor-task-snapshots-diff",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh75rc2q0zhmsqwk7wewfwwtrx830v2n-v1.1`,
		digest: "sha256:e0c8b4e4044d5831693b4f6a6da483b255a889b71376574fba9e3c93d36ceb7c",
	},
	{
		taskId: "anko-default-function-arguments",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh7fj3hc92zehtc8azrm32xzb182w9dr-v1.1`,
		digest: "sha256:31c8dce39317314800d1200610475ba27b98c71350d524d25e7df71d80c5752a",
	},
	{
		taskId: "anko-typed-variable-bindings",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh79betfed7ets4an20cr4j57182y9wt-v1.1`,
		digest: "sha256:4fb704fd8dff600f6d028c20ae4aca5e1261968bb615bb41c01a111dd371255b",
	},
	{
		taskId: "arcane-drift-detection-baselines",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh70nj38qyatmsmj1d5zh57j25820vrx-v1.1`,
		digest: "sha256:1d4ad8d6deb37c92a9bbb550cf3cc127f916e340f35f29b72948ccb571197c42",
	},
	{
		taskId: "arktype-json-schema-refs-dependencies",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh771gpr8crkjsnt9pj81bafgs8229em-v1.1`,
		digest: "sha256:e0b0410d828b816474cfb89a448c448f15cf7d617c3fbddfacd45a1c1b232ef9",
	},
	{
		taskId: "awilix-async-container-initialization",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh70bg8gy4xks4eyh1s71ecmk9822p9c-v1.1`,
		digest: "sha256:748294a8ece567691f0a628d03c3531024d9f5e1acd13d5c6dd1ecba490831e6",
	},
	{
		taskId: "bandit-incremental-cache-control",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh7drfg2vkvdvfh9xx0nfd5pz9821xr7-v1.1`,
		digest: "sha256:f22b38f03dfbe2ca76f5019a1ef94953f700d51312fe47693ecba7d18f544d94",
	},
	{
		taskId: "bandit-interprocedural-taint-checks",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh77yap0nc4zwm5bysc954xbr182tptg-v1.1`,
		digest: "sha256:7207179b09db76a8a3864b9e69c5fdf10e0d41a5bba242854216f18aa90ac7b1",
	},
	{
		taskId: "bandit-structured-nosec-directives",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh757d8ggvnfaszv8zcav3msy982ma7f-v1.1`,
		digest: "sha256:2f6978cf88228baa0d3323e4f139ee222f5886218d86ca1d327bcae3711f4b6a",
	},
	{
		taskId: "boa-hierarchical-evaluation-cancellation",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh71kat2v58yys3pnyybkgycax832vj2-v1.1`,
		digest: "sha256:9ab97da2ebb88bc71beeb2434d198d4adca6e1abe14f45d52250666249fb7a1e",
	},
	{
		taskId: "cattrs-partial-structuring-recovery",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh7f7cahc5ddm1qzpxz13kpmrh8235pc-v1.1`,
		digest: "sha256:443a3534dab64283e5a9dedf3b7ac8867ed7d5dabcde39bc39c77ab5a909176a",
	},
	{
		taskId: "clack-async-autocomplete-options",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh78c5dwwna57y757p2y5ktw79836dnv-v1.1`,
		digest: "sha256:32a72ef7d4a9d3ae8937aef9c42e18166284c817c8edf137d66772e4f34abf74",
	},
	{
		taskId: "claude-code-by-agents-recursive-delegation",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh734ehfw2s3bztf7pzc9xf3x18212bs-v1.1`,
		digest: "sha256:4baf10f1e66f9ab4d82991e538c13620c387c862974ec36dd5bd5d52f635920e",
	},
	{
		taskId: "cliffy-config-file-parsing",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh72088pg9vkc6peacnkc35yy9832jff-v1.1`,
		digest: "sha256:0a8dd8f1270ec4bb88efadad3021762e1d07274f686276c8a484d26a00bd91b5",
	},
	{
		taskId: "csstree-shorthand-expansion-compression",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh72qraccnjwdet6ynagsccr4x82y65c-v1.1`,
		digest: "sha256:df2cc59d679c908f8f13f68fc59231a5d6f0c2bcec4b7b26fdf9489eb824a8b2",
	},
	{
		taskId: "dasel-html-document-format",
		image: `${DEEP_SWE_IMAGE_REPOSITORY}:kh7c7rrg3zke74w7068nawak9x82t6am-v1.1`,
		digest: "sha256:0529d5659b2d11ee76e3ba13a877043b3e43bcf123f36a840f9cf5b5ade09b78",
	},
]);

export const DEEP_SWE_FIRST_20_TASK_IDS: readonly string[] = Object.freeze(
	DEEP_SWE_FIRST_20_IMAGE_LOCKS.map(({ taskId }) => taskId),
);

export interface DeepSwePierJobOptions {
	readonly datasetDir: string;
	readonly runtimeDir: string;
	readonly jobsDir: string;
	readonly harnessRevision: string;
	readonly round: number;
	readonly concurrency: number;
	readonly attempts?: number;
	readonly timeBlock?: string;
	readonly taskIds?: readonly string[];
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly maxOutputTokens?: number;
	readonly maxTurns?: number;
	readonly disableRunBudget?: boolean;
	readonly runControlWorkSec?: number;
	readonly runControlGraceSec?: number;
	readonly runControlStationaryTurns?: number;
	readonly adapterFinalizeMarginSec?: number;
	readonly pierHardTimeoutSec?: number;
	readonly allowAllCommands?: boolean;
	readonly adapterImportPath?: string;
	readonly quiet?: boolean;
}

export interface DeepSwePierJobConfig {
	readonly job_name: string;
	readonly jobs_dir: string;
	readonly n_attempts: number;
	readonly n_concurrent_trials: number;
	readonly quiet: boolean;
	readonly retry: { readonly max_retries: 0 };
	readonly environment: {
		readonly type: "docker";
		readonly force_build: false;
		readonly delete: true;
		readonly cpu_enforcement_policy: "auto";
		readonly memory_enforcement_policy: "auto";
	};
	readonly verifier: { readonly disable: false };
	readonly agents: readonly [
		{
			readonly import_path: string;
			readonly model_name: string;
			readonly override_setup_timeout_sec: 900;
			readonly max_timeout_sec: number;
			readonly kwargs: {
				readonly runtime_dir: string;
				readonly reasoning_effort: string;
				readonly max_output_tokens: number;
				readonly event_stream_mode: typeof DEEP_SWE_EVENT_STREAM_MODE;
				readonly run_budget_enabled: boolean;
				readonly max_turns?: number;
				readonly run_control_work_sec: number;
				readonly run_control_grace_sec: number;
				readonly run_control_stationary_turns: number;
				readonly adapter_finalize_margin_sec: number;
				readonly pier_hard_timeout_sec: number;
				readonly allow_all_commands: boolean;
				readonly harness_revision: string;
			};
			readonly env: {
				readonly OPENCODE_API_KEY: "${OPENCODE_API_KEY}";
				readonly NODE_USE_ENV_PROXY: "1";
				readonly NODE_USE_SYSTEM_CA: "1";
			};
		},
	];
	readonly datasets: readonly [{ readonly path: string; readonly task_names: readonly string[] }];
}

export interface DeepSweRunLock {
	readonly schemaVersion: 3;
	readonly campaignKind: "development-round";
	readonly dataset: {
		readonly name: "datacurve/deep-swe-1-1";
		readonly version: typeof DEEP_SWE_VERSION;
		readonly sourceRevision: typeof DEEP_SWE_DATASET_REVISION;
	};
	readonly pier: {
		readonly version: typeof DEEP_SWE_PIER_VERSION;
		readonly sourceRevision: typeof DEEP_SWE_PIER_REVISION;
	};
	readonly harness: {
		readonly name: "coda";
		readonly revision: string;
		readonly model: string;
		readonly reasoningEffort: string;
		readonly maxOutputTokens: number;
		readonly eventStream: {
			readonly mode: typeof DEEP_SWE_EVENT_STREAM_MODE;
			readonly schemaVersion: typeof DEEP_SWE_EVENT_STREAM_SCHEMA_VERSION;
		};
		readonly runBudgetEnabled: boolean;
		readonly maxTurns?: number;
		readonly runControl: {
			readonly workSec: number;
			readonly graceSec: number;
			readonly maxStationaryTurns: number;
			readonly adapterFinalizeMarginSec: number;
			readonly pierHardTimeoutSec: number;
		};
		readonly allowAllCommands: boolean;
	};
	readonly execution: {
		readonly round: number;
		readonly concurrency: number;
		readonly taskIds: readonly string[];
		readonly attempts: number;
		readonly agentCount: number;
		readonly totalPlannedPaidTrials: number;
		readonly timeBlock: string;
		readonly providerAllowlist: readonly [typeof DEEP_SWE_PROVIDER_HOST];
	};
	readonly experiment: DeepSweExperimentPlan;
	readonly images: readonly DeepSweImageLock[];
}

export interface DeepSwePaidTrialPlan {
	readonly tasks: number;
	readonly attempts: number;
	readonly agents: number;
	readonly totalPlannedPaidTrials: number;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

export interface DeepSweRunControlEnvelope {
	readonly workSec: number;
	readonly graceSec: number;
	readonly adapterFinalizeMarginSec: number;
	readonly pierHardTimeoutSec: number;
}

export function validateDeepSweRunControlEnvelope(
	input: DeepSweRunControlEnvelope,
): Readonly<DeepSweRunControlEnvelope> {
	const envelope = Object.freeze({
		workSec: positiveInteger(input.workSec, "runControlWorkSec"),
		graceSec: positiveInteger(input.graceSec, "runControlGraceSec"),
		adapterFinalizeMarginSec: positiveInteger(input.adapterFinalizeMarginSec, "adapterFinalizeMarginSec"),
		pierHardTimeoutSec: positiveInteger(input.pierHardTimeoutSec, "pierHardTimeoutSec"),
	});
	if (envelope.workSec + envelope.graceSec + envelope.adapterFinalizeMarginSec >= envelope.pierHardTimeoutSec) {
		throw new Error("RunControl requires workSec + graceSec + adapterFinalizeMarginSec < pierHardTimeoutSec");
	}
	return envelope;
}

function absolutePath(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
	return value;
}

function taskSelection(taskIds: readonly string[] | undefined): readonly string[] {
	const selection = [...(taskIds ?? DEEP_SWE_FIRST_20_TASK_IDS)];
	if (selection.length === 0) throw new Error("taskIds must contain at least one task id");
	if (selection.some((taskId) => !/^[a-z0-9][a-z0-9-]*$/.test(taskId))) {
		throw new Error("taskIds must contain literal DeepSWE task ids, not globs or paths");
	}
	if (new Set(selection).size !== selection.length) throw new Error("taskIds must be unique");
	return Object.freeze(selection);
}

function harnessRevision(value: string): string {
	if (!/^[a-zA-Z0-9._-]{7,128}$/.test(value)) {
		throw new Error("harnessRevision must be a 7-128 character revision or content digest");
	}
	return value;
}

function experimentTimeBlock(value: string | undefined, round: number): string {
	const timeBlock = value ?? `round-${String(round).padStart(2, "0")}`;
	if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(timeBlock)) {
		throw new Error("timeBlock must be a 1-128 character stable experiment label");
	}
	return timeBlock;
}

function jobName(round: number, revision: string, attempts: number): string {
	const base = `coda-deep-swe-r${String(round).padStart(2, "0")}-${revision.slice(0, 12).toLowerCase()}`;
	return attempts === 1 ? base : `${base}-a${attempts}`;
}

export function createDeepSwePierJobConfig(options: DeepSwePierJobOptions): DeepSwePierJobConfig {
	const round = positiveInteger(options.round, "round");
	const concurrency = positiveInteger(options.concurrency, "concurrency");
	const attempts = positiveInteger(options.attempts ?? 1, "attempts");
	const revision = harnessRevision(options.harnessRevision);
	const taskIds = taskSelection(options.taskIds);
	experimentTimeBlock(options.timeBlock, round);
	const model = options.model ?? DEEP_SWE_DEFAULT_MODEL;
	const reasoningEffort = options.reasoningEffort ?? DEEP_SWE_DEFAULT_REASONING;
	const maxOutputTokens = positiveInteger(
		options.maxOutputTokens ?? DEEP_SWE_DEFAULT_MAX_OUTPUT_TOKENS,
		"maxOutputTokens",
	);
	const runBudgetEnabled = options.disableRunBudget !== true;
	const maxTurns = runBudgetEnabled
		? positiveInteger(options.maxTurns ?? DEEP_SWE_DEFAULT_MAX_TURNS, "maxTurns")
		: undefined;
	const runControl = validateDeepSweRunControlEnvelope({
		workSec: options.runControlWorkSec ?? DEEP_SWE_DEFAULT_RUN_CONTROL_WORK_SEC,
		graceSec: options.runControlGraceSec ?? DEEP_SWE_DEFAULT_RUN_CONTROL_GRACE_SEC,
		adapterFinalizeMarginSec: options.adapterFinalizeMarginSec ?? DEEP_SWE_DEFAULT_ADAPTER_FINALIZE_MARGIN_SEC,
		pierHardTimeoutSec: options.pierHardTimeoutSec ?? DEEP_SWE_PIER_HARD_TIMEOUT_SEC,
	});
	const runControlStationaryTurns = positiveInteger(
		options.runControlStationaryTurns ?? DEEP_SWE_DEFAULT_RUN_CONTROL_STATIONARY_TURNS,
		"runControlStationaryTurns",
	);
	if (!model.includes("/")) throw new Error("model must use provider/model form");
	if (!reasoningEffort.trim()) throw new Error("reasoningEffort must not be empty");

	const config: DeepSwePierJobConfig = {
		job_name: jobName(round, revision, attempts),
		jobs_dir: absolutePath(options.jobsDir, "jobsDir"),
		n_attempts: attempts,
		n_concurrent_trials: concurrency,
		quiet: options.quiet ?? false,
		retry: { max_retries: 0 },
		environment: {
			type: "docker",
			force_build: false,
			delete: true,
			cpu_enforcement_policy: "auto",
			memory_enforcement_policy: "auto",
		},
		verifier: { disable: false },
		agents: [
			{
				import_path: options.adapterImportPath ?? "coda_agent:CodaAgent",
				model_name: model,
				override_setup_timeout_sec: 900,
				max_timeout_sec: runControl.pierHardTimeoutSec,
				kwargs: {
					runtime_dir: absolutePath(options.runtimeDir, "runtimeDir"),
					reasoning_effort: reasoningEffort,
					max_output_tokens: maxOutputTokens,
					event_stream_mode: DEEP_SWE_EVENT_STREAM_MODE,
					run_budget_enabled: runBudgetEnabled,
					...(maxTurns !== undefined ? { max_turns: maxTurns } : {}),
					run_control_work_sec: runControl.workSec,
					run_control_grace_sec: runControl.graceSec,
					run_control_stationary_turns: runControlStationaryTurns,
					adapter_finalize_margin_sec: runControl.adapterFinalizeMarginSec,
					pier_hard_timeout_sec: runControl.pierHardTimeoutSec,
					allow_all_commands: options.allowAllCommands ?? false,
					harness_revision: revision,
				},
				env: {
					OPENCODE_API_KEY: OPENCODE_API_KEY_TEMPLATE,
					NODE_USE_ENV_PROXY: "1",
					NODE_USE_SYSTEM_CA: "1",
				},
			},
		],
		datasets: [{ path: absolutePath(options.datasetDir, "datasetDir"), task_names: taskIds }],
	};
	return Object.freeze(config);
}

export function createDeepSweRunLock(options: DeepSwePierJobOptions): DeepSweRunLock {
	const config = createDeepSwePierJobConfig(options);
	const selected = new Set(config.datasets[0].task_names);
	const experiment = createDeepSweExperimentPlan({
		taskIds: config.datasets[0].task_names,
		attempts: config.n_attempts,
		agentCount: config.agents.length,
		timeBlock: experimentTimeBlock(options.timeBlock, options.round),
		seed: {
			availability: "unavailable",
			reason: "the Coda model request and pinned Pier adapter do not expose a Provider sampling seed",
		},
	});
	const lock: DeepSweRunLock = {
		schemaVersion: 3,
		campaignKind: "development-round",
		dataset: {
			name: "datacurve/deep-swe-1-1",
			version: DEEP_SWE_VERSION,
			sourceRevision: DEEP_SWE_DATASET_REVISION,
		},
		pier: { version: DEEP_SWE_PIER_VERSION, sourceRevision: DEEP_SWE_PIER_REVISION },
		harness: {
			name: "coda",
			revision: config.agents[0].kwargs.harness_revision,
			model: config.agents[0].model_name,
			reasoningEffort: config.agents[0].kwargs.reasoning_effort,
			maxOutputTokens: config.agents[0].kwargs.max_output_tokens,
			eventStream: {
				mode: config.agents[0].kwargs.event_stream_mode,
				schemaVersion: DEEP_SWE_EVENT_STREAM_SCHEMA_VERSION,
			},
			runBudgetEnabled: config.agents[0].kwargs.run_budget_enabled,
			...(config.agents[0].kwargs.max_turns !== undefined ? { maxTurns: config.agents[0].kwargs.max_turns } : {}),
			runControl: {
				workSec: config.agents[0].kwargs.run_control_work_sec,
				graceSec: config.agents[0].kwargs.run_control_grace_sec,
				maxStationaryTurns: config.agents[0].kwargs.run_control_stationary_turns,
				adapterFinalizeMarginSec: config.agents[0].kwargs.adapter_finalize_margin_sec,
				pierHardTimeoutSec: config.agents[0].kwargs.pier_hard_timeout_sec,
			},
			allowAllCommands: config.agents[0].kwargs.allow_all_commands,
		},
		execution: {
			round: options.round,
			concurrency: config.n_concurrent_trials,
			taskIds: config.datasets[0].task_names,
			attempts: experiment.attempts,
			agentCount: experiment.agentCount,
			totalPlannedPaidTrials: experiment.totalPlannedPaidTrials,
			timeBlock: experiment.timeBlock,
			providerAllowlist: [DEEP_SWE_PROVIDER_HOST],
		},
		experiment,
		images: DEEP_SWE_FIRST_20_IMAGE_LOCKS.filter(({ taskId }) => selected.has(taskId)),
	};
	return Object.freeze(lock);
}

export function createDeepSwePaidTrialPlan(options: DeepSwePierJobOptions): DeepSwePaidTrialPlan {
	const config = createDeepSwePierJobConfig(options);
	const tasks = config.datasets[0].task_names.length;
	const attempts = config.n_attempts;
	const agents = config.agents.length;
	const totalPlannedPaidTrials = tasks * attempts * agents;
	if (!Number.isSafeInteger(totalPlannedPaidTrials)) {
		throw new Error("total planned paid trials exceeds the safe integer range");
	}
	return Object.freeze({ tasks, attempts, agents, totalPlannedPaidTrials });
}

export function formatDeepSwePaidTrialPlan(plan: DeepSwePaidTrialPlan): string {
	const taskLabel = plan.tasks === 1 ? "task" : "tasks";
	const attemptLabel = plan.attempts === 1 ? "attempt" : "attempts";
	const agentLabel = plan.agents === 1 ? "agent" : "agents";
	return `${plan.tasks} ${taskLabel} × ${plan.attempts} ${attemptLabel} × ${plan.agents} ${agentLabel} = ${plan.totalPlannedPaidTrials} planned paid trials`;
}

export function assertDeepSwePaidTrialPlan(plan: DeepSwePaidTrialPlan, confirmedPaidTrials: number | undefined): void {
	if (confirmedPaidTrials !== undefined && confirmedPaidTrials !== plan.totalPlannedPaidTrials) {
		throw new Error(
			`--confirm-trials must equal ${plan.totalPlannedPaidTrials} (${formatDeepSwePaidTrialPlan(plan)})`,
		);
	}
	if (plan.attempts > 1 && confirmedPaidTrials === undefined) {
		throw new Error(
			`Repeated paid sampling requires --confirm-trials ${plan.totalPlannedPaidTrials} (${formatDeepSwePaidTrialPlan(plan)})`,
		);
	}
}

export function formatDeepSweImageLockTsv(locks: readonly DeepSweImageLock[] = DEEP_SWE_FIRST_20_IMAGE_LOCKS): string {
	return `${locks.map(({ taskId, image, digest }) => `${taskId}\t${image}\t${digest}`).join("\n")}\n`;
}

export function assertDeepSwePaidRun(options: {
	readonly allowPaidRequests: boolean;
	readonly confirmed: boolean;
	readonly hasApiKey: boolean;
}): void {
	if (!options.allowPaidRequests) throw new Error("Set CODA_EVALS_DEEP_SWE=1 to opt in to paid DeepSWE calls");
	if (!options.confirmed) throw new Error("Pass --confirm-spend to acknowledge paid DeepSWE Provider calls");
	if (!options.hasApiKey) throw new Error("DeepSWE evaluation requires OPENCODE_API_KEY");
}

export type {
	DeepSweCampaignReport,
	DeepSweCostAggregate,
	DeepSweEvaluationReport,
	DeepSweResourceAggregate,
	DeepSweRoundReport,
	DeepSweSummaryOptions,
	DeepSweTrialReport,
	DeepSweTrialResources,
} from "./deep-swe-report.ts";
export {
	compareDeepSweRounds,
	DEEP_SWE_REPORT_SCHEMA_VERSION,
	readDeepSweEvaluationReport,
	summarizeDeepSweJobResult,
} from "./deep-swe-report.ts";
