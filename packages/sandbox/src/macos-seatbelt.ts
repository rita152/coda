import { existsSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { CompiledSandboxPolicy } from "./policy.ts";

export const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export interface PreparedSandboxCommand {
	readonly backend: "macos-seatbelt";
	readonly executable: string;
	readonly args: readonly string[];
}

function exclusions(prefix: string, count: number): string[] {
	const qualifiers: string[] = [];
	for (let index = 0; index < count; index++) {
		qualifiers.push(`(require-not (literal (param "${prefix}_${index}")))`);
		qualifiers.push(`(require-not (subpath (param "${prefix}_${index}")))`);
	}
	return qualifiers;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function accessRule(rootIndex: number, protectedPathIndices: readonly number[], deniedReadRootCount: number): string {
	const qualifiers = [`(subpath (param "WRITABLE_ROOT_${rootIndex}"))`];
	for (const index of protectedPathIndices) {
		qualifiers.push(`(require-not (literal (param "PROTECTED_PATH_${index}")))`);
		qualifiers.push(`(require-not (subpath (param "PROTECTED_PATH_${index}")))`);
	}
	qualifiers.push(...exclusions("DENIED_ROOT", deniedReadRootCount));
	return `(require-all ${qualifiers.join(" ")})`;
}

function fullDiskRule(operation: "file-read*" | "file-write*", deniedReadRootCount: number): string {
	if (deniedReadRootCount === 0) return `(allow ${operation})`;
	return `(allow ${operation} (require-all ${exclusions("DENIED_ROOT", deniedReadRootCount).join(" ")}))`;
}

export function buildMacosSeatbeltPolicy(policy: Readonly<CompiledSandboxPolicy>): string {
	const sections = [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal (target same-sandbox))",
		fullDiskRule("file-read*", policy.deniedReadRoots.length),
		'(allow file-write-data (literal "/dev/null"))',
		"(allow sysctl-read)",
	];
	if (policy.writableRoots === "full-disk") {
		sections.push(fullDiskRule("file-write*", policy.deniedReadRoots.length));
	} else if (policy.writableRoots.length > 0) {
		sections.push(
			`(allow file-write*\n${policy.writableRoots
				.map((root, index) =>
					accessRule(
						index,
						policy.protectedMetadataPaths
							.map((path, pathIndex) => ({ path, pathIndex }))
							.filter(({ path }) => path !== root && isContained(root, path))
							.map(({ pathIndex }) => pathIndex),
						policy.deniedReadRoots.length,
					),
				)
				.join("\n")}\n)`,
		);
	}
	if (policy.networkAccess === "enabled") {
		sections.push("(allow network-outbound)", "(allow network-inbound)");
	}
	return sections.join("\n");
}

export function prepareMacosSeatbelt(
	command: readonly [string, ...string[]],
	policy: Readonly<CompiledSandboxPolicy>,
	options: { readonly managedProxyPorts?: readonly number[] } = {},
): PreparedSandboxCommand | undefined {
	if (!existsSync(MACOS_SANDBOX_EXECUTABLE)) return undefined;
	let policyText = buildMacosSeatbeltPolicy(policy);
	for (const port of options.managedProxyPorts ?? []) {
		policyText += `\n(allow network-outbound (remote ip "localhost:${port}"))`;
	}
	const args: string[] = ["-p", policyText];
	if (policy.writableRoots !== "full-disk") {
		for (let rootIndex = 0; rootIndex < policy.writableRoots.length; rootIndex++) {
			const root = policy.writableRoots[rootIndex];
			if (root === undefined) continue;
			args.push(`-DWRITABLE_ROOT_${rootIndex}=${root}`);
		}
		for (let index = 0; index < policy.protectedMetadataPaths.length; index++) {
			const path = policy.protectedMetadataPaths[index];
			if (path !== undefined) args.push(`-DPROTECTED_PATH_${index}=${path}`);
		}
	}
	for (let index = 0; index < policy.deniedReadRoots.length; index++) {
		const root = policy.deniedReadRoots[index];
		if (root !== undefined) args.push(`-DDENIED_ROOT_${index}=${root}`);
	}
	args.push("--", ...command);
	return Object.freeze({ backend: "macos-seatbelt", executable: MACOS_SANDBOX_EXECUTABLE, args });
}
