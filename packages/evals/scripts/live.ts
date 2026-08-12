import type { ModelStream } from "@coda/agent";
import type { Model, ThinkingLevel, TimeRuntime } from "@coda/ai";
import { formatHumanReport, runLiveEvaluationSuite } from "../src/index.ts";

interface LiveArguments {
	readonly confirmed: boolean;
	readonly fixtureIds: readonly string[];
	readonly all: boolean;
	readonly maxModelCalls: number;
}

function parseArguments(arguments_: readonly string[]): LiveArguments {
	let confirmed = false;
	let all = false;
	let maxModelCalls = 12;
	const fixtureIds: string[] = [];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index]!;
		if (argument === "--confirm-spend") confirmed = true;
		else if (argument === "--all") all = true;
		else if (argument === "--fixture") {
			const id = arguments_[++index];
			if (!id) throw new Error("--fixture requires an evaluation fixture id");
			fixtureIds.push(id);
		} else if (argument === "--max-model-calls") {
			const value = Number(arguments_[++index]);
			if (!Number.isInteger(value) || value < 1) throw new Error("--max-model-calls requires a positive integer");
			maxModelCalls = value;
		} else throw new Error(`Unknown live evaluation argument: ${argument}`);
	}
	if (all && fixtureIds.length > 0) throw new Error("Use either --all or --fixture, not both");
	return { confirmed, fixtureIds, all, maxModelCalls };
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Live evaluation requires ${name}`);
	return value;
}

function optionalPrice(name: string): number | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative USD-per-million rate`);
	return parsed;
}

function abortableWait(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timeout = setTimeout(resolve, delayMs);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

try {
	const arguments_ = parseArguments(process.argv.slice(2));
	if (process.env.CODA_EVALS_LIVE !== "1") throw new Error("Set CODA_EVALS_LIVE=1 to opt in to paid Provider calls");
	if (!arguments_.confirmed) throw new Error("Pass --confirm-spend to acknowledge paid Provider calls");
	if (!arguments_.all && arguments_.fixtureIds.length === 0) {
		throw new Error("Select at least one --fixture, or pass --all explicitly");
	}

	const apiKey = process.env.CODA_EVALS_API_KEY ?? requiredEnvironment("OPENAI_API_KEY");
	const modelId = requiredEnvironment("CODA_EVALS_MODEL");
	const input = optionalPrice("CODA_EVALS_INPUT_COST");
	const output = optionalPrice("CODA_EVALS_OUTPUT_COST");
	const cacheRead = optionalPrice("CODA_EVALS_CACHE_READ_COST");
	const cacheWrite = optionalPrice("CODA_EVALS_CACHE_WRITE_COST");
	const rates = [input, output, cacheRead, cacheWrite];
	const priceDataAvailable = rates.every((rate) => rate !== undefined);
	if (rates.some((rate) => rate !== undefined) && !priceDataAvailable) {
		throw new Error("Supply all four CODA_EVALS_*_COST rates or omit all of them");
	}
	const clock = { now: () => Date.now() };
	const runtime: TimeRuntime = {
		clock,
		sleep: { wait: abortableWait },
		random: { next: () => Math.random() },
	};
	const model: Model<"openai-responses"> = {
		id: modelId,
		name: modelId,
		api: "openai-responses",
		provider: process.env.CODA_EVALS_PROVIDER ?? "openai",
		baseUrl: process.env.CODA_EVALS_BASE_URL ?? "https://api.openai.com/v1",
		reasoning: process.env.CODA_EVALS_REASONING !== "off",
		input: ["text"],
		...(priceDataAvailable
			? { cost: { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite! } }
			: {}),
		contextWindow: Number(process.env.CODA_EVALS_CONTEXT_WINDOW ?? 128_000),
		maxTokens: Number(process.env.CODA_EVALS_MAX_TOKENS ?? 16_384),
	};
	const reasoning = process.env.CODA_EVALS_REASONING;
	const { streamSimple } = await import("@coda/ai/api/openai-responses");
	const stream: ModelStream = ({ context, signal }) =>
		streamSimple(model, context, {
			apiKey,
			runtime,
			signal,
			...(reasoning && reasoning !== "off" ? { reasoning: reasoning as ThinkingLevel } : {}),
		});
	const fixtureIds = arguments_.all ? undefined : arguments_.fixtureIds;
	const report = await runLiveEvaluationSuite({
		allowPaidRequests: true,
		fixtureIds: fixtureIds ?? [
			"cross-file-bug-fix",
			"feature-plus-tests",
			"diagnose-only",
			"tool-failure-recovery",
			"repeated-exploration",
			"permission-denial",
			"prompt-injection-sensitive-read",
			"continuation-after-compaction",
		],
		stream,
		clock,
		maxModelCalls: arguments_.maxModelCalls,
		priceDataAvailable,
	});
	process.stdout.write(`${JSON.stringify(report)}\n`);
	process.stderr.write(`${formatHumanReport(report)}\n`);
	if (!report.passed) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`coda live evals: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
