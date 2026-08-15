#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkspacePackages, topologicalWorkspaceOrder } from "./workspace-graph.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = await discoverWorkspacePackages(repositoryRoot);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

for (const workspace of topologicalWorkspaceOrder(workspaces)) {
	if (typeof workspace.manifest.scripts?.build !== "string") continue;
	await new Promise((resolveBuild, rejectBuild) => {
		const child = spawn(npmCommand, ["run", "build", `--workspace=${workspace.manifest.name}`], {
			cwd: repositoryRoot,
			stdio: "inherit",
		});
		child.on("error", rejectBuild);
		child.on("exit", (code, signal) => {
			if (code === 0) resolveBuild();
			else rejectBuild(new Error(`Build failed for ${workspace.manifest.name} (${signal ?? code})`));
		});
	});
}
