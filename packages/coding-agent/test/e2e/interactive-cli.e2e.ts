import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXPECT = "/usr/bin/expect";
const CLI = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const PROMPT = "coda-e2e-ascii-prompt";
const EXPECT_PROGRAM = String.raw`
set timeout 5
log_user 1
spawn -noecho $env(CODA_E2E_CLI) \
  --interactive \
  --no-session \
  --workspace $env(CODA_E2E_WORKSPACE) \
  --model opencode-go/minimax-m3 \
  --api-key coda-e2e-test-key
expect {
  -exact "Enter sends" {}
  timeout {
    send -- "\003"
    expect eof
    exit 41
  }
  eof { exit 42 }
}
set timeout 2
send -- $env(CODA_E2E_PROMPT)
expect {
  -exact $env(CODA_E2E_PROMPT) {}
  timeout {
    send -- "\003"
    expect eof
    exit 43
  }
  eof { exit 44 }
}
send -- "\003"
expect eof
exit 0
`;

async function runCli(workspace: string, home: string, temporaryDirectory: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(EXPECT, ["-c", EXPECT_PROGRAM], {
			cwd: workspace,
			env: {
				CODA_E2E_CLI: CLI,
				CODA_E2E_PROMPT: PROMPT,
				CODA_E2E_WORKSPACE: workspace,
				HOME: home,
				LANG: "en_US.UTF-8",
				NO_COLOR: "1",
				PATH: process.env.PATH,
				TERM: "xterm-256color",
				TMPDIR: temporaryDirectory,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve(output);
			else reject(new Error(`Coda PTY exited with code ${String(code)} (${String(signal)}). Output: ${output}`));
		});
	});
}

describe.skipIf(process.platform !== "darwin")("coda interactive CLI", () => {
	it("renders an ASCII prompt typed through a real pseudo-terminal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-interactive-e2e-"));
		const home = join(directory, "home");
		const workspace = join(directory, "workspace");
		await Promise.all([mkdir(home), mkdir(workspace)]);

		try {
			const output = await runCli(workspace, home, directory);
			expect(output).toContain(PROMPT);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
