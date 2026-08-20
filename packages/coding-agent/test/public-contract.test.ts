import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

const execFileAsync = promisify(execFile);

describe("@coda/coding-agent package contract", () => {
	it("has no root SDK exports", () => {
		expect(Object.keys(publicApi)).toEqual([]);
	});

	it("publishes one root entry, one coda executable, and keeps application dependencies explicit", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			private: boolean;
			exports: Record<string, unknown>;
			bin: Record<string, string>;
			dependencies: Record<string, string>;
			scripts: Record<string, string>;
		};

		expect(packageJson.private).toBe(true);
		expect(Object.keys(packageJson.exports)).toEqual([]);
		expect(packageJson.bin).toEqual({ coda: "./dist/bin.js" });
		expect(packageJson.dependencies).toEqual({
			"@coda/agent": "0.1.0",
			"@coda/ai": "0.1.0",
			"@coda/mcp": "0.1.0",
			"@coda/permission": "0.1.0",
			"@coda/plugins": "0.1.0",
			"@coda/runtime": "0.1.0",
			"@coda/sandbox": "0.1.0",
			"@coda/skills": "0.1.0",
			"@coda/tui": "0.1.0",
			"@mozilla/readability": "^0.6.0",
			fflate: "^0.8.3",
			jsdom: "^29.1.1",
			mammoth: "^1.12.1",
			"pdfjs-dist": "^6.2.108",
			sharp: "0.34.4",
			turndown: "^7.2.4",
			"turndown-plugin-gfm": "^1.0.2",
			undici: "^7.29.0",
			yaml: "2.9.0",
		});
		expect(packageJson.scripts.build).toContain("node scripts/mark-bin-executable.mjs dist/bin.js");
	});

	it("marks the generated coda bin as executable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "coda-bin-contract-"));
		const target = join(directory, "bin.js");
		try {
			await writeFile(target, "#!/usr/bin/env node\n", { mode: 0o644 });
			await execFileAsync(process.execPath, [
				fileURLToPath(new URL("../scripts/mark-bin-executable.mjs", import.meta.url)),
				target,
			]);
			expect((await stat(target)).mode & 0o111).not.toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
