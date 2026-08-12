import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
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

function roots(prefix: string, count: number): string {
	const qualifiers: string[] = [];
	for (let index = 0; index < count; index++) {
		qualifiers.push(`(literal (param "${prefix}_${index}"))`);
		qualifiers.push(`(subpath (param "${prefix}_${index}"))`);
	}
	return `(require-any ${qualifiers.join(" ")})`;
}

function literalRoots(prefix: string, count: number): string {
	return `(require-any ${Array.from({ length: count }, (_, index) => `(literal (param "${prefix}_${index}"))`).join(" ")})`;
}

function readAncestorPaths(
	policy: Readonly<CompiledSandboxPolicy>,
	runtimeReadPaths: readonly string[],
): readonly string[] {
	const roots = [
		...policy.readableRoots,
		...policy.approvedReadRoots,
		...(policy.writableRoots === "full-disk" ? [] : policy.writableRoots),
		...runtimeReadPaths,
	];
	const ancestors = new Set<string>();
	for (const root of roots) {
		let ancestor = dirname(root);
		while (ancestor !== "/") {
			ancestors.add(ancestor);
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
	}
	return Object.freeze([...ancestors]);
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function accessRule(
	rootIndex: number,
	protectedPathIndices: readonly number[],
	deniedReadRootIndices: readonly number[],
): string {
	const qualifiers = [`(subpath (param "WRITABLE_ROOT_${rootIndex}"))`];
	for (const index of protectedPathIndices) {
		qualifiers.push(`(require-not (literal (param "PROTECTED_PATH_${index}")))`);
		qualifiers.push(`(require-not (subpath (param "PROTECTED_PATH_${index}")))`);
	}
	for (const index of deniedReadRootIndices) {
		qualifiers.push(`(require-not (literal (param "DENIED_ROOT_${index}")))`);
		qualifiers.push(`(require-not (subpath (param "DENIED_ROOT_${index}")))`);
	}
	return `(require-all ${qualifiers.join(" ")})`;
}

function approvedReadRule(rootIndex: number, root: string, deniedReadRoots: readonly string[]): string {
	const qualifiers = [
		`(require-any (literal (param "APPROVED_READ_ROOT_${rootIndex}")) (subpath (param "APPROVED_READ_ROOT_${rootIndex}")))`,
	];
	for (const [deniedIndex, deniedRoot] of deniedReadRoots.entries()) {
		if (isContained(deniedRoot, root)) continue;
		qualifiers.push(`(require-not (literal (param "DENIED_ROOT_${deniedIndex}")))`);
		qualifiers.push(`(require-not (subpath (param "DENIED_ROOT_${deniedIndex}")))`);
	}
	return `(require-all ${qualifiers.join(" ")})`;
}

function fullDiskRule(operation: "file-read*" | "file-write*", deniedReadRootCount: number): string {
	if (deniedReadRootCount === 0) return `(allow ${operation})`;
	return `(allow ${operation} (require-all ${exclusions("DENIED_ROOT", deniedReadRootCount).join(" ")}))`;
}

const MACOS_RUNTIME_READ_RULES = Object.freeze([
	'(literal "/")',
	'(subpath "/bin")',
	'(subpath "/sbin")',
	'(subpath "/usr")',
	'(subpath "/System")',
	'(subpath "/Library")',
	'(subpath "/private/etc")',
	'(subpath "/private/var/select")',
	'(subpath "/opt")',
]);

export function buildMacosSeatbeltPolicy(
	policy: Readonly<CompiledSandboxPolicy>,
	options: { readonly runtimeReadPathCount?: number; readonly readAncestorPathCount?: number } = {},
): string {
	const sections = [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal (target same-sandbox))",
		'(allow file-write-data (literal "/dev/null"))',
		"(allow sysctl-read)",
	];
	if (policy.readAccess === "full-disk") {
		sections.push(fullDiskRule("file-read*", policy.deniedReadRoots.length));
	} else {
		sections.push(`(allow file-read* (require-any ${MACOS_RUNTIME_READ_RULES.join(" ")}))`);
		if (policy.readableRoots.length > 0) {
			sections.push(
				`(allow file-read* (require-all ${roots("READABLE_ROOT", policy.readableRoots.length)} ${exclusions("DENIED_ROOT", policy.deniedReadRoots.length).join(" ")}))`,
			);
		}
		if (policy.approvedReadRoots.length > 0) {
			sections.push(
				`(allow file-read* ${policy.approvedReadRoots
					.map((root, index) => approvedReadRule(index, root, policy.deniedReadRoots))
					.join(" ")})`,
			);
		}
		if ((options.runtimeReadPathCount ?? 0) > 0) {
			sections.push(`(allow file-read* ${roots("RUNTIME_READ_PATH", options.runtimeReadPathCount ?? 0)})`);
		}
		if ((options.readAncestorPathCount ?? 0) > 0) {
			sections.push(
				`(allow file-read-metadata ${literalRoots("READ_ANCESTOR", options.readAncestorPathCount ?? 0)})`,
			);
		}
	}
	if (policy.writableRoots === "full-disk") {
		sections.push(fullDiskRule("file-write*", policy.deniedReadRoots.length));
	} else if (policy.writableRoots.length > 0) {
		const allDeniedReadRootIndices = policy.deniedReadRoots.map((_, index) => index);
		const writeRules = policy.writableRoots
			.map((root, index) =>
				accessRule(
					index,
					policy.protectedMetadataPaths
						.map((path, pathIndex) => ({ path, pathIndex }))
						.filter(({ path }) => path !== root && isContained(root, path))
						.map(({ pathIndex }) => pathIndex),
					allDeniedReadRootIndices,
				),
			)
			.join("\n");
		const reviewedWriteRules = policy.writableRoots
			.map((root, index) => ({ root, index }))
			.filter(({ root }) => policy.approvedReadRoots.includes(root))
			.map(({ root, index }) =>
				accessRule(
					index,
					policy.protectedMetadataPaths
						.map((path, pathIndex) => ({ path, pathIndex }))
						.filter(({ path }) => path !== root && isContained(root, path))
						.map(({ pathIndex }) => pathIndex),
					policy.deniedReadRoots
						.map((deniedRoot, deniedIndex) => ({ deniedRoot, deniedIndex }))
						.filter(({ deniedRoot }) => !isContained(deniedRoot, root))
						.map(({ deniedIndex }) => deniedIndex),
				),
			)
			.join("\n");
		sections.push(`(allow file-write*\n${writeRules}${reviewedWriteRules ? `\n${reviewedWriteRules}` : ""}\n)`);
	}
	if (policy.networkAccess === "enabled") {
		sections.push("(allow network-outbound)", "(allow network-inbound)");
	}
	return sections.join("\n");
}

export function prepareMacosSeatbelt(
	command: readonly [string, ...string[]],
	policy: Readonly<CompiledSandboxPolicy>,
	options: {
		readonly managedProxyPorts?: readonly number[];
		readonly runtimeReadPaths?: readonly string[];
	} = {},
): PreparedSandboxCommand | undefined {
	if (!existsSync(MACOS_SANDBOX_EXECUTABLE)) return undefined;
	const runtimeReadPaths = options.runtimeReadPaths ?? [];
	const ancestorPaths = readAncestorPaths(policy, runtimeReadPaths);
	let policyText = buildMacosSeatbeltPolicy(policy, {
		runtimeReadPathCount: runtimeReadPaths.length,
		readAncestorPathCount: ancestorPaths.length,
	});
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
	for (let index = 0; index < policy.readableRoots.length; index++) {
		const root = policy.readableRoots[index];
		if (root !== undefined) args.push(`-DREADABLE_ROOT_${index}=${root}`);
	}
	for (let index = 0; index < policy.approvedReadRoots.length; index++) {
		const root = policy.approvedReadRoots[index];
		if (root !== undefined) args.push(`-DAPPROVED_READ_ROOT_${index}=${root}`);
	}
	for (let index = 0; index < runtimeReadPaths.length; index++) {
		const path = runtimeReadPaths[index];
		if (path !== undefined) args.push(`-DRUNTIME_READ_PATH_${index}=${path}`);
	}
	for (let index = 0; index < ancestorPaths.length; index++) {
		const path = ancestorPaths[index];
		if (path !== undefined) args.push(`-DREAD_ANCESTOR_${index}=${path}`);
	}
	args.push("--", ...command);
	return Object.freeze({ backend: "macos-seatbelt", executable: MACOS_SANDBOX_EXECUTABLE, args });
}
