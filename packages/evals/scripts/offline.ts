import { formatHumanReport, runOfflineEvaluationSuite } from "../src/index.ts";

function fixtureIds(arguments_: readonly string[]): readonly string[] | undefined {
	const ids: string[] = [];
	for (let index = 0; index < arguments_.length; index++) {
		if (arguments_[index] !== "--fixture")
			throw new Error(`Unknown offline evaluation argument: ${arguments_[index]}`);
		const id = arguments_[index + 1];
		if (!id) throw new Error("--fixture requires an evaluation fixture id");
		ids.push(id);
		index++;
	}
	return ids.length > 0 ? ids : undefined;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("Offline Agent evaluation forbids network requests");
};

try {
	const report = await runOfflineEvaluationSuite(fixtureIds(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(report)}\n`);
	process.stderr.write(`${formatHumanReport(report)}\n`);
	if (!report.passed) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`coda evals: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	globalThis.fetch = originalFetch;
}
