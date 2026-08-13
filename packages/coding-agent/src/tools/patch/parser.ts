import { isAbsolute, normalize, sep, win32 } from "node:path";
import { PROTECTED_METADATA_NAMES } from "@coda/sandbox";

export const MAX_PATCH_CHARACTERS = 2 * 1024 * 1024;
export const MAX_PATCH_FILES = 50;
export const MAX_PATCH_HUNKS = 200;

export interface PatchChunk {
	readonly context?: string;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
	readonly endOfFile: boolean;
}

export type PatchFileOperation =
	| { readonly operation: "add"; readonly path: string; readonly content: string }
	| { readonly operation: "update"; readonly path: string; readonly chunks: readonly PatchChunk[] }
	| { readonly operation: "delete"; readonly path: string };

export interface ParsedPatch {
	readonly files: readonly PatchFileOperation[];
	readonly source: string;
}

export class PatchParseError extends Error {
	readonly code = "invalid_patch";
	readonly line?: number;

	constructor(message: string, line?: number) {
		super(line === undefined ? message : `Patch line ${line}: ${message}`);
		this.name = "PatchParseError";
		this.line = line;
	}
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_MARKER = "*** Add File: ";
const UPDATE_MARKER = "*** Update File: ";
const DELETE_MARKER = "*** Delete File: ";
const END_OF_FILE_MARKER = "*** End of File";

/**
 * Parses Coda's deliberately small, strict patch protocol. The marker vocabulary is interoperable
 * with the public Codex-style format, but this parser and its exact-match semantics are Coda-owned.
 * Moves and fuzzy whitespace matching are intentionally excluded so every precondition is explicit.
 */
export function parsePatch(source: string): ParsedPatch {
	if (Array.from(source).length > MAX_PATCH_CHARACTERS) {
		throw new PatchParseError(`Patch exceeds the ${MAX_PATCH_CHARACTERS}-character limit`);
	}
	const normalized = source.replace(/\r\n|\r/gu, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines[0] !== BEGIN_MARKER) throw new PatchParseError(`First line must be "${BEGIN_MARKER}"`, 1);
	if (lines.at(-1) !== END_MARKER) {
		throw new PatchParseError(`Last line must be "${END_MARKER}"`, Math.max(1, lines.length));
	}

	const files: PatchFileOperation[] = [];
	const paths = new Set<string>();
	let index = 1;
	let hunkCount = 0;
	while (index < lines.length - 1) {
		const line = lines[index]!;
		const lineNumber = index + 1;
		if (line.startsWith(ADD_MARKER)) {
			const path = validatePatchPath(line.slice(ADD_MARKER.length), lineNumber);
			assertUniquePath(path, paths, lineNumber);
			index++;
			const content: string[] = [];
			while (index < lines.length - 1 && !isFileMarker(lines[index]!)) {
				const addition = lines[index]!;
				if (!addition.startsWith("+")) {
					throw new PatchParseError("Added file lines must start with '+'", index + 1);
				}
				content.push(addition.slice(1));
				index++;
			}
			if (content.length === 0)
				throw new PatchParseError("Added file must contain at least one '+' line", lineNumber);
			files.push(Object.freeze({ operation: "add", path, content: `${content.join("\n")}\n` }));
			continue;
		}
		if (line.startsWith(DELETE_MARKER)) {
			const path = validatePatchPath(line.slice(DELETE_MARKER.length), lineNumber);
			assertUniquePath(path, paths, lineNumber);
			files.push(Object.freeze({ operation: "delete", path }));
			index++;
			continue;
		}
		if (line.startsWith(UPDATE_MARKER)) {
			const path = validatePatchPath(line.slice(UPDATE_MARKER.length), lineNumber);
			assertUniquePath(path, paths, lineNumber);
			index++;
			const chunks: PatchChunk[] = [];
			while (index < lines.length - 1 && !isFileMarker(lines[index]!)) {
				let context: string | undefined;
				if (lines[index] === "@@" || lines[index]!.startsWith("@@ ")) {
					context = lines[index] === "@@" ? undefined : lines[index]!.slice(3);
					index++;
				} else if (chunks.length > 0) {
					throw new PatchParseError("Each additional update hunk must start with '@@'", index + 1);
				}
				const oldLines: string[] = [];
				const newLines: string[] = [];
				let changed = false;
				let endOfFile = false;
				while (index < lines.length - 1 && !isFileMarker(lines[index]!) && !isChunkMarker(lines[index]!)) {
					const change = lines[index]!;
					if (change === END_OF_FILE_MARKER) {
						endOfFile = true;
						index++;
						if (index < lines.length - 1 && !isFileMarker(lines[index]!)) {
							throw new PatchParseError("End-of-file marker must finish its update", index + 1);
						}
						break;
					}
					const prefix = change[0];
					const value = change.slice(1);
					if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
						changed = true;
					} else if (prefix === "+") {
						newLines.push(value);
						changed = true;
					} else {
						throw new PatchParseError("Update lines must start with ' ', '+', or '-'", index + 1);
					}
					index++;
				}
				if (!changed) throw new PatchParseError("Update hunk must add or remove at least one line", lineNumber);
				if (oldLines.length === 0 && context === undefined && !endOfFile) {
					throw new PatchParseError("Insertion hunk requires '@@ context' or '*** End of File'", lineNumber);
				}
				chunks.push(
					Object.freeze({
						...(context === undefined ? {} : { context }),
						oldLines: Object.freeze(oldLines),
						newLines: Object.freeze(newLines),
						endOfFile,
					}),
				);
				hunkCount++;
				if (hunkCount > MAX_PATCH_HUNKS) {
					throw new PatchParseError(`Patch exceeds the ${MAX_PATCH_HUNKS}-hunk limit`);
				}
			}
			if (chunks.length === 0) throw new PatchParseError("Updated file must contain at least one hunk", lineNumber);
			files.push(Object.freeze({ operation: "update", path, chunks: Object.freeze(chunks) }));
			continue;
		}
		throw new PatchParseError("Expected an Add, Update, or Delete File marker", lineNumber);
	}

