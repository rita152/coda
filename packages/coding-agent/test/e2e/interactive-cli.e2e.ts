import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// boundary-exception: the cross-package terminal e2e reuses the strict virtual-screen assertion harness.
import { StrictScreen } from "../../../tui/test/support/strict-screen.ts";

const EXPECT = "/usr/bin/expect";
const CLI = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const PROMPT = "coda-e2e-ascii-prompt";
const COOKED_INPUT = "coda-e2e-cooked-input";
const SHELL_PROMPT = "CODA_E2E_SHELL> ";
const SCROLL_SESSION = "session-scroll-e2e";
const EDITOR_SESSION = "session-editor-e2e";
const LAUNCH_COMMAND = `before=$(stty -g); "$CODA_E2E_CLI" --interactive --no-session --workspace "$CODA_E2E_WORKSPACE" --model opencode-go/minimax-m3 --api-key coda-e2e-test-key; coda_status=$?`;
const SCROLL_LAUNCH_COMMAND = `"$CODA_E2E_CLI" --interactive --resume "$CODA_E2E_SESSION" --workspace "$CODA_E2E_WORKSPACE" --model opencode-go/minimax-m3 --api-key coda-e2e-test-key; coda_status=$?`;
const VERIFY_COMMAND = String.raw`after=$(stty -g); if [[ "$before" == "$after" ]]; then tty_state=restored; else tty_state=changed; fi; printf '\nCODA_E2E_EXIT=%s\nCODA_E2E_TTY=%s\nCODA_E2E_READY\n' "$coda_status" "$tty_state"; IFS= read -r cooked_input; printf 'CODA_E2E_COOKED=%s\n' "$cooked_input"`;
const EXPECT_PROGRAM = String.raw`
set timeout 8
log_user 1
spawn -noecho /bin/zsh -dfi
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 40 }
  eof { exit 41 }
}
send -i $spawn_id -- "$env(CODA_E2E_LAUNCH_COMMAND)\r"
expect {
  -exact "Coda" {}
  timeout {
    send -- "\003"
    expect eof
    exit 41
  }
  eof { exit 42 }
}
set timeout 5
set send_slow {1 0.01}
send -i $spawn_id -s -- $env(CODA_E2E_PROMPT)
expect {
  -exact $env(CODA_E2E_PROMPT) {}
  timeout {
    send -- "\003"
    expect eof
    exit 43
  }
  eof { exit 44 }
}
stty rows 31 columns 101 < $spawn_out(slave,name)
after 100
set shell_pid [exp_pid -i $spawn_id]
set cli_pid [lindex [split [string trim [exec pgrep -P $shell_pid]] "\n"] 0]
exec kill -TERM $cli_pid
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 45 }
  eof { exit 46 }
}
send -i $spawn_id -- "$env(CODA_E2E_VERIFY_COMMAND)\r"
expect {
  -exact "CODA_E2E_READY" {}
  timeout { exit 47 }
  eof { exit 48 }
}
send -i $spawn_id -- "$env(CODA_E2E_COOKED)\r"
expect {
  -exact "CODA_E2E_COOKED=$env(CODA_E2E_COOKED)" {}
  timeout { exit 49 }
  eof { exit 50 }
}
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 51 }
  eof { exit 52 }
}
send -i $spawn_id -- "exit\r"
expect eof
exit 0
`;

const SCROLL_EXPECT_PROGRAM = String.raw`
set timeout 8
log_user 1
spawn -noecho /bin/zsh -dfi
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 60 }
  eof { exit 61 }
}
stty rows 18 columns 80 < $spawn_out(slave,name)
send -i $spawn_id -- "$env(CODA_E2E_LAUNCH_COMMAND)\r"
expect {
  -exact "scroll-e2e-message-16" {}
  timeout { exit 62 }
  eof { exit 63 }
}
set timeout 2
send -i $spawn_id -- $env(CODA_E2E_WHEEL_UP)
expect {
  -exact "scroll-e2e-message-01" {}
  timeout {
    set shell_pid [exp_pid -i $spawn_id]
    set cli_pid [lindex [split [string trim [exec pgrep -P $shell_pid]] "\n"] 0]
    exec kill -TERM $cli_pid
    expect -exact $env(CODA_E2E_SHELL_PROMPT)
    exit 64
  }
  eof { exit 65 }
}
send -i $spawn_id -- $env(CODA_E2E_WHEEL_DOWN)
expect {
  -exact "scroll-e2e-message-16" {}
  timeout { exit 66 }
  eof { exit 67 }
}
set shell_pid [exp_pid -i $spawn_id]
set cli_pid [lindex [split [string trim [exec pgrep -P $shell_pid]] "\n"] 0]
exec kill -TERM $cli_pid
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 68 }
  eof { exit 69 }
}
send -i $spawn_id -- "exit\r"
expect eof
exit 0
`;

