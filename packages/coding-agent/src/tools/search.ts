import type { FileSystem } from "../host/file-system.ts";

export async function readSearchableText(fileSystem: FileSystem, path: string): Promise<string | undefined> {
	const status = await fileSystem.stat(path);
	if (status.size > 2 * 1024 * 1024) return undefined;
	const bytes = await fileSystem.readFile(path);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	return text.includes("\0") ? undefined : text;
}
