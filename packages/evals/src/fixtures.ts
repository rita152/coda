import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureManifest, LoadedFixture, TrajectoryStep } from "./fixture-types.ts";

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files[relative(root, path).split(sep).join("/")] = await readFile(path, "utf8");
		}
	};
	await visit(root);
	return files;
}

function validateManifest(manifest: FixtureManifest, directoryName: string): void {
	if (manifest.schemaVersion !== 1) throw new Error(`Fixture ${directoryName} has an unsupported schema`);
	if (manifest.id !== directoryName)
		throw new Error(`Fixture directory ${directoryName} does not match ${manifest.id}`);
	if (manifest.acceptance.checks.length === 0) throw new Error(`Fixture ${manifest.id} has no acceptance checks`);
	if (manifest.limits.minScore < 0 || manifest.limits.minScore > 100) {
		throw new Error(`Fixture ${manifest.id} has an invalid minimum score`);
	}
}

async function loadFixture(directoryName: string): Promise<LoadedFixture> {
	const path = join(FIXTURES_ROOT, directoryName);
	const manifest = await readJson<FixtureManifest>(join(path, "fixture.json"));
	validateManifest(manifest, directoryName);
	const initialFiles = await readFiles(join(path, "repository"));
	let expectedOverlay: Record<string, string> = {};
	try {
		expectedOverlay = await readFiles(join(path, "expected"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const expectedFiles = { ...initialFiles, ...expectedOverlay };
	for (const deleted of manifest.expectedDeletePaths ?? []) delete expectedFiles[deleted];
	const trajectory = await readJson<readonly TrajectoryStep[]>(join(path, "trajectory.json"));
	if (trajectory.length === 0) throw new Error(`Fixture ${manifest.id} has no Faux Model trajectory`);
	return { directory: path, manifest, initialFiles, expectedFiles, trajectory };
}

export async function loadFixtures(requestedIds?: readonly string[]): Promise<readonly LoadedFixture[]> {
	const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
	const available = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const ids = requestedIds ? [...new Set(requestedIds)] : available;
	const unknown = ids.filter((id) => !available.includes(id));
	if (unknown.length > 0)
		throw new Error(`Unknown evaluation fixture${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	return Promise.all(ids.map(loadFixture));
}
