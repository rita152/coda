import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve("@modelcontextprotocol/conformance/package.json"));
const conformanceCli = join(packageDirectory, "dist", "index.js");
const client = fileURLToPath(new URL("./client.mjs", import.meta.url));
const scenarios = [
	"tools_call",
	"request-metadata",
	"sep-2322-client-request-state",
	"http-standard-headers",
	"http-custom-headers",
	"http-invalid-tool-headers",
	"json-schema-ref-no-deref",
];

function shellArgument(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runScenario(scenario, outputDirectory) {
	await new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				conformanceCli,
				"client",
				"--command",
				`${shellArgument(process.execPath)} ${shellArgument(client)}`,
				"--scenario",
				scenario,
				"--spec-version",
				"2026-07-28",
				"--output-dir",
				join(outputDirectory, scenario.replaceAll("/", "-")),
			],
			{ stdio: "inherit" },
		);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Conformance scenario ${scenario} failed (${signal ?? `exit ${code}`})`));
		});
	});
}

const outputDirectory = await mkdtemp(join(tmpdir(), "coda-mcp-conformance-"));
try {
	for (const scenario of scenarios) await runScenario(scenario, outputDirectory);
} finally {
	await rm(outputDirectory, { recursive: true, force: true });
}
