import { posix } from "node:path";

export class RepositoryPathError extends Error {}

export function normalizeRepositoryPath(input: string): string {
	const replaced = input.replaceAll("\\", "/");
	if (posix.isAbsolute(replaced)) throw new RepositoryPathError(`Path is outside the fixture repository: ${input}`);
	const normalized = posix.normalize(replaced).replace(/^\.\//u, "");
	if (normalized === ".." || normalized.startsWith("../")) {
		throw new RepositoryPathError(`Path is outside the fixture repository: ${input}`);
	}
	return normalized === "." ? "" : normalized;
}

export class FixtureRepository {
	readonly #files: Map<string, string>;

	constructor(files: Readonly<Record<string, string>>) {
		this.#files = new Map(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
	}

	read(path: string): string {
		const normalized = normalizeRepositoryPath(path);
		const value = this.#files.get(normalized);
		if (value === undefined) throw new Error(`File does not exist: ${normalized || "."}`);
		return value;
	}

	write(path: string, content: string): void {
		const normalized = normalizeRepositoryPath(path);
		if (normalized.length === 0) throw new RepositoryPathError("Cannot write the repository root");
		this.#files.set(normalized, content);
	}

	list(path = ""): readonly string[] {
		const normalized = normalizeRepositoryPath(path);
		const prefix = normalized.length === 0 ? "" : `${normalized}/`;
		return [...this.#files.keys()]
			.filter((candidate) => candidate === normalized || candidate.startsWith(prefix))
			.sort();
	}

	snapshot(): Readonly<Record<string, string>> {
		return Object.freeze(
			Object.fromEntries([...this.#files.entries()].sort(([left], [right]) => left.localeCompare(right))),
		);
	}
}