const EDITOR_EXPECT_PROGRAM = String.raw`
set timeout 8
log_user 1
spawn -noecho /bin/zsh -dfi
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 70 }
  eof { exit 71 }
}
stty rows 20 columns 60 < $spawn_out(slave,name)
send -i $spawn_id -- "$env(CODA_E2E_LAUNCH_COMMAND)\r"
expect {
  -exact "sent-e2e-prompt" {}
  timeout { exit 72 }
  eof { exit 73 }
}
expect {
  -exact "opencode-go/minimax-m3(medium)" {}
  timeout { exit 74 }
  eof { exit 75 }
}
send -i $spawn_id -- "first-line"
send -i $spawn_id -- "\033\[27;2;13~"
send -i $spawn_id -- "second-line"
expect {
  -exact "second-line" {}
  timeout { exit 76 }
  eof { exit 77 }
}
set shell_pid [exp_pid -i $spawn_id]
set cli_pid [lindex [split [string trim [exec pgrep -P $shell_pid]] "\n"] 0]
exec kill -TERM $cli_pid
expect {
  -exact $env(CODA_E2E_SHELL_PROMPT) {}
  timeout { exit 78 }
  eof { exit 79 }
}
send -i $spawn_id -- "exit\r"
expect eof
exit 0
`;