	if (files.length === 0) throw new PatchParseError("Patch must contain at least one file operation");
	if (files.length > MAX_PATCH_FILES) {
		throw new PatchParseError(`Patch exceeds the ${MAX_PATCH_FILES}-file limit`);
	}
	return Object.freeze({ files: Object.freeze(files), source: normalized });
}

function validatePatchPath(value: string, line: number): string {
	if (value.length === 0 || value.trim() !== value)
		throw new PatchParseError("File path must be non-empty and trimmed", line);
	if (value.includes("\0")) throw new PatchParseError("File path must not contain NUL bytes", line);
	if (value === "~" || value.startsWith(`~${sep}`) || value.startsWith("file://")) {
		throw new PatchParseError("File path must be Workspace-relative", line);
	}
	if (isAbsolute(value) || win32.isAbsolute(value))
		throw new PatchParseError("Absolute file paths are not allowed", line);
	const components = value.split(/[\\/]/gu);
	if (components.some((component) => component === "" || component === "." || component === "..")) {
		throw new PatchParseError("File path traversal and empty path components are not allowed", line);
	}
	if (
		components.some((component) =>
			PROTECTED_METADATA_NAMES.some((name) => name.toLowerCase() === component.toLowerCase()),
		)
	) {
		throw new PatchParseError("Protected Workspace metadata cannot be patched", line);
	}
	if (normalize(value) !== value) throw new PatchParseError("File path must be lexically normalized", line);
	return value;
}

function assertUniquePath(path: string, paths: Set<string>, line: number): void {
	if (paths.has(path)) throw new PatchParseError(`Conflicting duplicate file operation for ${path}`, line);
	paths.add(path);
}

function isFileMarker(line: string): boolean {
	return line.startsWith(ADD_MARKER) || line.startsWith(UPDATE_MARKER) || line.startsWith(DELETE_MARKER);
}

function isChunkMarker(line: string): boolean {
	return line === "@@" || line.startsWith("@@ ");
}
