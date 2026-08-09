import type { Diagnostic } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationIO, ApplicationOutput } from "../src/application.ts";
import { FullScreenOutputGate, FullScreenOutputScope } from "../src/interactive/full-screen-output.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = true;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

function setup() {
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	const raw: ApplicationIO = {
		stdin: { isTTY: true, readAll: async () => "" },
		stdout,
		stderr,
	};
	return { gate: new FullScreenOutputGate(raw), stderr, stdout };
}

describe("FullScreenOutputGate", () => {
	it("presents diagnostics and buffers application stdout and stderr until its lease is released", async () => {
		const { gate, stderr, stdout } = setup();
		const presented = vi.fn<(diagnostic: Diagnostic) => void>();
		const lease = gate.acquire({ presentDiagnostic: presented });

		await gate.io.stdout.write("buffered stdout\n");
		await gate.io.stderr.write("buffered stderr\n");
		await gate.diagnostics({
			code: "terminal.unknown-input",
			message: "Terminal emitted an unknown escape sequence",
			details: { sequence: "\x1b[27;2;13~" },
		});

		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("");
		expect(presented).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "terminal.unknown-input",
				details: { sequence: "\x1b[27;2;13~" },
			}),
		);

		await lease.release();
		expect(stdout.value).toBe("buffered stdout\n");
		expect(stderr.value).toBe("buffered stderr\n");
	});

	it("defers renderer diagnostics until after full-screen exit", async () => {
		const { gate, stderr } = setup();
		const presented = vi.fn<(diagnostic: Diagnostic) => void>();
		const lease = gate.acquire({ presentDiagnostic: presented });

		await gate.diagnostics({
			code: "renderer.failure",
			message: "render\n\x1b[2Jfailed",
			details: { sequence: "\x1b[999~", c1: "\u009b2J" },
		});

		expect(presented).not.toHaveBeenCalled();
		expect(stderr.value).toBe("");
		await lease.release();
		expect(stderr.value).toContain("coda: [renderer.failure] render failed");
		expect(stderr.value).toContain('sequence="\\u001b[999~"');
		expect(stderr.value).toContain('c1="\\u009b2J"');
		expect(stderr.value).not.toContain("\x1b");
		expect(stderr.value).not.toContain("\u009b");
		expect(stderr.value.split("\n")).toHaveLength(2);
	});

	it("bounds deferred renderer diagnostics while preserving an overflow report", async () => {
		const { gate, stderr } = setup();
		const lease = gate.acquire({ presentDiagnostic: () => undefined });
		for (let index = 0; index < 65; index++) {
			await gate.diagnostics({ code: "renderer.failure", message: `failure ${index}` });
		}

		await lease.release();

		expect(stderr.value).not.toContain("failure 0\n");
		expect(stderr.value).toContain("failure 64\n");
		expect(stderr.value).toContain("[diagnostic.buffer-overflow] Dropped 1 older full-screen diagnostic");
	});

	it("releases buffered output even when full-screen shutdown fails", async () => {
		const { gate, stderr } = setup();
		const scope = new FullScreenOutputScope(gate, { presentDiagnostic: () => undefined });
		await expect(scope.start(async () => true)).resolves.toBe(true);
		await gate.io.stderr.write("buffered before failure\n");

		await expect(
			scope.stop(async () => {
				throw new Error("shutdown failed");
			}),
		).rejects.toThrow("shutdown failed");

		expect(stderr.value).toBe("buffered before failure\n");
		await gate.io.stderr.write("after failure\n");
		expect(stderr.value).toBe("buffered before failure\nafter failure\n");
	});
});
