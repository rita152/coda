import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { cleanupSessionMedia } from "../src/maintenance/session-media.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Session media cleanup", () => {
	it("removes only expired unreferenced assets and fails closed for corrupt journals", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-media-cleanup-"));
		temporaryDirectories.push(home);
		const workspace = join(home, ".coda", "sessions", "workspace");
		const media = join(workspace, "session-one.jsonl.media");
		const corruptMedia = join(workspace, "session-corrupt.jsonl.media");
		await mkdir(media, { recursive: true });
		await mkdir(corruptMedia, { recursive: true });
		const referencedDigest = "a".repeat(64);
		const orphanDigest = "b".repeat(64);
		const corruptDigest = "c".repeat(64);
		const referenced = join(media, `${referencedDigest}.model.png`);
		const orphan = join(media, `${orphanDigest}.preview.png`);
		const protectedByCorruption = join(corruptMedia, `${corruptDigest}.model.png`);
		await writeFile(referenced, "referenced");
		await writeFile(orphan, "orphan");
		await writeFile(protectedByCorruption, "protected");
		await writeFile(
			join(workspace, "session-one.jsonl"),
			`${JSON.stringify({ type: "session", version: 2 })}\n${JSON.stringify({ payload: { type: "media", digest: referencedDigest } })}\n`,
		);
		await writeFile(join(workspace, "session-corrupt.jsonl"), "{invalid\n");
		const now = 10 * 24 * 60 * 60 * 1_000;
		await utimes(referenced, 0, 0);
		await utimes(orphan, 0, 0);
		await utimes(protectedByCorruption, 0, 0);
		const diagnostics = vi.fn();

		const result = await cleanupSessionMedia({
			fileSystem: createNodeFileSystem(),
			homeDirectory: home,
			now,
			diagnostics,
		});

		expect(result.removed).toEqual([orphan]);
		await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(referenced)).resolves.toBeUndefined();
		await expect(access(protectedByCorruption)).resolves.toBeUndefined();
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "session-media.reference-scan-failed" }),
		);
	});
});
