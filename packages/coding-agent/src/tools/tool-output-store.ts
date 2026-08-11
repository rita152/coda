import { join } from "node:path";
import type { FileSystem, WritableFile } from "../host/file-system.ts";
import type { ProcessOutputChunk } from "../host/process-runner.ts";

const MAX_STORED_BYTES = 16 * 1024 * 1024;
const REFERENCE_PREFIX = "tool-output:v1:";

export interface StoredToolOutput {
	readonly outputRef: string;
	readonly overflowPath: string;
	readonly storedBytes: number;
	readonly storedTruncated: boolean;
}

function encodedInvocationId(invocationId: string): string {
	return Buffer.from(invocationId, "utf8").toString("base64url");
}

function reference(encoded: string): string {
	return `${REFERENCE_PREFIX}${encoded}`;
}

function outputPath(homeDirectory: string, encoded: string): string {
	return join(homeDirectory, ".coda", "tmp", `tool-output-${encoded}.log`);
}

function retainedUtf8(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return { text: value, truncated: false };
	let text = bytes.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
	return { text, truncated: true };
}

export class ToolOutputCapture {
	readonly #fileSystem: FileSystem;
	readonly #file: WritableFile;
	readonly #path: string;
	readonly #ref: string;
	#lastChannel: ProcessOutputChunk["channel"] | undefined;
	#storedBytes = 0;
	#storedTruncated = false;
	#failure: unknown;
	#queue = Promise.resolve();

	constructor(fileSystem: FileSystem, file: WritableFile, path: string, outputRef: string) {
		this.#fileSystem = fileSystem;
		this.#file = file;
		this.#path = path;
		this.#ref = outputRef;
	}

	append(chunk: ProcessOutputChunk): void {
		if (this.#storedTruncated) return;
		const header = this.#lastChannel === chunk.channel ? "" : `${this.#lastChannel ? "\n" : ""}[${chunk.channel}]\n`;
		this.#lastChannel = chunk.channel;
		const remaining = MAX_STORED_BYTES - this.#storedBytes;
		const retained = retainedUtf8(`${header}${chunk.text}`, remaining);
		const bytes = Buffer.byteLength(retained.text);
		this.#storedBytes += bytes;
		this.#storedTruncated ||= retained.truncated;
		if (retained.text.length === 0) return;
		this.#queue = this.#queue
			.then(async () => {
				if (this.#failure === undefined) await this.#file.write(retained.text);
			})
			.catch((error) => {
				this.#failure ??= error;
			});
	}

	async finish(): Promise<StoredToolOutput | undefined> {
		await this.#queue;
		try {
			await this.#file.close();
		} catch (error) {
			this.#failure ??= error;
		}
		if (this.#failure !== undefined) {
			await this.#fileSystem.removeFile(this.#path).catch(() => undefined);
			return undefined;
		}
		return {
			outputRef: this.#ref,
			overflowPath: this.#path,
			storedBytes: this.#storedBytes,
			storedTruncated: this.#storedTruncated,
		};
	}
}

export async function createToolOutputCapture(
	fileSystem: FileSystem,
	homeDirectory: string,
	invocationId: string,
): Promise<ToolOutputCapture | undefined> {
	const encoded = encodedInvocationId(invocationId);
	const directory = join(homeDirectory, ".coda", "tmp");
	const path = outputPath(homeDirectory, encoded);
	try {
		await fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
		await fileSystem.setMode(directory, 0o700);
		const file = await fileSystem.open(path, "wx", 0o600);
		return new ToolOutputCapture(fileSystem, file, path, reference(encoded));
	} catch {
		return undefined;
	}
}

export function toolOutputPathForRef(homeDirectory: string, outputRef: string): string | undefined {
	if (!outputRef.startsWith(REFERENCE_PREFIX)) return undefined;
	const encoded = outputRef.slice(REFERENCE_PREFIX.length);
	if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) return undefined;
	return outputPath(homeDirectory, encoded);
}

export async function discardStoredToolOutput(fileSystem: FileSystem, output: StoredToolOutput): Promise<void> {
	await fileSystem.removeFile(output.overflowPath).catch(() => undefined);
}
