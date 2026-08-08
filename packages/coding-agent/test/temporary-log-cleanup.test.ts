import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { cleanupTemporaryLogs } from "../src/maintenance/temporary-logs.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("temporary log cleanup", () => {
	it("removes expired and over-budget logs while preserving active Session references", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-cleanup-"));
		temporaryDirectories.push(home);
		const temporary = join(home, ".coda", "tmp");
		const sessionDirectory = join(home, ".coda", "sessions", "workspace-1");
		await mkdir(temporary, { recursive: true });
		await mkdir(sessionDirectory, { recursive: true });
		const expired = join(temporary, "expired.log");
		const referenced = join(temporary, "referenced.log");
		const oldest = join(temporary, "oldest.log");
		const newest = join(temporary, "newest.log");
		await writeFile(expired, "expired");
		await writeFile(referenced, "referenced");
		await writeFile(oldest, "12345678");
		await writeFile(newest, "abcdefgh");
		const now = 10 * 24 * 60 * 60 * 1_000;
		await utimes(expired, 0, 0);
		await utimes(referenced, 0, 0);
		await utimes(oldest, new Date(now - 2_000), new Date(now - 2_000));
		await utimes(newest, new Date(now - 1_000), new Date(now - 1_000));
		const sessionPath = join(sessionDirectory, "session-1.jsonl");
		await writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 1 })}\n${JSON.stringify({ payload: { overflowPath: referenced } })}\n`,
		);
		await writeFile(`${sessionPath}.lock`, "active");

		const result = await cleanupTemporaryLogs({
			fileSystem: createNodeFileSystem(),
			homeDirectory: home,
			now,
			retentionMs: 7 * 24 * 60 * 60 * 1_000,
			maxTotalBytes: 18,
		});

		expect(result.removed).toEqual([expired, oldest]);
		await expect(access(expired)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(oldest)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(referenced)).resolves.toBeUndefined();
		await expect(access(newest)).resolves.toBeUndefined();
	});
});
