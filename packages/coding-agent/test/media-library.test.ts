import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { MediaLibrary } from "../src/media/media-library.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MediaLibrary", () => {
	it("sniffs, validates, and creates content-addressed original, preview, and Model renditions", async () => {
		const fixture = await setup();
		const source = join(fixture.root, "wide photo.jpg");
		await writeFile(
			source,
			await sharp({ create: { width: 3_000, height: 1_000, channels: 3, background: "#336699" } })
				.jpeg({ quality: 95 })
				.toBuffer(),
		);

		const attachment = await fixture.library.ingestPath(source);
		const asset = fixture.library.resolve(attachment.id);

		expect(asset.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(asset.filename).toBe("wide photo.jpg");
		expect(asset.mimeType).toBe("image/jpeg");
		expect([asset.width, asset.height]).toEqual([3_000, 1_000]);
		expect(asset.preview.mimeType).toBe("image/png");
		expect([asset.preview.width, asset.preview.height]).toEqual([3_000, 1_000]);
		expect(asset.model.width).toBeLessThanOrEqual(2_000);
		expect(asset.model.height).toBeLessThanOrEqual(2_000);
		expect(asset.model.bytes).toBeLessThanOrEqual(4.5 * 1024 * 1024);
		expect((await stat(asset.original.path)).mode & 0o777).toBe(0o600);
		expect((await stat(asset.preview.path)).mode & 0o777).toBe(0o600);
		expect((await stat(asset.model.path)).mode & 0o777).toBe(0o600);
		expect((await readFile(asset.original.path)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
	});

	it("deduplicates bytes while assigning collision-safe display filenames and honoring detach lifecycle", async () => {
		const fixture = await setup();
		const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: "red" } })
			.png()
			.toBuffer();
		const source = join(fixture.root, "image.png");
		await writeFile(source, bytes);

		const first = await fixture.library.ingestPath(source);
		const second = await fixture.library.ingestPath(source);
		const previewBytes = await readFile(fixture.library.resolve(first.id).preview.path);
		expect(first.filename).toBe("image.png");
		expect(second.filename).toBe("image (2).png");
		expect(first.digest).toBe(second.digest);
		expect(previewBytes).toEqual(bytes);

		const originalPath = fixture.library.resolve(first.id).original.path;
		await fixture.library.detach(first.id);
		await expect(stat(originalPath)).resolves.toBeDefined();
		await fixture.library.detach(second.id);
		await expect(stat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reports display dimensions after applying image orientation metadata", async () => {
		const fixture = await setup();
		const source = join(fixture.root, "portrait.jpg");
		await writeFile(
			source,
			await sharp({ create: { width: 20, height: 40, channels: 3, background: "white" } })
				.jpeg()
				.withMetadata({ orientation: 6 })
				.toBuffer(),
		);

		const attachment = await fixture.library.ingestPath(source);
		const asset = fixture.library.resolve(attachment.id);
		expect([asset.width, asset.height]).toEqual([40, 20]);
		expect([asset.preview.width, asset.preview.height]).toEqual([40, 20]);
	});

	it("rejects bad magic, undersized images, and prompt resource-limit overflow", async () => {
		const fixture = await setup({ maxAttachments: 2, maxFileBytes: 100_000, maxTotalBytes: 150_000 });
		const fake = join(fixture.root, "fake.png");
		await writeFile(fake, "not an image");
		await expect(fixture.library.ingestPath(fake)).rejects.toThrow(/PNG, JPEG, GIF, or WebP/);

		const tiny = join(fixture.root, "tiny.png");
		await writeFile(
			tiny,
			await sharp({ create: { width: 7, height: 10, channels: 3, background: "white" } })
				.png()
				.toBuffer(),
		);
		await expect(fixture.library.ingestPath(tiny)).rejects.toThrow(/at least 8 pixels/);

		const valid = join(fixture.root, "valid.png");
		await writeFile(
			valid,
			await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } })
				.png()
				.toBuffer(),
		);
		await fixture.library.ingestPath(valid);
		await fixture.library.ingestPath(valid);
		await expect(fixture.library.ingestPath(valid)).rejects.toThrow(/at most 2 images/);
	});

	it("atomically promotes committed assets into the Session media directory", async () => {
		const fixture = await setup();
		const source = join(fixture.root, "commit.webp");
		await writeFile(
			source,
			await sharp({ create: { width: 20, height: 20, channels: 3, background: "green" } })
				.webp()
				.toBuffer(),
		);
		const attachment = await fixture.library.ingestPath(source);
		const before = fixture.library.resolve(attachment.id);
		expect(before.committed).toBe(false);

		const [committed] = await fixture.library.commit([attachment.id]);
		expect(committed?.committed).toBe(true);
		expect(committed?.original.path.startsWith(fixture.mediaDirectory)).toBe(true);
		await expect(stat(before.original.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("releases per-Prompt attachment quota after committed handles are detached", async () => {
		const fixture = await setup({ maxAttachments: 1 });
		const source = join(fixture.root, "turn.png");
		await writeFile(
			source,
			await sharp({ create: { width: 20, height: 20, channels: 3, background: "purple" } })
				.png()
				.toBuffer(),
		);

		const first = await fixture.library.ingestPath(source);
		const [committed] = await fixture.library.commit([first.id]);
		await fixture.library.detach(first.id);
		expect(fixture.library.attachments).toEqual([]);
		await expect(stat(committed!.original.path)).resolves.toBeDefined();

		await expect(fixture.library.ingestPath(source)).resolves.toMatchObject({ filename: "turn (2).png" });
	});
});

async function setup(limits?: { maxAttachments?: number; maxFileBytes?: number; maxTotalBytes?: number }) {
	const root = await mkdtemp(join(tmpdir(), "coda-media-"));
	temporaryDirectories.push(root);
	const stagingDirectory = join(root, "staging");
	const mediaDirectory = join(root, "session", "media");
	let id = 0;
	return {
		root,
		mediaDirectory,
		library: new MediaLibrary({
			fileSystem: createNodeFileSystem(),
			stagingDirectory,
			mediaDirectory,
			idGenerator: { generate: () => `media-${++id}` },
			limits,
		}),
	};
}
