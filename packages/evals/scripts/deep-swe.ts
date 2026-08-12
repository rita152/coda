import { runDeepSweCli } from "../src/deep-swe-cli.ts";

try {
	process.exitCode = await runDeepSweCli(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`coda DeepSWE evals: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
