import type { EvaluationSuiteReport, EvaluationUsage } from "./types.ts";

function usageSummary(usage: EvaluationUsage): string {
	const price = usage.priceDataAvailable ? ` · $${(usage.priceUsd ?? 0).toFixed(6)}` : " · price unavailable";
	return `${usage.totalTokens} tokens${price}`;
}

export function formatHumanReport(report: EvaluationSuiteReport): string {
	const status = report.passed ? "PASS" : "FAIL";
	const header = [
		`${status} Coda Agent evaluation (${report.mode})`,
		`${report.summary.passed}/${report.summary.fixtures} fixtures passed · score ${report.summary.averageScore.toFixed(1)} · ${report.summary.turnCount} Turns · ${report.summary.toolCount} Tools`,
		`${report.summary.repeatedToolBatches} repeated Tool batches · ${report.summary.elapsedMs}ms · ${usageSummary(report.summary.usage)}`,
	];
	const fixtures = report.fixtures.map((fixture) => {
		const result = fixture.passed ? "PASS" : "FAIL";
		const details = [
			`${fixture.metrics.turnCount} Turns/${fixture.metrics.toolCount} Tools`,
			`tests ${fixture.acceptance.finalStatus}`,
			fixture.finalFileState.matchesExpected ? "state match" : "state mismatch",
			fixture.finalClaims.agrees ? "claims agree" : "claims disagree",
		];
		const failure = fixture.failures.length > 0 ? ` — ${fixture.failures.join("; ")}` : "";
		return `${result} ${fixture.id} ${fixture.score}/100 · ${details.join(" · ")}${failure}`;
	});
	return [...header, ...fixtures].join("\n");
}
