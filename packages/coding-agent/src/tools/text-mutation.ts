import { createHash } from "node:crypto";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

export interface DecodedTextFile {
	readonly text: string;
	readonly bom: boolean;
	readonly newline: "\n" | "\r" | "\r\n";
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function decodeTextFile(bytes: Uint8Array): DecodedTextFile {
	const bom = hasBom(bytes);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.slice(UTF8_BOM.length) : bytes);
	return { text, bom, newline: newlineStyle(text) };
}

export function encodeTextFile(text: string, bom: boolean): Uint8Array {
	const encoded = new TextEncoder().encode(text);
	if (!bom) return encoded;
	const bytes = new Uint8Array(UTF8_BOM.length + encoded.length);
	bytes.set(UTF8_BOM);
	bytes.set(encoded, UTF8_BOM.length);
	return bytes;
}

export function normalizeNewlines(text: string, newline: "\n" | "\r" | "\r\n"): string {
	return text.replace(/\r\n|\r|\n/gu, newline);
}

function hasBom(bytes: Uint8Array): boolean {
	return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function newlineStyle(text: string): "\n" | "\r" | "\r\n" {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}