async function runCli(
	workspace: string,
	home: string,
	temporaryDirectory: string,
	options: {
		readonly program?: string;
		readonly environment?: Readonly<Record<string, string>>;
	} = {},
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(EXPECT, ["-c", options.program ?? EXPECT_PROGRAM], {
			cwd: workspace,
			env: {
				CODA_E2E_CLI: CLI,
				CODA_E2E_COOKED: COOKED_INPUT,
				CODA_E2E_LAUNCH_COMMAND: LAUNCH_COMMAND,
				CODA_E2E_PROMPT: PROMPT,
				CODA_E2E_SHELL_PROMPT: SHELL_PROMPT,
				CODA_E2E_VERIFY_COMMAND: VERIFY_COMMAND,
				CODA_E2E_WORKSPACE: workspace,
				HOME: home,
				LANG: "en_US.UTF-8",
				NO_COLOR: "1",
				PATH: process.env.PATH,
				PROMPT: SHELL_PROMPT,
				PS1: SHELL_PROMPT,
				TERM: "xterm-256color",
				TMPDIR: temporaryDirectory,
				...options.environment,
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

async function writeScrollSession(home: string, workspace: string): Promise<void> {
	const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0, 32);
	const directory = join(home, ".coda", "sessions", workspaceId);
	await mkdir(directory, { recursive: true });
	const header = {
		type: "session",
		version: 2,
		sessionId: SCROLL_SESSION,
		workspaceId,
		workspacePath: workspace,
		createdAt: 1_000,
	};
	const records = Array.from({ length: 16 }, (_, offset) => {
		const sequence = offset + 1;
		return {
			type: "message_committed",
			recordId: `record:scroll:${sequence}`,
			sessionId: SCROLL_SESSION,
			sequence,
			previousRecordId: sequence === 1 ? null : `record:scroll:${sequence - 1}`,
			timestamp: 1_000 + sequence,
			payload: {
				message: {
					id: `message:scroll:${sequence}`,
					message: {
						role: "user",
						content: `scroll-e2e-message-${String(sequence).padStart(2, "0")}`,
						timestamp: 1_000 + sequence,
					},
				},
			},
		};
	});
	await writeFile(
		join(directory, `${SCROLL_SESSION}.jsonl`),
		`${[header, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		{ mode: 0o600 },
	);
}

async function writeEditorSession(home: string, workspace: string): Promise<void> {
	const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0, 32);
	const directory = join(home, ".coda", "sessions", workspaceId);
	await mkdir(directory, { recursive: true });
	const header = {
		type: "session",
		version: 3,
		sessionId: EDITOR_SESSION,
		workspaceId,
		workspacePath: workspace,
		createdAt: 1_000,
	};
	const record = {
		type: "message_committed",
		recordId: "record:editor:1",
		sessionId: EDITOR_SESSION,
		sequence: 1,
		previousRecordId: null,
		timestamp: 1_001,
		payload: {
			message: {
				id: "message:editor:1",
				message: { role: "user", content: "sent-e2e-prompt", timestamp: 1_001 },
			},
		},
	};
	await writeFile(
		join(directory, `${EDITOR_SESSION}.jsonl`),
		`${JSON.stringify(header)}\n${JSON.stringify(record)}\n`,
		{
			mode: 0o600,
		},
	);
}

describe.skipIf(process.platform !== "darwin")("coda interactive CLI", () => {
	it("renders sent Prompt cards and accepts a real multiline xterm editor draft", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-interactive-editor-e2e-"));
		const home = join(directory, "home");
		const workspace = join(directory, "workspace");
		await Promise.all([mkdir(home), mkdir(workspace)]);

		try {
			const canonicalWorkspace = await realpath(workspace);
			await writeEditorSession(home, canonicalWorkspace);
			const output = await runCli(canonicalWorkspace, home, directory, {
				program: EDITOR_EXPECT_PROGRAM,
				environment: {
					CODA_E2E_LAUNCH_COMMAND: SCROLL_LAUNCH_COMMAND,
					CODA_E2E_SESSION: EDITOR_SESSION,
				},
			});

			expect(output).toContain("sent-e2e-prompt");
			expect(output).toContain("first-line");
			expect(output).toContain("second-line");
			expect(output).not.toContain("[terminal.unknown-input]");
			const alternateStart = output.indexOf("\x1b[?1049h");
			const alternateEnd = output.indexOf("\x1b[?1049l", alternateStart);
			expect(alternateStart).toBeGreaterThanOrEqual(0);
			expect(alternateEnd).toBeGreaterThan(alternateStart);
			const screen = new StrictScreen(60, 20);
			screen.write(output.slice(alternateStart, alternateEnd));
			const viewport = screen.viewport();
			const firstRow = viewport.findIndex((line) => line.includes("first-line"));
			const secondRow = viewport.findIndex((line) => line.includes("second-line"));
			expect(firstRow).toBeGreaterThanOrEqual(0);
			expect(secondRow).toBe(firstRow + 1);
			expect(output).toContain("─".repeat(60));
			expect(output).toContain("\x1b[?25h");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("scrolls a long Timeline with real terminal wheel input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-interactive-scroll-e2e-"));
		const home = join(directory, "home");
		const workspace = join(directory, "workspace");
		await Promise.all([mkdir(home), mkdir(workspace)]);

		try {
			const canonicalWorkspace = await realpath(workspace);
			await writeScrollSession(home, canonicalWorkspace);
			const output = await runCli(canonicalWorkspace, home, directory, {
				program: SCROLL_EXPECT_PROGRAM,
				environment: {
					CODA_E2E_LAUNCH_COMMAND: SCROLL_LAUNCH_COMMAND,
					CODA_E2E_SESSION: SCROLL_SESSION,
					CODA_E2E_WHEEL_DOWN: "\x1b[<65;10;10M".repeat(20),
					CODA_E2E_WHEEL_UP: "\x1b[<64;10;10M".repeat(20),
				},
			});

			expect(output.indexOf("scroll-e2e-message-16")).toBeLessThan(output.indexOf("scroll-e2e-message-01"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("restores the terminal after a resized full-screen interactive session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-interactive-e2e-"));
		const home = join(directory, "home");
		const workspace = join(directory, "workspace");
		await Promise.all([mkdir(home), mkdir(workspace)]);

		try {
			const output = await runCli(workspace, home, directory);
			expect(output).toContain(PROMPT);
			expect(output).toContain("\x1b[?1049h");
			expect(output).toContain("\x1b[?7l");
			expect(output).toContain("\x1b[?1003h\x1b[?1006h");
			expect(output).toContain("\x1b[?1003l\x1b[?1006l");
			expect(output).toContain("\x1b[?7h");
			expect(output).toContain("\x1b[?1049l");
			expect(output).toContain("\x1b[?25h");
			expect(output.indexOf("\x1b[?1049h")).toBeLessThan(output.indexOf("\x1b[?1049l"));
			expect(output.split("\x1b[2J\x1b[H").length - 1).toBeGreaterThanOrEqual(3);
			expect(output).toContain("CODA_E2E_EXIT=143");
			expect(output).toContain("CODA_E2E_TTY=restored");
			expect(output).toContain(`CODA_E2E_COOKED=${COOKED_INPUT}`);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
