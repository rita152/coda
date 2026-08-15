import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import sharp from "sharp";
import type { FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { SessionRecord } from "./records.ts";
import type { SessionMediaReference, SessionMediaRegistration } from "./types.ts";

const MAX_DECODED_PIXELS = 16_000_000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

interface ImageContentLike {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** Converts durable Session media references to and from model-facing inline ImageContent. */
export class SessionMediaCodec {
	readonly #fileSystem: FileSystem;
	readonly #mediaDirectory: string;
	readonly #idGenerator: IdGenerator;
	readonly #registrations = new Map<string, SessionMediaRegistration>();
	#directoryPrepared = false;

	constructor(options: {
		readonly fileSystem: FileSystem;
		readonly mediaDirectory: string;
		readonly idGenerator: IdGenerator;
	}) {
		this.#fileSystem = options.fileSystem;
		this.#mediaDirectory = options.mediaDirectory;
		this.#idGenerator = options.idGenerator;
	}

	register(registrations: readonly SessionMediaRegistration[]): void {
		for (const registration of registrations) {
			const reference = validateReference(structuredClone(registration.reference));
			const previous = this.#registrations.get(reference.rendition.digest);
			if (previous && previous.reference.digest !== reference.digest) {
				throw new Error("A Session media rendition cannot identify two different assets");
			}
			this.#registrations.set(reference.rendition.digest, {
				reference,
				modelPath: registration.modelPath,
			});
		}
	}

	async encodeRecord(record: SessionRecord): Promise<SessionRecord> {
		return { ...record, payload: await this.#encodeValue(record.payload) } as unknown as SessionRecord;
	}

	async hydrateRecord(record: SessionRecord): Promise<SessionRecord> {
		return { ...record, payload: await this.#hydrateValue(record.payload) } as unknown as SessionRecord;
	}

	collectReferences(records: readonly SessionRecord[]): ReadonlyMap<string, readonly SessionMediaReference[]> {
		const references = new Map<string, readonly SessionMediaReference[]>();
		for (const record of records) {
			let ownerId: string | undefined;
			let content: unknown;
			if (record.type === "message_committed") {
				ownerId = record.payload.message.id;
				content = record.payload.message.message.content;
			} else if (record.type === "follow_up_enqueued") {
				ownerId = String(record.payload.item.id);
				content = record.payload.item.content;
			}
			if (!ownerId) continue;
			const media = collectMediaFromValue(content);
			if (media.length > 0) references.set(ownerId, structuredClone(media));
		}
		return references;
	}

	async #encodeValue(value: unknown): Promise<unknown> {
		if (Array.isArray(value)) return Promise.all(value.map((entry) => this.#encodeValue(entry)));
		if (!isRecord(value)) return value;
		if (isImageContent(value)) return this.#encodeImage(value);
		return Object.fromEntries(
			await Promise.all(
				Object.entries(value).map(async ([key, entry]) => [key, await this.#encodeValue(entry)] as const),
			),
		);
	}

	async #hydrateValue(value: unknown): Promise<unknown> {
		if (Array.isArray(value)) return Promise.all(value.map((entry) => this.#hydrateValue(entry)));
		if (!isRecord(value)) return value;
		if (value.type === "media") return this.#hydrateReference(validateReference(value));
		return Object.fromEntries(
			await Promise.all(
				Object.entries(value).map(async ([key, entry]) => [key, await this.#hydrateValue(entry)] as const),
			),
		);
	}

	async #encodeImage(content: ImageContentLike): Promise<SessionMediaReference> {
		const bytes = decodeBase64(content.data);
		const modelDigest = digest(bytes);
		const registered = this.#registrations.get(modelDigest);
		if (registered) {
			const reference = registered.reference;
			const destination = this.#pathFor(reference);
			if (registered.modelPath !== destination) {
				const registeredBytes = await this.#fileSystem.readFile(registered.modelPath);
				if (digest(registeredBytes) !== modelDigest) throw new Error("Registered Session media bytes changed");
				await this.#writeBlob(destination, registeredBytes, modelDigest);
			} else {
				await this.#verifyBlob(destination, modelDigest);
			}
			return structuredClone(reference);
		}

		const metadata = await imageMetadata(bytes);
		const extension = sessionMediaExtension(content.mimeType);
		const reference: SessionMediaReference = {
			type: "media",
			digest: modelDigest,
			filename: `image-${modelDigest.slice(0, 12)}.${extension}`,
			mimeType: content.mimeType,
			width: metadata.width,
			height: metadata.height,
			bytes: bytes.byteLength,
			rendition: {
				digest: modelDigest,
				mimeType: content.mimeType,
				width: metadata.width,
				height: metadata.height,
				bytes: bytes.byteLength,
			},
		};
		await this.#writeBlob(this.#pathFor(reference), bytes, modelDigest);
		return reference;
	}

	async #hydrateReference(reference: SessionMediaReference): Promise<ImageContentLike> {
		const bytes = await this.#fileSystem.readFile(this.#pathFor(reference));
		if (bytes.byteLength !== reference.rendition.bytes || digest(bytes) !== reference.rendition.digest) {
			throw new Error(`Session media failed integrity verification: ${reference.filename}`);
		}
		return {
			type: "image",
			data: Buffer.from(bytes).toString("base64"),
			mimeType: reference.rendition.mimeType,
		};
	}

	#pathFor(reference: SessionMediaReference): string {
		return join(
			this.#mediaDirectory,
			`${reference.digest}.model.${sessionMediaExtension(reference.rendition.mimeType)}`,
		);
	}

	async #writeBlob(path: string, bytes: Uint8Array, expectedDigest: string): Promise<void> {
		await this.#prepareDirectory();
		if (await this.#exists(path)) {
			await this.#verifyBlob(path, expectedDigest);
			return;
		}
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const temporaryPath = `${path}.${token}.tmp`;
		let handle: WritableFile | undefined;
		let complete = false;
		try {
			handle = await this.#fileSystem.open(temporaryPath, "wx", 0o600);
			await handle.write(bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#fileSystem.rename(temporaryPath, path);
			await this.#fileSystem.setMode(path, 0o600);
			complete = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!complete) await this.#removeIfPresent(temporaryPath);
		}
	}

	async #verifyBlob(path: string, expectedDigest: string): Promise<void> {
		const bytes = await this.#fileSystem.readFile(path);
		if (digest(bytes) !== expectedDigest) throw new Error(`Session media digest collision or corruption: ${path}`);
	}

	async #prepareDirectory(): Promise<void> {
		if (this.#directoryPrepared) return;
		await this.#fileSystem.makeDirectory(this.#mediaDirectory, { recursive: true, mode: 0o700 });
		await this.#fileSystem.setMode(this.#mediaDirectory, 0o700);
		this.#directoryPrepared = true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageContent(value: Record<string, unknown>): value is Record<string, unknown> & ImageContentLike {
	return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

function collectMediaFromValue(value: unknown): SessionMediaReference[] {
	if (Array.isArray(value)) return value.flatMap(collectMediaFromValue);
	if (!isRecord(value)) return [];
	if (value.type === "media") return [value as unknown as SessionMediaReference];
	return Object.values(value).flatMap(collectMediaFromValue);
}

function validateReference(value: unknown): SessionMediaReference {
	if (!isRecord(value) || value.type !== "media" || !isRecord(value.rendition)) {
		throw new Error("Session media reference is invalid");
	}
	const reference = value as unknown as SessionMediaReference;
	for (const candidate of [reference.digest, reference.rendition.digest]) {
		if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error("Session media digest is invalid");
	}
	if (
		!reference.filename ||
		basename(reference.filename) !== reference.filename ||
		[...reference.filename].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127;
		})
	) {
		throw new Error("Session media filename is unsafe");
	}
	for (const candidate of [
		reference.width,
		reference.height,
		reference.bytes,
		reference.rendition.width,
		reference.rendition.height,
		reference.rendition.bytes,
	]) {
		if (!Number.isSafeInteger(candidate) || candidate < 1) throw new Error("Session media dimensions are invalid");
	}
	if (!reference.mimeType || !reference.rendition.mimeType) throw new Error("Session media MIME type is invalid");
	return structuredClone(reference);
}

async function imageMetadata(bytes: Uint8Array): Promise<{ readonly width: number; readonly height: number }> {
	let metadata: sharp.Metadata;
	try {
		metadata = await sharp(bytes, {
			animated: false,
			failOn: "error",
			limitInputPixels: MAX_DECODED_PIXELS,
		}).metadata();
	} catch (error) {
		throw new Error("Session image data is invalid or exceeds the decoded-pixel limit", { cause: error });
	}
	const width = metadata.autoOrient.width;
	const height = metadata.autoOrient.height;
	if (!width || !height || width * height > MAX_DECODED_PIXELS) {
		throw new Error("Session image dimensions are invalid");
	}
	return { width, height };
}

function decodeBase64(value: string): Uint8Array {
	if (value.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) {
		throw new Error("Session image data exceeds the media byte limit");
	}
	if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error("Session image data is not canonical base64");
	}
	const bytes = Buffer.from(value, "base64");
	if (
		bytes.byteLength === 0 ||
		bytes.byteLength > MAX_MEDIA_BYTES ||
		Buffer.from(bytes).toString("base64") !== value
	) {
		throw new Error("Session image data is not canonical base64");
	}
	return bytes;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sessionMediaExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			throw new Error(`Unsupported Session media MIME type: ${mimeType}`);
	}
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!safe) throw new Error("IdGenerator returned an invalid media identity");
	return safe;
}
