import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledSandboxPolicy } from "./policy.ts";

const BWRAP_PROBE_TIMEOUT_MS = 2_000;
const TRUSTED_FALLBACK_SEARCH_PATHS = Object.freeze(["/usr/bin", "/bin", "/usr/local/bin"]);
const LINUX_RUNTIME_READ_ROOTS = Object.freeze([
	"/bin",
	"/sbin",
	"/usr",
	"/lib",
	"/lib64",
	"/etc",
	"/opt",
	"/nix/store",
	"/run/current-system",
]);
const bundledDigestExpectations = new Map<string, string>();

export interface LinuxBubblewrapResolutionOptions {
	readonly cwd: string;
	readonly path?: string;
	readonly bundledPath?: string;
	readonly bundledSha256?: string;
	readonly probe?: (path: string) => Promise<boolean>;
}

export interface PreparedLinuxBubblewrap {
	readonly backend: "linux-bwrap";
	readonly executable: string;
	readonly args: readonly string[];
	cleanup(): Promise<void>;
}

interface SyntheticProtectedTarget {
	readonly path: string;
	readonly device: bigint;
	readonly inode: bigint;
}

interface DeniedReadMount {
	readonly source: string;
	readonly target: string;
	readonly sourceIsDirectory: boolean;
}

interface PreparedDeniedReadMasks {
	readonly root?: string;
	readonly mounts: readonly DeniedReadMount[];
	readonly synthetic: readonly SyntheticProtectedTarget[];
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function overlaps(left: string, right: string): boolean {
	return isContained(left, right) || isContained(right, left);
}

function shallowRoots(roots: readonly string[]): readonly string[] {
	return Object.freeze(
		[...new Set(roots)].sort(
			(left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right),
		),
	);
}

async function existingRoots(roots: readonly string[]): Promise<readonly string[]> {
	const existing: string[] = [];
	for (const root of shallowRoots(roots)) {
		try {
			await lstat(root);
			existing.push(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return Object.freeze(existing);
}

async function isTrustedExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		const canonical = await realpath(path);
		const [file, parent] = await Promise.all([stat(canonical), stat(dirname(canonical))]);
		return (
			file.isFile() &&
			file.uid === 0 &&
			(file.mode & 0o6022) === 0 &&
			parent.uid === 0 &&
			(parent.mode & 0o022) === 0
		);
	} catch {
		return false;
	}
}

function candidateDirectories(path: string | undefined): readonly string[] {
	const fromPath = (path ?? "").split(delimiter).filter((entry) => isAbsolute(entry));
	return Object.freeze([...new Set([...fromPath, ...TRUSTED_FALLBACK_SEARCH_PATHS])]);
}

async function probeProcess(executable: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const child = spawn(
			executable,
			[
				"--new-session",
				"--die-with-parent",
				"--ro-bind",
				"/",
				"/",
				"--unshare-user",
				"--unshare-pid",
				"--",
				"/bin/true",
			],
			{ stdio: "ignore", shell: false },
		);
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(value);
		};
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, BWRAP_PROBE_TIMEOUT_MS);
		timeout.unref();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

function defaultBundledPath(): string | undefined {
	if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
	return fileURLToPath(new URL(`../resources/linux-${process.arch}/bwrap`, import.meta.url));
}

async function verifiedBundledExecutable(
	path: string,
	expectedSha256: string | undefined,
): Promise<string | undefined> {
	let digestExpectation = expectedSha256;
	if (digestExpectation === undefined) {
		digestExpectation = bundledDigestExpectations.get(path);
		if (digestExpectation === undefined) {
			try {
				digestExpectation = (await readFile(`${path}.sha256`, "utf8")).trim();
			} catch {
				return undefined;
			}
			bundledDigestExpectations.set(path, digestExpectation);
		}
	}
	if (!/^[a-f0-9]{64}$/u.test(digestExpectation)) return undefined;
	try {
		const canonical = await realpath(path);
		const contents = await readFile(canonical);
		const digest = createHash("sha256").update(contents).digest("hex");
		if (digest !== digestExpectation) throw new Error(`bundled bubblewrap digest mismatch for ${canonical}`);
		await access(canonical, constants.X_OK);
		return canonical;
	} catch (error) {
		if (error instanceof Error && error.message.includes("digest mismatch")) throw error;
		return undefined;
	}
}

export async function resolveLinuxBubblewrap(options: LinuxBubblewrapResolutionOptions): Promise<string | undefined> {
	const probe = options.probe ?? probeProcess;
	for (const directory of candidateDirectories(options.path ?? process.env.PATH)) {
		let candidate: string;
		try {
			candidate = await realpath(join(directory, "bwrap"));
		} catch {
			continue;
		}
		if (isContained(options.cwd, candidate) || !(await isTrustedExecutable(candidate))) continue;
		if (await probe(candidate)) return candidate;
	}
	const bundled = await verifiedBundledExecutable(
		options.bundledPath ?? defaultBundledPath() ?? "",
		options.bundledSha256,
	);
	return bundled && (await probe(bundled)) ? bundled : undefined;
}

export async function isWsl1(): Promise<boolean> {
	try {
		const release = (await readFile("/proc/sys/kernel/osrelease", "utf8")).toLowerCase();
		return release.includes("microsoft") && !release.includes("wsl2");
	} catch {
		return false;
	}
}

async function prepareProtectedTargets(
	policy: Readonly<CompiledSandboxPolicy>,
): Promise<{ readonly paths: readonly string[]; readonly synthetic: readonly SyntheticProtectedTarget[] }> {
	if (policy.writableRoots === "full-disk") return { paths: [], synthetic: [] };
	const paths = new Set<string>();
	const synthetic: SyntheticProtectedTarget[] = [];
	try {
		for (const path of policy.protectedMetadataPaths) {
			try {
				const metadata = await lstat(path);
				if (metadata.isSymbolicLink()) {
					throw new Error(
						`cannot enforce Linux Sandbox read-only path because it is a replaceable writable symlink: ${path}`,
					);
				}
				paths.add(await realpath(path));
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await mkdir(path, { mode: 0o000 });
				const metadata = await lstat(path, { bigint: true });
				if (!metadata.isDirectory()) throw new Error(`protected metadata placeholder is not a directory: ${path}`);
				synthetic.push({ path, device: metadata.dev, inode: metadata.ino });
				paths.add(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const metadata = await lstat(path);
				if (metadata.isSymbolicLink()) {
					throw new Error(
						`cannot enforce Linux Sandbox read-only path because it is a replaceable writable symlink: ${path}`,
					);
				}
				paths.add(await realpath(path));
			}
		}
		return { paths: Object.freeze([...paths]), synthetic: Object.freeze(synthetic) };
	} catch (error) {
		await cleanupSyntheticTargets(synthetic);
		throw error;
	}
}

async function cleanupSyntheticTargets(targets: readonly SyntheticProtectedTarget[]): Promise<void> {
	for (const target of [...targets].reverse()) {
		try {
			const metadata = await lstat(target.path, { bigint: true });
			if (!metadata.isDirectory() || metadata.dev !== target.device || metadata.ino !== target.inode) continue;
			await rmdir(target.path);
		} catch (error) {
			if (!["ENOENT", "ENOTEMPTY", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				throw error;
			}
		}
	}
}

function minimalDeniedReadRoots(roots: readonly string[]): readonly string[] {
	const sorted = [...new Set(roots)].sort(
		(left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right),
	);
	const minimal: string[] = [];
	for (const root of sorted) {
		if (!isAbsolute(root) || normalize(root) !== root) {
			throw new Error(`deny-read root must be a canonical absolute path: ${root}`);
		}
		if (minimal.some((parent) => isContained(parent, root))) continue;
		minimal.push(root);
	}
	return Object.freeze(minimal);
}

async function resolveDeniedReadTarget(
	path: string,
): Promise<{ readonly path: string; readonly isDirectory: boolean; readonly synthetic?: SyntheticProtectedTarget }> {
	let candidate = path;
	const missingNames: string[] = [];
	while (true) {
		try {
			const metadata = await lstat(candidate);
			if (metadata.isSymbolicLink()) {
				throw new Error(`deny-read root traverses a symbolic link instead of a canonical path: ${candidate}`);
			}
			const canonical = await realpath(candidate);
			if (canonical !== candidate) {
				throw new Error(`deny-read root must resolve through canonical ancestors: ${path}`);
			}
			if (missingNames.length === 0) {
				return { path: candidate, isDirectory: metadata.isDirectory() };
			}
			if (!metadata.isDirectory()) {
				throw new Error(`deny-read root has a non-directory ancestor: ${candidate}`);
			}
			const syntheticPath = join(candidate, missingNames.at(-1)!);
			try {
				await mkdir(syntheticPath, { mode: 0o000 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return resolveDeniedReadTarget(syntheticPath);
			}
			const syntheticMetadata = await lstat(syntheticPath, { bigint: true });
			if (!syntheticMetadata.isDirectory()) {
				throw new Error(`deny-read placeholder is not a directory: ${syntheticPath}`);
			}
			return {
				path: syntheticPath,
				isDirectory: true,
				synthetic: {
					path: syntheticPath,
					device: syntheticMetadata.dev,
					inode: syntheticMetadata.ino,
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (candidate === "/") throw new Error(`cannot resolve deny-read root: ${path}`);
			missingNames.push(basename(candidate));
			candidate = dirname(candidate);
		}
	}
}

async function cleanupDeniedReadMasks(prepared: PreparedDeniedReadMasks | undefined): Promise<void> {
	if (!prepared) return;
	let cleanupError: unknown;
	for (const mount of [...prepared.mounts].reverse()) {
		try {
			if (mount.sourceIsDirectory) {
				await chmod(mount.source, 0o700);
				await rm(mount.source, { recursive: true, force: true });
			} else await unlink(mount.source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError ??= error;
		}
	}
	if (prepared.root) {
		try {
			await rmdir(prepared.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError ??= error;
		}
	}
	try {
		await cleanupSyntheticTargets(prepared.synthetic);
	} catch (error) {
		cleanupError ??= error;
	}
	if (cleanupError) throw cleanupError;
}

async function prepareDeniedDirectoryMask(
	source: string,
	target: string,
	approvedReadRoots: readonly string[],
): Promise<void> {
	const descendants: Array<{ readonly root: string; readonly directory: boolean }> = [];
	for (const root of approvedReadRoots) {
		if (root === target || !isContained(target, root)) continue;
		try {
			descendants.push({ root, directory: (await lstat(root)).isDirectory() });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (descendants.length === 0) {
		await mkdir(source, { mode: 0o000 });
		return;
	}
	await mkdir(source, { mode: 0o700 });
	for (const descendant of descendants) {
		const names = relative(target, descendant.root).split(sep);
		let parent = source;
		for (const name of names.slice(0, -1)) {
			parent = join(parent, name);
			await mkdir(parent, { mode: 0o700, recursive: true });
		}
		const mountpoint = join(parent, names.at(-1)!);
		if (descendant.directory) await mkdir(mountpoint, { mode: 0o000 });
		else await writeFile(mountpoint, "", { mode: 0o000 });
	}
	await chmod(source, 0o111);
}

async function prepareDeniedReadMasks(policy: Readonly<CompiledSandboxPolicy>): Promise<PreparedDeniedReadMasks> {
	const roots = minimalDeniedReadRoots(policy.deniedReadRoots);
	if (roots.length === 0) return { mounts: [], synthetic: [] };
	const root = await mkdtemp(join(tmpdir(), ".coda-deny-read-"));
	const mounts: DeniedReadMount[] = [];
	const synthetic: SyntheticProtectedTarget[] = [];
	const prepared: PreparedDeniedReadMasks = { root, mounts, synthetic };
	try {
		for (const [index, deniedRoot] of roots.entries()) {
			const target = await resolveDeniedReadTarget(deniedRoot);
			if (target.synthetic) synthetic.push(target.synthetic);
			const source = join(root, `mask-${index}`);
			if (target.isDirectory) await prepareDeniedDirectoryMask(source, target.path, policy.approvedReadRoots);
			else await writeFile(source, "", { mode: 0o000 });
			mounts.push({ source, target: target.path, sourceIsDirectory: target.isDirectory });
		}
		return Object.freeze({
			root,
			mounts: Object.freeze(mounts),
			synthetic: Object.freeze(synthetic),
		});
	} catch (error) {
		await cleanupDeniedReadMasks(prepared);
		throw error;
	}
}

export async function prepareLinuxBubblewrap(
	bwrap: string,
	command: readonly [string, ...string[]],
	cwd: string,
	policy: Readonly<CompiledSandboxPolicy>,
	options: { readonly isolateNetwork: boolean; readonly helper?: readonly [string, ...string[]] },
): Promise<PreparedLinuxBubblewrap> {
	const protectedTargets = await prepareProtectedTargets(policy);
	let deniedReadMasks: PreparedDeniedReadMasks | undefined;
	try {
		const ordinaryExposedRoots = [
			...policy.readableRoots,
			...(policy.writableRoots === "full-disk" ? ["/"] : policy.writableRoots),
		];
		const relevantDeniedReadRoots = policy.deniedReadRoots.filter(
			(deniedRoot) =>
				!policy.approvedReadRoots.includes(deniedRoot) &&
				(ordinaryExposedRoots.some((root) => overlaps(root, deniedRoot)) ||
					policy.approvedReadRoots.some((approvedRoot) => isContained(approvedRoot, deniedRoot))),
		);
		deniedReadMasks = await prepareDeniedReadMasks(
			Object.freeze({ ...policy, deniedReadRoots: Object.freeze(relevantDeniedReadRoots) }),
		);
		const args: string[] = [
			"--new-session",
			"--die-with-parent",
			...(policy.readAccess === "full-disk"
				? [policy.writableRoots === "full-disk" ? "--bind" : "--ro-bind", "/", "/"]
				: ["--tmpfs", "/"]),
			"--dev",
			"/dev",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-uts",
		];
		if (options.isolateNetwork) args.push("--unshare-net");
		args.push("--proc", "/proc");
		if (policy.readAccess === "root-scoped") {
			const runtimeReadRoots = await existingRoots([
				...LINUX_RUNTIME_READ_ROOTS,
				...(isAbsolute(command[0]) ? [command[0]] : []),
				...(options.helper && isAbsolute(options.helper[0]) ? [options.helper[0]] : []),
			]);
			for (const root of runtimeReadRoots) args.push("--ro-bind", root, root);
			for (const root of await existingRoots(policy.readableRoots)) args.push("--ro-bind", root, root);
			for (const root of await existingRoots(policy.approvedReadRoots)) {
				if (!relevantDeniedReadRoots.some((deniedRoot) => isContained(deniedRoot, root))) {
					args.push("--ro-bind", root, root);
				}
			}
		}
		if (policy.writableRoots !== "full-disk") {
			const roots = [...policy.writableRoots].sort(
				(left, right) => left.split(sep).length - right.split(sep).length,
			);
			const protectedPaths = [...protectedTargets.paths].sort(
				(left, right) => left.split(sep).length - right.split(sep).length,
			);
			for (const root of roots) {
				args.push("--bind", root, root);
				for (const path of protectedPaths) {
					if (path !== root && isContained(root, path)) args.push("--ro-bind", path, path);
				}
			}
		}
		if (deniedReadMasks.root) {
			args.push("--ro-bind", deniedReadMasks.root, deniedReadMasks.root);
			for (const mount of deniedReadMasks.mounts) args.push("--ro-bind", mount.source, mount.target);
		}
		if (policy.readAccess === "root-scoped") {
			for (const root of await existingRoots(policy.approvedReadRoots)) {
				if (!relevantDeniedReadRoots.some((deniedRoot) => isContained(deniedRoot, root))) continue;
				const reviewedWrite =
					policy.writableRoots !== "full-disk" &&
					policy.writableRoots.some((writableRoot) => writableRoot === root);
				args.push(reviewedWrite ? "--bind" : "--ro-bind", root, root);
			}
		}
		args.push("--chdir", cwd, "--");
		args.push(...(options.helper ?? command));
		if (options.helper) args.push("--", ...command);
		return Object.freeze({
			backend: "linux-bwrap" as const,
			executable: bwrap,
			args: Object.freeze(args),
			cleanup: async () => {
				await cleanupDeniedReadMasks(deniedReadMasks);
				await cleanupSyntheticTargets(protectedTargets.synthetic);
			},
		});
	} catch (error) {
		await cleanupDeniedReadMasks(deniedReadMasks);
		await cleanupSyntheticTargets(protectedTargets.synthetic);
		throw error;
	}
}
