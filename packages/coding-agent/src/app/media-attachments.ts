import { createHash } from "node:crypto";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInput } from "@coda/agent";
import type { ImageContent } from "@coda/ai";
import { type FileSystem, isFileSystemError } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { MediaAsset, MediaLibrary } from "../media/media-library.ts";
import type { WorkspaceInputResources } from "../runtime/workspace-input-resources.ts";
import { sessionMediaExtension } from "../session/media-codec.ts";
import type { Session, SessionMediaReference, SessionMediaRegistration } from "../session/types.ts";
import type { ChatAttachment } from "../ui/chat-component.ts";
import type { AttachmentTransaction } from "../ui/input-controller.ts";

export async function promptInput(
	text: string,
	attachmentIds: readonly string[],
	mediaLibrary: MediaLibrary,
	restoredContents: ReadonlyMap<string, ImageContent> = new Map(),
): Promise<AgentInput> {
	if (attachmentIds.length === 0) return text;
	const content: Exclude<AgentInput, string> = [];
	if (text.length > 0) content.push(Object.freeze({ type: "text", text }));
	for (const attachmentId of attachmentIds) {
		content.push(restoredContents.get(attachmentId) ?? (await mediaLibrary.modelContent(attachmentId)));
	}
	return content;
}

export async function chatAttachment(mediaLibrary: MediaLibrary, attachmentId: string): Promise<ChatAttachment> {
	const asset = mediaLibrary.resolve(attachmentId);
	return Object.freeze({
		id: attachmentId,
		filename: asset.filename,
		mimeType: asset.mimeType,
		width: asset.width,
		height: asset.height,
		bytes: asset.bytes,
		preview: Object.freeze({
			png: await mediaLibrary.previewPng(attachmentId),
			generation: asset.digest,
			width: asset.preview.width,
			height: asset.preview.height,
		}),
	});
}

const IMAGE_PATH_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

/**
 * Recognizes the path-shaped paste emitted by terminals when files are dropped.
 * Ordinary prose and relative paths stay in the Composer as text.
 */
export function pastedImagePaths(text: string): readonly string[] | undefined {
	const value = text.trim();
	if (!value || value.includes("\0")) return undefined;
	const words = shellWords(value);
	if (words) {
		const paths = words.map(normalizePastedPath);
		if (paths.every((path): path is string => path !== undefined && isSupportedImagePath(path))) {
			return Object.freeze(paths);
		}
		if (words.slice(1).some((word) => isAbsolutePastedPath(word))) return undefined;
	}
	const literal = normalizePastedPath(value);
	return literal && isSupportedImagePath(literal) ? Object.freeze([literal]) : undefined;
}

export function ingestPastedImages(
	text: string,
	mediaLibrary: MediaLibrary,
): Promise<readonly ChatAttachment[]> | undefined {
	const paths = pastedImagePaths(text);
	if (!paths) return undefined;
	return ingestImagePaths(paths, mediaLibrary);
}

async function ingestImagePaths(
	paths: readonly string[],
	mediaLibrary: MediaLibrary,
): Promise<readonly ChatAttachment[]> {
	const attachmentIds: string[] = [];
	try {
		for (const path of paths) attachmentIds.push((await mediaLibrary.ingestPath(path)).id);
		return Object.freeze(
			await Promise.all(attachmentIds.map((attachmentId) => chatAttachment(mediaLibrary, attachmentId))),
		);
	} catch (error) {
		await Promise.all(attachmentIds.map((attachmentId) => mediaLibrary.detach(attachmentId)));
		throw error;
	}
}

function isSupportedImagePath(path: string): boolean {
	return isAbsolute(path) && IMAGE_PATH_EXTENSIONS.has(extname(path).toLowerCase());
}

function isAbsolutePastedPath(value: string): boolean {
	const path = normalizePastedPath(value);
	return path !== undefined && isAbsolute(path);
}

