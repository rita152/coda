import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

async function readManifest(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function workspacePatterns(manifest) {
	const configured = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
	if (!Array.isArray(configured) || configured.some((pattern) => typeof pattern !== "string")) {
		throw new Error("Root package.json must declare a workspace pattern array");
	}
	return configured;
}

/** Discovers actual workspace manifests from the root declaration. */
export async function discoverWorkspacePackages(repositoryRoot) {
	const rootManifest = await readManifest(join(repositoryRoot, "package.json"));
	if (!rootManifest) throw new Error(`Root package.json not found: ${repositoryRoot}`);
	const discovered = [];
	for (const pattern of workspacePatterns(rootManifest)) {
		const match = /^(.*)\/\*$/u.exec(pattern);
		if (!match || match[1]?.includes("*")) {
			throw new Error(`Unsupported workspace pattern (expected a one-level /* suffix): ${pattern}`);
		}
		const parent = resolve(repositoryRoot, match[1]);
		let entries;
		try {
			entries = await readdir(parent, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const root = join(parent, entry.name);
			const manifestPath = join(root, "package.json");
			const manifest = await readManifest(manifestPath);
			if (!manifest) continue;
			if (typeof manifest.name !== "string" || manifest.name.length === 0) {
				throw new Error(`Workspace manifest has no package name: ${manifestPath}`);
			}
			discovered.push({ directoryName: entry.name, root, manifestPath, manifest });
		}
	}
	discovered.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
	const duplicate = discovered.find(
		(workspace, index) => discovered.findIndex((candidate) => candidate.manifest.name === workspace.manifest.name) !== index,
	);
	if (duplicate) throw new Error(`Duplicate workspace package name: ${duplicate.manifest.name}`);
	return discovered;
}

export function workspacePolicyDifferences(workspaces, policy) {
	const actual = new Set(workspaces.map(({ directoryName }) => directoryName));
	const declared = new Set(Object.keys(policy));
	return {
		missingPolicy: [...actual].filter((name) => !declared.has(name)).sort(),
		stalePolicy: [...declared].filter((name) => !actual.has(name)).sort(),
	};
}

/** Stable dependency-first order derived from workspace manifests. */
export function topologicalWorkspaceOrder(workspaces) {
	const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
	const dependencies = new Map(
		workspaces.map((workspace) => {
			const declared = {
				...(workspace.manifest.dependencies ?? {}),
				...(workspace.manifest.optionalDependencies ?? {}),
				...(workspace.manifest.peerDependencies ?? {}),
			};
			return [
				workspace.manifest.name,
				new Set(Object.keys(declared).filter((name) => byName.has(name))),
			];
		}),
	);
	const ordered = [];
	const remaining = new Set(byName.keys());
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((name) => [...(dependencies.get(name) ?? [])].every((dependency) => !remaining.has(dependency)))
			.sort();
		if (ready.length === 0) {
			throw new Error(`Workspace dependency cycle: ${[...remaining].sort().join(", ")}`);
		}
		for (const name of ready) {
			remaining.delete(name);
			ordered.push(byName.get(name));
		}
	}
	return ordered;
}
