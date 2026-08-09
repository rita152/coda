import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import type { ImageContent } from "@coda/ai";
import { sanitizeTerminalText } from "@coda/tui";
import sharp from "sharp";
import type { FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";

export interface MediaLimits {
	readonly maxAttachments: number;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly maxPixels: number;
	readonly minShortEdge: number;
	readonly modelMaxLongEdge: number;
	readonly modelMaxBytes: number;
}

export interface MediaRendition {
	readonly path: string;
	readonly mimeType: "image/png" | "image/jpeg";
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
}

export interface MediaOriginal {
	readonly path: string;
	readonly bytes: number;
}

export interface MediaAsset {
	readonly digest: string;
	readonly modelDigest: string;
	readonly filename: string;
	readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	readonly committed: boolean;
	readonly original: MediaOriginal;
	readonly preview: MediaRendition;
	readonly model: MediaRendition;
}

export interface MediaAttachment {
	readonly id: string;
	readonly digest: string;
	readonly filename: string;
}

export interface MediaLibraryOptions {
	readonly fileSystem: FileSystem;
	readonly stagingDirectory: string;
	readonly mediaDirectory: string;
	readonly idGenerator: IdGenerator;
	readonly limits?: Partial<MediaLimits>;
}

interface StoredMedia {
	readonly digest: string;
	readonly modelDigest: string;
	readonly mimeType: MediaAsset["mimeType"];
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	readonly originalExtension: string;
	originalPath: string;
	preview: MediaRendition;
	model: MediaRendition;
	committed: boolean;
	references: number;
	readonly protectedPaths: Set<string>;
}

interface AttachmentRecord extends MediaAttachment {
	readonly bytes: number;
}

const DEFAULT_LIMITS: MediaLimits = Object.freeze({
	maxAttachments: 10,
	maxFileBytes: 20 * 1024 * 1024,
	maxTotalBytes: 50 * 1024 * 1024,
	maxPixels: 16_000_000,
	minShortEdge: 8,
	modelMaxLongEdge: 2_000,
	modelMaxBytes: Math.floor(4.5 * 1024 * 1024),
});

const EXTENSION_BY_MIME: Readonly<Record<MediaAsset["mimeType"], string>> = Object.freeze({
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
});

/** Owns staged and committed image bytes without exposing Sharp or filesystem choreography. */
export class MediaLibrary {
	readonly #fileSystem: FileSystem;
	readonly #stagingDirectory: string;
	readonly #mediaDirectory: string;
	readonly #idGenerator: IdGenerator;
	readonly #limits: MediaLimits;
	readonly #stored = new Map<string, StoredMedia>();
	readonly #storedByModelDigest = new Map<string, StoredMedia>();
	readonly #attachments = new Map<string, AttachmentRecord>();
	readonly #filenameUses = new Map<string, number>();
	#totalBytes = 0;

	constructor(options: MediaLibraryOptions) {
		this.#fileSystem = options.fileSystem;
		this.#stagingDirectory = options.stagingDirectory;
		this.#mediaDirectory = options.mediaDirectory;
		this.#idGenerator = options.idGenerator;
		this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
		validateLimits(this.#limits);
	}

	get attachments(): readonly MediaAttachment[] {
		return Object.freeze(
			[...this.#attachments.values()].map(({ id, digest, filename }) => ({ id, digest, filename })),
		);
	}

	async ingestPath(path: string): Promise<MediaAttachment> {
		this.#assertCountAvailable();
		const status = await this.#fileSystem.stat(path);
		if (status.kind !== "file") throw new Error("Image attachment path must refer to a regular file");
		if (status.size > this.#limits.maxFileBytes) {
			throw new Error(`Image exceeds the ${formatMiB(this.#limits.maxFileBytes)} MiB per-file limit`);
		}
		const bytes = await this.#fileSystem.readFile(path);
		if (bytes.byteLength !== status.size && bytes.byteLength > this.#limits.maxFileBytes) {
			throw new Error(`Image exceeds the ${formatMiB(this.#limits.maxFileBytes)} MiB per-file limit`);
		}
		return this.ingestBytes(bytes, basename(path));
	}

	async ingestBytes(bytes: Uint8Array, filename: string): Promise<MediaAttachment> {
		this.#assertCountAvailable();
		if (bytes.byteLength === 0 || bytes.byteLength > this.#limits.maxFileBytes) {
			throw new Error(`Image must be non-empty and at most ${formatMiB(this.#limits.maxFileBytes)} MiB`);
		}
		if (this.#totalBytes + bytes.byteLength > this.#limits.maxTotalBytes) {
			throw new Error(`Attached images exceed the ${formatMiB(this.#limits.maxTotalBytes)} MiB prompt limit`);
		}
		const mimeType = sniffImageMime(bytes);
		if (!mimeType) throw new Error("Image must contain magic-sniffed PNG, JPEG, GIF, or WebP data");
		const digest = createHash("sha256").update(bytes).digest("hex");
		let stored = this.#stored.get(digest);
		if (!stored) {
			stored = await this.#prepareStoredMedia(bytes, digest, mimeType);
			this.#stored.set(digest, stored);
			this.#storedByModelDigest.set(stored.modelDigest, stored);
		}
		const safeFilename = this.#allocateFilename(filename, mimeType);
		const id = `attachment:${safeIdentity(this.#idGenerator.generate("queue_item"))}`;
		if (this.#attachments.has(id)) throw new Error("Media IdGenerator returned a duplicate identity");
		const attachment: AttachmentRecord = Object.freeze({
			id,
			digest,
			filename: safeFilename,
			bytes: bytes.byteLength,
		});
		this.#attachments.set(id, attachment);
		stored.references++;
		this.#totalBytes += bytes.byteLength;
		return Object.freeze({ id, digest, filename: safeFilename });
	}

	resolve(attachmentId: string): MediaAsset {
		const attachment = this.#attachments.get(attachmentId);
		if (!attachment) throw new Error(`Unknown Media Attachment: ${attachmentId}`);
		const stored = this.#stored.get(attachment.digest);
		if (!stored) throw new Error(`Media bytes are unavailable: ${attachment.digest}`);
		return assetSnapshot(stored, attachment.filename);
	}

	async modelContent(attachmentId: string): Promise<ImageContent> {
		const asset = this.resolve(attachmentId);
		const bytes = await this.#fileSystem.readFile(asset.model.path);
		return Object.freeze({
			type: "image",
			mimeType: asset.model.mimeType,
			data: Buffer.from(bytes).toString("base64"),
		});
	}

	async previewPng(attachmentId: string): Promise<Uint8Array> {
		const asset = this.resolve(attachmentId);
		return this.#fileSystem.readFile(asset.preview.path);
	}

	describeImageContent(content: ImageContent): MediaAsset | undefined {
		const modelDigest = createHash("sha256").update(Buffer.from(content.data, "base64")).digest("hex");
		const stored = this.#storedByModelDigest.get(modelDigest);
		if (!stored) return undefined;
		const attachment = [...this.#attachments.values()].find((candidate) => candidate.digest === stored.digest);
		return assetSnapshot(stored, attachment?.filename ?? `image.${EXTENSION_BY_MIME[stored.mimeType]}`);
	}

	async detach(attachmentId: string): Promise<void> {
		const attachment = this.#attachments.get(attachmentId);
		if (!attachment) return;
		this.#attachments.delete(attachmentId);
		this.#totalBytes -= attachment.bytes;
		const stored = this.#stored.get(attachment.digest);
		if (!stored) return;
		stored.references = Math.max(0, stored.references - 1);
		if (stored.references > 0 || stored.committed) return;
		this.#stored.delete(stored.digest);
		this.#storedByModelDigest.delete(stored.modelDigest);
		await Promise.all(
			[stored.originalPath, stored.preview.path, stored.model.path]
				.filter((path) => !stored.protectedPaths.has(path))
				.map((path) => this.#removeIfPresent(path)),
		);
	}

	async commit(attachmentIds: readonly string[]): Promise<readonly MediaAsset[]> {
		await this.#prepareDirectory(this.#mediaDirectory);
		const promoted = new Set<string>();
		for (const attachmentId of attachmentIds) {
			const attachment = this.#attachments.get(attachmentId);
			if (!attachment) throw new Error(`Unknown Media Attachment: ${attachmentId}`);
			const stored = this.#stored.get(attachment.digest);
			if (!stored) throw new Error(`Media bytes are unavailable: ${attachment.digest}`);
			if (stored.committed || promoted.has(stored.digest)) continue;
			await this.#promote(stored);
			promoted.add(stored.digest);
		}
		return Object.freeze(attachmentIds.map((id) => this.resolve(id)));
	}

	async dispose(): Promise<void> {
		for (const attachmentId of [...this.#attachments.keys()]) await this.detach(attachmentId);
		try {
			await this.#fileSystem.removeDirectory(this.#stagingDirectory);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "ENOTEMPTY")) throw error;
		}
	}

	async #prepareStoredMedia(
		bytes: Uint8Array,
		digest: string,
		mimeType: MediaAsset["mimeType"],
	): Promise<StoredMedia> {
		let metadata: sharp.Metadata;
		try {
			metadata = await sharp(bytes, {
				animated: false,
				failOn: "error",
				limitInputPixels: this.#limits.maxPixels,
			}).metadata();
		} catch (error) {
			throw new Error(`Image metadata is invalid or exceeds ${this.#limits.maxPixels} decoded pixels`, {
				cause: error,
			});
		}
		const width = metadata.autoOrient.width;
		const height = metadata.autoOrient.height;
		if (!width || !height) throw new Error("Image dimensions are unavailable");
		if (Math.min(width, height) < this.#limits.minShortEdge) {
			throw new Error(`Image short edge must be at least ${this.#limits.minShortEdge} pixels`);
		}
		if (width * height > this.#limits.maxPixels) {
			throw new Error(`Image exceeds the ${this.#limits.maxPixels} decoded-pixel limit`);
		}

		const previewBytes = await sharp(bytes, {
			animated: false,
			failOn: "error",
			limitInputPixels: this.#limits.maxPixels,
		})
			.rotate()
			.resize({ width: 1_600, height: 1_200, fit: "inside", withoutEnlargement: true })
			.png({ compressionLevel: 9 })
			.toBuffer();
		const model = await this.#createModelRendition(bytes, metadata.hasAlpha === true);
		const modelDigest = createHash("sha256").update(model.bytes).digest("hex");
		const previewMetadata = await sharp(previewBytes).metadata();
		const modelMetadata = await sharp(model.bytes).metadata();
		await this.#prepareDirectory(this.#stagingDirectory);
		const originalExtension = EXTENSION_BY_MIME[mimeType];
		const originalPath = join(this.#stagingDirectory, `${digest}.original.${originalExtension}`);
		const previewPath = join(this.#stagingDirectory, `${digest}.preview.png`);
		const modelExtension = model.mimeType === "image/png" ? "png" : "jpg";
		const modelPath = join(this.#stagingDirectory, `${digest}.model.${modelExtension}`);
		await this.#atomicWrite(originalPath, bytes);
		await this.#atomicWrite(previewPath, previewBytes);
		await this.#atomicWrite(modelPath, model.bytes);
		return {
			digest,
			modelDigest,
			mimeType,
			width,
			height,
			bytes: bytes.byteLength,
			originalExtension,
			originalPath,
			preview: {
				path: previewPath,
				mimeType: "image/png",
				width: previewMetadata.width ?? width,
				height: previewMetadata.height ?? height,
				bytes: previewBytes.byteLength,
			},
			model: {
				path: modelPath,
				mimeType: model.mimeType,
				width: modelMetadata.width ?? width,
				height: modelMetadata.height ?? height,
				bytes: model.bytes.byteLength,
			},
			committed: false,
			references: 0,
			protectedPaths: new Set(),
		};
	}

	async #createModelRendition(
		bytes: Uint8Array,
		hasAlpha: boolean,
	): Promise<{ readonly bytes: Buffer; readonly mimeType: "image/png" | "image/jpeg" }> {
		let maximum = this.#limits.modelMaxLongEdge;
		let quality = 88;
		for (let attempt = 0; attempt < 8; attempt++) {
			const pipeline = sharp(bytes, {
				animated: false,
				failOn: "error",
				limitInputPixels: this.#limits.maxPixels,
			})
				.rotate()
				.resize({ width: maximum, height: maximum, fit: "inside", withoutEnlargement: true });
			const rendered = hasAlpha
				? await pipeline.png({ compressionLevel: 9, palette: true, quality }).toBuffer()
				: await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
			if (rendered.byteLength <= this.#limits.modelMaxBytes) {
				return { bytes: rendered, mimeType: hasAlpha ? "image/png" : "image/jpeg" };
			}
			maximum = Math.max(256, Math.floor(maximum * 0.8));
			quality = Math.max(32, quality - 8);
		}
		throw new Error(`Image could not be normalized below ${formatMiB(this.#limits.modelMaxBytes)} MiB`);
	}

	async #promote(stored: StoredMedia): Promise<void> {
		const originalPath = join(this.#mediaDirectory, `${stored.digest}.original.${stored.originalExtension}`);
		const previewPath = join(this.#mediaDirectory, `${stored.digest}.preview.png`);
		const modelExtension = stored.model.mimeType === "image/png" ? "png" : "jpg";
		const modelPath = join(this.#mediaDirectory, `${stored.digest}.model.${modelExtension}`);
		if (await this.#moveOrDiscard(stored.originalPath, originalPath)) stored.protectedPaths.add(originalPath);
		stored.originalPath = originalPath;
		if (await this.#moveOrDiscard(stored.preview.path, previewPath)) stored.protectedPaths.add(previewPath);
		stored.preview = { ...stored.preview, path: previewPath };
		if (await this.#moveOrDiscard(stored.model.path, modelPath)) stored.protectedPaths.add(modelPath);
		stored.model = { ...stored.model, path: modelPath };
		stored.committed = true;
	}

	async #moveOrDiscard(source: string, destination: string): Promise<boolean> {
		if (await this.#exists(destination)) {
			const [sourceBytes, destinationBytes] = await Promise.all([
				this.#fileSystem.readFile(source),
				this.#fileSystem.readFile(destination),
			]);
			if (!Buffer.from(sourceBytes).equals(Buffer.from(destinationBytes))) {
				throw new Error(`Content-addressed media destination is corrupt: ${destination}`);
			}
			await this.#removeIfPresent(source);
			return true;
		}
		await this.#fileSystem.rename(source, destination);
		await this.#fileSystem.setMode(destination, 0o600);
		return false;
	}

	async #prepareDirectory(path: string): Promise<void> {
		await this.#fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 });
		await this.#fileSystem.setMode(path, 0o700);
	}

	async #atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
		if (await this.#exists(path)) return;
		const temporaryPath = `${path}.${safeIdentity(this.#idGenerator.generate("queue_item"))}.tmp`;
		let handle: WritableFile | undefined;
		let committed = false;
		try {
			handle = await this.#fileSystem.open(temporaryPath, "wx", 0o600);
			await handle.write(bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#fileSystem.rename(temporaryPath, path);
			await this.#fileSystem.setMode(path, 0o600);
			committed = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!committed) await this.#removeIfPresent(temporaryPath);
		}
	}

	#allocateFilename(filename: string, mimeType: MediaAsset["mimeType"]): string {
		const fallback = `image.${EXTENSION_BY_MIME[mimeType]}`;
		const safe = safeFilename(filename) || fallback;
		const normalized = safe.toLocaleLowerCase();
		const use = (this.#filenameUses.get(normalized) ?? 0) + 1;
		this.#filenameUses.set(normalized, use);
		if (use === 1) return safe;
		const extension = extname(safe);
		const stem = extension ? safe.slice(0, -extension.length) : safe;
		return `${stem} (${use})${extension}`;
	}

	#assertCountAvailable(): void {
		if (this.#attachments.size >= this.#limits.maxAttachments) {
			throw new Error(`A prompt accepts at most ${this.#limits.maxAttachments} images`);
		}
	}

	async #exists(path: string): Promise<boolean> {
		try {
			await this.#fileSystem.stat(path);
			return true;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #removeIfPresent(path: string): Promise<void> {
		try {
			await this.#fileSystem.removeFile(path);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
	}
}

function sniffImageMime(bytes: Uint8Array): MediaAsset["mimeType"] | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
	if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function assetSnapshot(stored: StoredMedia, filename: string): MediaAsset {
	return Object.freeze({
		digest: stored.digest,
		modelDigest: stored.modelDigest,
		filename,
		mimeType: stored.mimeType,
		width: stored.width,
		height: stored.height,
		bytes: stored.bytes,
		committed: stored.committed,
		original: Object.freeze({ path: stored.originalPath, bytes: stored.bytes }),
		preview: Object.freeze({ ...stored.preview }),
		model: Object.freeze({ ...stored.model }),
	});
}

function safeFilename(value: string): string {
	return basename(sanitizeTerminalText(value))
		.replace(/[<>:"/\\|?*]/g, "_")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
		.trim();
}

function safeIdentity(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function formatMiB(bytes: number): string {
	return Number((bytes / (1024 * 1024)).toFixed(1)).toString();
}

function validateLimits(limits: MediaLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isFinite(value) || value < 1) throw new RangeError(`Media limit ${name} must be positive`);
	}
}