function normalizePastedPath(value: string): string | undefined {
	if (value.startsWith("file://")) {
		try {
			return fileURLToPath(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

function shellWords(value: string): readonly string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let started = false;
	for (const character of value) {
		if (escaped) {
			word += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				words.push(word);
				word = "";
				started = false;
			}
			continue;
		}
		word += character;
		started = true;
	}
	if (escaped || quote) return undefined;
	if (started) words.push(word);
	return words.length > 0 ? Object.freeze(words) : undefined;
}

function sessionMediaRegistration(asset: MediaAsset): SessionMediaRegistration {
	return {
		reference: {
			type: "media",
			digest: asset.digest,
			filename: asset.filename,
			mimeType: asset.mimeType,
			width: asset.width,
			height: asset.height,
			bytes: asset.bytes,
			rendition: {
				digest: asset.modelDigest,
				mimeType: asset.model.mimeType,
				width: asset.model.width,
				height: asset.model.height,
				bytes: asset.model.bytes,
			},
		},
		modelPath: asset.model.path,
	};
}

export async function prepareAttachmentTransaction(
	attachmentIds: readonly string[],
	mediaLibrary: MediaLibrary,
	session: Session,
	inputResources: WorkspaceInputResources,
): Promise<AttachmentTransaction> {
	if (attachmentIds.length === 0) {
		return {
			resources: [],
			commit: async () => undefined,
			rollback: async () => undefined,
		};
	}
	return inputResources.register(
		attachmentIds,
		{
			commit: async () => {
				const committed = await mediaLibrary.commit(attachmentIds);
				if (session.descriptor.persistent) {
					session.registerMedia(committed.map(sessionMediaRegistration));
				}
			},
			rollback: async () => {
				for (const attachmentId of attachmentIds) await mediaLibrary.detach(attachmentId);
			},
		},
		async () => {
			for (const attachmentId of attachmentIds) await mediaLibrary.detach(attachmentId);
		},
	);
}

export interface RestoredChatMedia {
	readonly attachments: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly contents: ReadonlyMap<string, ImageContent>;
	readonly paths: ReadonlyMap<string, string>;
}

export async function restoredChatAttachments(
	references: ReadonlyMap<string, readonly SessionMediaReference[]>,
	sessionPath: string | undefined,
	fileSystem: FileSystem,
	editableOwners: ReadonlySet<string>,
): Promise<RestoredChatMedia> {
	const result = new Map<string, readonly ChatAttachment[]>();
	const contents = new Map<string, ImageContent>();
	const paths = new Map<string, string>();
	for (const [messageId, messageReferences] of references) {
		const attachments: ChatAttachment[] = [];
		for (const [index, reference] of messageReferences.entries()) {
			let preview: ChatAttachment["preview"];
			if (sessionPath) {
				const previewPath = join(`${sessionPath}.media`, `${reference.digest}.preview.png`);
				try {
					preview = {
						png: await fileSystem.readFile(previewPath),
						generation: reference.digest,
						width: reference.width,
						height: reference.height,
					};
				} catch (error) {
					if (!isFileSystemError(error, "ENOENT")) throw error;
				}
			}
			const id = `restored:${messageId}:${index}:${reference.digest}`;
			if (sessionPath && editableOwners.has(messageId)) {
				const modelPath = sessionModelPath(sessionPath, reference);
				const modelBytes = await fileSystem.readFile(modelPath);
				contents.set(id, {
					type: "image",
					data: Buffer.from(modelBytes).toString("base64"),
					mimeType: reference.rendition.mimeType,
				});
				paths.set(id, modelPath);
			}
			attachments.push({
				id,
				filename: reference.filename,
				mimeType: reference.mimeType,
				width: reference.width,
				height: reference.height,
				bytes: reference.bytes,
				preview,
			});
		}
		result.set(messageId, attachments);
	}
	return { attachments: result, contents, paths };
}

function sessionModelPath(sessionPath: string, reference: SessionMediaReference): string {
	const extension = sessionMediaExtension(reference.rendition.mimeType);
	return join(`${sessionPath}.media`, `${reference.digest}.model.${extension}`);
}

export interface MediaViewerRuntime {
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly homeDirectory: string;
}

export async function openAttachmentInSystemViewer(
	mediaLibrary: MediaLibrary,
	attachmentId: string,
	processRunner: ProcessRunner,
	runtime: MediaViewerRuntime,
	cwd: string,
): Promise<void> {
	const path = mediaLibrary.resolve(attachmentId).original.path;
	return openPathInSystemViewer(path, processRunner, runtime, cwd);
}

export async function openPathInSystemViewer(
	path: string,
	processRunner: ProcessRunner,
	runtime: MediaViewerRuntime,
	cwd: string,
): Promise<void> {
	const command =
		runtime.platform === "darwin"
			? { executable: "/usr/bin/open", args: [path] }
			: runtime.platform === "linux"
				? { executable: "/usr/bin/xdg-open", args: [path] }
				: undefined;
	if (!command) throw new Error(`System image viewer is unsupported on ${runtime.platform}`);
	const environment = Object.fromEntries(
		Object.entries(runtime.environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const result = await processRunner.run({
		...command,
		cwd,
		environment,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
		maxOutputBytes: 64 * 1024,
		maxOutputLines: 100,
		overflowPath: join(runtime.homeDirectory, ".coda", "tmp", `media-open-${pathSafeIdentity(path)}.log`),
	});
	if (result.exitCode !== 0 || result.signal || result.timedOut) {
		throw new Error(result.stderr.trim() || "System image viewer could not be opened");
	}
}

export function projectJsonMedia(value: unknown, mediaLibrary: MediaLibrary, includeData: boolean): unknown {
	if (Array.isArray(value)) return value.map((entry) => projectJsonMedia(entry, mediaLibrary, includeData));
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
		const bytes = Buffer.from(record.data, "base64");
		const modelDigest = createHash("sha256").update(bytes).digest("hex");
		const asset = mediaLibrary.describeImageContent({
			type: "image",
			data: record.data,
			mimeType: record.mimeType,
		});
		const fallbackExtension = record.mimeType === "image/jpeg" ? "jpg" : "png";
		return {
			type: "media",
			digest: asset?.digest ?? modelDigest,
			filename: asset?.filename ?? `image-${modelDigest.slice(0, 12)}.${fallbackExtension}`,
			mimeType: asset?.mimeType ?? record.mimeType,
			bytes: asset?.bytes ?? bytes.byteLength,
			...(asset ? { width: asset.width, height: asset.height } : {}),
			rendition: {
				digest: asset?.modelDigest ?? modelDigest,
				mimeType: record.mimeType,
				bytes: bytes.byteLength,
				...(asset ? { width: asset.model.width, height: asset.model.height } : {}),
			},
			...(includeData ? { data: record.data } : {}),
		};
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, entry]) => [key, projectJsonMedia(entry, mediaLibrary, includeData)]),
	);
}

export function hasAgentInput(input: AgentInput): boolean {
	return typeof input === "string" ? input.trim().length > 0 : input.length > 0;
}

export function pathSafeIdentity(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
