import { sanitizeTerminalText } from "@coda/tui";

/** Returns the safe basename-only label used by inline and timeline attachment elements. */
export function attachmentElementLabel(filename: string): string {
	const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
	const safe = sanitizeTerminalText(leaf).replace(/\s+/gu, " ").trim() || "image";
	return `[${safe}]`;
}
