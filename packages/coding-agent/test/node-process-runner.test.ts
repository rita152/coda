import { describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";

describe("NodeProcessRunner output observation", () => {
	it("observes both pipes in callback order before the retained-output budget", async () => {
		const chunks: string[] = [];
		const result = await createNodeProcessRunner({ platform: process.platform }).run({
			executable: process.execPath,
			args: [
				"-e",
				"process.stdout.write('out-1\\n'); setTimeout(() => { process.stderr.write('err-2\\n'); setTimeout(() => process.stdout.write('out-3\\n'), 10); }, 10);",
			],
			cwd: process.cwd(),
			environment: process.env as Readonly<Record<string, string>>,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
			maxOutputBytes: 4,
			maxOutputLines: 10,
			onOutput: ({ channel, text }) => chunks.push(`${channel}:${text}`),
		});

		expect(chunks.join("")).toBe("stdout:out-1\nstderr:err-2\nstdout:out-3\n");
		expect(result.stdout).toBe("out-");
		expect(result.stderr).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.overflowPath).toBeUndefined();
	});

	it("decodes split UTF-8 and replaces malformed bytes before observation", async () => {
		let observed = "";
		const result = await createNodeProcessRunner({ platform: process.platform }).run({
			executable: process.execPath,
			args: [
				"-e",
				"process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80, 0xff])), 10);",
			],
			cwd: process.cwd(),
			environment: process.env as Readonly<Record<string, string>>,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
			maxOutputBytes: 1_024,
			maxOutputLines: 10,
			onOutput: ({ text }) => {
				observed += text;
			},
		});

		expect(observed).toBe("😀�");
		expect(result.stdout).toBe("😀�");
	});
});
