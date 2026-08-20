import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../../src/host/process-runner.ts";
import { createCodingPluginMarketplaceStore } from "../../src/plugins/marketplace-store.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugin-marketplace-budget-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeEntryOverflowMarketplace(root: string): Promise<void> {
	const marketplaceRoot = join(root, ".agents", "plugins");
	await mkdir(marketplaceRoot, { recursive: true });
	await writeFile(
		join(marketplaceRoot, "marketplace.json"),
		JSON.stringify({
			name: "bounded-market",
			plugins: [
				{ name: "must-not-probe", source: "./packages/must-not-probe" },
				...Array.from({ length: 1024 }, (_, index) => ({
					name: `remote-${index}`,
					source: { source: "url", url: `https://example.test/remote-${index}.git` },
				})),
			],
		}),
	);
}

function processResult(stdout = "", exitCode = 0, stderr = ""): ProcessRunResult {
	return { exitCode, signal: null, stdout, stderr, timedOut: false, truncated: false };
}

class TestIds implements IdGenerator {
	#next = 0;

	generate(): string {
		return `budget-${++this.#next}`;
	}
}

class FixtureGitRunner implements ProcessRunner {
	readonly #fixture: string;
	readonly #revision: string;

	constructor(fixture: string, revision: string) {
		this.#fixture = fixture;
		this.#revision = revision;
	}

	async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
		if (request.executable !== "git") return processResult("", 127, "unexpected executable");
		if (request.args[0] === "clone") {
			const destination = request.args.at(-1);
			if (!destination) return processResult("", 1, "missing destination");
			await cp(this.#fixture, destination, { recursive: true, verbatimSymlinks: true });
			return processResult();
		}
		if (request.args[2] === "rev-parse") return processResult(`${this.#revision}\n`);
		return processResult();
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin Marketplace store manifest budgets", () => {
	it.each(["local", "git"] as const)(
		"rejects an oversized-entry %s Marketplace without probing a Plugin package",
		async (source) => {
			const fixture = await temporaryDirectory();
			await writeEntryOverflowMarketplace(fixture);
			const base = createNodeFileSystem();
			let packageProbes = 0;
			const rejectPackageProbe = (path: string): never => {
				packageProbes++;
				throw new Error(`Plugin package was probed: ${path}`);
			};
			const forbidden = (path: string): boolean => path.includes(`${sep}packages${sep}`);
			const store = createCodingPluginMarketplaceStore({
				root: join(await temporaryDirectory(), "store"),
				fileSystem: {
					...base,
					realpath: async (path) => (forbidden(path) ? rejectPackageProbe(path) : base.realpath(path)),
					stat: async (path) => (forbidden(path) ? rejectPackageProbe(path) : base.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectPackageProbe(path) : base.lstat(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectPackageProbe(path) : base.readDirectory(path)),
					readFile: async (path) => (forbidden(path) ? rejectPackageProbe(path) : base.readFile(path)),
				},
				processRunner:
					source === "git"
						? new FixtureGitRunner(fixture, "a".repeat(40))
						: { run: async () => Promise.reject(new Error("local source must not run Git")) },
				idGenerator: new TestIds(),
				environment: {},
			});

			await expect(
				store.add(
					source === "git"
						? { source: "git", url: "https://example.test/bounded-market.git" }
						: { source: "local", root: fixture },
				),
			).rejects.toThrow(/1025 entries.*limit is 1024/u);

			expect(packageProbes).toBe(0);
			expect((await store.list()).marketplaces).toEqual([]);
		},
	);
});
