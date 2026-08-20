import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parseAgentSkill, validateAgentSkill } from "./parser.ts";
import type {
	CreateSkillsOptions,
	ParsedAgentSkill,
	SkillActivationOptions,
	SkillActivationResult,
	SkillCandidate,
	SkillDiagnostic,
	SkillDiagnosticCode,
	SkillDirectoryEntry,
	SkillFileStatus,
	SkillFileSystem,
	SkillId,
	SkillLimits,
	SkillProvenance,
	SkillRevision,
	SkillRoot,
	SkillSymlinkPolicy,
	Skills,
	SkillsSnapshot,
	SkillsSnapshotRequest,
} from "./types.ts";
import { DEFAULT_SKILL_LIMITS } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

interface RootRuntime<Origin> {
	readonly lexicalRoot: string;
	readonly canonicalRoot: string;
	readonly containmentRoot?: string;
	readonly allowOutsideRoot: boolean;
	readonly followSymlinks: boolean;
	readonly origin: Origin;
}

interface CandidateBuilder<Origin> {
	readonly id: SkillId;
	readonly revision: SkillRevision;
	readonly directory: string;
	readonly skillFile: string;
	readonly canonicalDirectory: string;
	readonly canonicalSkillFile: string;
	readonly parsed: ParsedAgentSkill;
	readonly provenance: SkillProvenance<Origin>[];
	readonly diagnostics: SkillDiagnostic<Origin>[];
}

interface PrivateCandidate<Origin> {
	readonly candidate: SkillCandidate<Origin>;
	readonly canonicalDirectory: string;
	readonly canonicalSkillFile: string;
}

interface DiscoveryState<Origin> {
	readonly fileSystem: SkillFileSystem;
	readonly limits: Readonly<SkillLimits>;
	readonly profile: "compatible" | "strict";
	readonly signal?: AbortSignal;
	readonly diagnostics: SkillDiagnostic<Origin>[];
	readonly candidates: Map<string, CandidateBuilder<Origin>>;
	directories: number;
	entries: number;
	stopped: boolean;
}

interface ResolvedEntry {
	readonly canonicalPath: string;
	readonly status: SkillFileStatus;
	readonly followedSymlink: boolean;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function skillId(path: string): SkillId {
	return `skill:${sha256(`coda-skill-id-v1\0${path}`).slice(0, 32)}` as SkillId;
}

function revisionFor(skillHash: string): SkillRevision {
	return sha256(`coda-agent-skill-revision-v1\0${skillHash}`) as SkillRevision;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as Error & { readonly code?: unknown }).code)
		: undefined;
}

function diagnostic<Origin>(
	code: SkillDiagnosticCode,
	severity: SkillDiagnostic<Origin>["severity"],
	phase: SkillDiagnostic<Origin>["phase"],
	message: string,
	options: {
		readonly path?: string;
		readonly origin?: Origin;
		readonly field?: string;
		readonly recovered?: boolean;
	} = {},
): SkillDiagnostic<Origin> {
	return Object.freeze({ code, severity, phase, message, ...options });
}

function withOrigin<Origin>(entry: SkillDiagnostic, origin: Origin): SkillDiagnostic<Origin> {
	return Object.freeze({ ...entry, origin });
}

function resolveLimits(overrides: Partial<SkillLimits> | undefined): Readonly<SkillLimits> {
	const limits = { ...DEFAULT_SKILL_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	}
	if (limits.maxYamlDepth > 64) throw new TypeError("maxYamlDepth must not exceed 64");
	return Object.freeze(limits);
}

function decodeText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeArguments(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\r\n?/gu, "\n").trim();
	return normalized ? normalized : undefined;
}

async function canonicalContainmentRoot(
	policy: SkillSymlinkPolicy,
	fileSystem: SkillFileSystem,
): Promise<string | undefined> {
	if (policy.mode !== "follow" || !("containmentRoot" in policy)) return undefined;
	if (!isAbsolute(policy.containmentRoot)) throw new TypeError("symlink containmentRoot must be absolute");
	const canonical = await fileSystem.realpath(policy.containmentRoot);
	const status = await fileSystem.stat(canonical);
	if (status.kind !== "directory") throw new TypeError("symlink containmentRoot must be a directory");
	return canonical;
}

function validatedSymlinkPolicy(value: SkillSymlinkPolicy | undefined): SkillSymlinkPolicy {
	const policy = value ?? ({ mode: "ignore" } as const);
	if (policy.mode === "ignore") return policy;
	if (policy.mode !== "follow") throw new TypeError("Unknown Skill symlink policy");
	const hasContainment = "containmentRoot" in policy && typeof policy.containmentRoot === "string";
	const allowsOutside = "allowOutsideRoot" in policy && policy.allowOutsideRoot === true;
	if (hasContainment === allowsOutside) {
		throw new TypeError("follow symlink policy requires exactly one containmentRoot or allowOutsideRoot: true");
	}
	return policy;
}

async function prepareRoot<Origin>(
	root: SkillRoot<Origin>,
	state: DiscoveryState<Origin>,
): Promise<RootRuntime<Origin> | undefined> {
	if (!isAbsolute(root.path)) throw new TypeError(`Skill root must be absolute: ${root.path}`);
	const policy = validatedSymlinkPolicy(root.symlinks);
	const containmentRoot = await canonicalContainmentRoot(policy, state.fileSystem);
	let lexicalStatus: SkillFileStatus;
	try {
		lexicalStatus = await state.fileSystem.lstat(root.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			state.diagnostics.push(
				diagnostic("root-not-found", "info", "discover", "Skill root does not exist", {
					path: root.path,
					origin: root.origin,
				}),
			);
			return undefined;
		}
		state.diagnostics.push(
			diagnostic("root-read-failed", "warning", "discover", `Could not inspect Skill root: ${String(error)}`, {
				path: root.path,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	if (lexicalStatus.kind === "symbolic-link" && policy.mode === "ignore") {
		state.diagnostics.push(
			diagnostic("symlink-skipped", "info", "discover", "Ignored symlink Skill root", {
				path: root.path,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	let canonicalRoot: string;
	let status: SkillFileStatus;
	try {
		canonicalRoot = await state.fileSystem.realpath(root.path);
		status = await state.fileSystem.stat(canonicalRoot);
	} catch (error) {
		state.diagnostics.push(
			diagnostic("root-read-failed", "warning", "discover", `Could not resolve Skill root: ${String(error)}`, {
				path: root.path,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	if (status.kind !== "directory") {
		state.diagnostics.push(
			diagnostic("root-not-directory", "warning", "discover", "Skill root is not a directory", {
				path: root.path,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	if (containmentRoot && !isContained(containmentRoot, canonicalRoot)) {
		state.diagnostics.push(
			diagnostic("symlink-outside-boundary", "warning", "discover", "Skill root resolves outside its boundary", {
				path: root.path,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	return Object.freeze({
		lexicalRoot: root.path,
		canonicalRoot,
		containmentRoot,
		allowOutsideRoot: policy.mode === "follow" && "allowOutsideRoot" in policy && policy.allowOutsideRoot === true,
		followSymlinks: policy.mode === "follow",
		origin: root.origin,
	});
}

async function resolveEntry<Origin>(
	lexicalPath: string,
	kind: SkillDirectoryEntry["kind"],
	root: RootRuntime<Origin>,
	state: DiscoveryState<Origin>,
): Promise<ResolvedEntry | undefined> {
	let symbolic = kind === "symbolic-link";
	try {
		symbolic = symbolic || (await state.fileSystem.lstat(lexicalPath)).kind === "symbolic-link";
	} catch (error) {
		state.diagnostics.push(
			diagnostic("root-read-failed", "warning", "discover", `Could not inspect discovery entry: ${String(error)}`, {
				path: lexicalPath,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	if (symbolic && !root.followSymlinks) {
		state.diagnostics.push(
			diagnostic("symlink-skipped", "info", "discover", "Ignored symlink while discovering Skills", {
				path: lexicalPath,
				origin: root.origin,
			}),
		);
		return undefined;
	}
	try {
		const canonicalPath = await state.fileSystem.realpath(lexicalPath);
		if (root.containmentRoot && !isContained(root.containmentRoot, canonicalPath)) {
			state.diagnostics.push(
				diagnostic("symlink-outside-boundary", "warning", "discover", "Symlink target is outside its boundary", {
					path: lexicalPath,
					origin: root.origin,
				}),
			);
			return undefined;
		}
		if (symbolic && !root.containmentRoot && !root.allowOutsideRoot) {
			throw new TypeError("follow policy requires containmentRoot or allowOutsideRoot");
		}
		return Object.freeze({
			canonicalPath,
			status: await state.fileSystem.stat(canonicalPath),
			followedSymlink: symbolic,
		});
	} catch (error) {
		state.diagnostics.push(
			diagnostic(
				symbolic ? "symlink-broken" : "root-read-failed",
				"warning",
				"discover",
				`Could not resolve discovery entry: ${String(error)}`,
				{ path: lexicalPath, origin: root.origin },
			),
		);
		return undefined;
	}
}

function candidateDiagnostics<Origin>(
	entries: readonly SkillDiagnostic[],
	origin: Origin,
): readonly SkillDiagnostic<Origin>[] {
	return Object.freeze(entries.map((entry) => withOrigin(entry, origin)));
}

async function loadCandidate<Origin>(
	lexicalDirectory: string,
	canonicalDirectory: string,
	canonicalFile: string,
	status: SkillFileStatus,
	depth: number,
	root: RootRuntime<Origin>,
	state: DiscoveryState<Origin>,
): Promise<void> {
	state.signal?.throwIfAborted();
	const existing = state.candidates.get(canonicalFile);
	const provenance = Object.freeze({ root: root.lexicalRoot, origin: root.origin, depth });
	if (existing) {
		const duplicate = diagnostic(
			"duplicate-canonical-path",
			"info",
			"discover",
			"The same canonical SKILL.md was discovered through more than one root",
			{ path: canonicalFile, origin: root.origin },
		);
		existing.provenance.push(provenance);
		existing.diagnostics.push(duplicate);
		state.diagnostics.push(duplicate);
		return;
	}
	if (state.candidates.size >= state.limits.maxSkills) {
		state.diagnostics.push(
			diagnostic("skill-limit-exceeded", "error", "discover", `Skill count exceeds ${state.limits.maxSkills}`, {
				path: canonicalFile,
				origin: root.origin,
			}),
		);
		state.stopped = true;
		return;
	}
	if (status.kind !== "file") {
		state.diagnostics.push(
			diagnostic("skill-file-not-regular", "warning", "discover", "SKILL.md is not a regular file", {
				path: canonicalFile,
				origin: root.origin,
			}),
		);
		return;
	}
	if (status.size > state.limits.maxSkillFileBytes) {
		state.diagnostics.push(
			diagnostic(
				"skill-file-too-large",
				"warning",
				"discover",
				`SKILL.md exceeds the ${state.limits.maxSkillFileBytes}-byte limit`,
				{ path: canonicalFile, origin: root.origin },
			),
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = await state.fileSystem.readFile(canonicalFile);
		state.signal?.throwIfAborted();
	} catch (error) {
		state.signal?.throwIfAborted();
		state.diagnostics.push(
			diagnostic("skill-read-failed", "warning", "discover", `Could not read SKILL.md: ${String(error)}`, {
				path: canonicalFile,
				origin: root.origin,
			}),
		);
		return;
	}
	if (bytes.byteLength > state.limits.maxSkillFileBytes) {
		state.diagnostics.push(
			diagnostic(
				"skill-file-too-large",
				"warning",
				"discover",
				`SKILL.md exceeds the ${state.limits.maxSkillFileBytes}-byte limit`,
				{ path: canonicalFile, origin: root.origin },
			),
		);
		return;
	}
	let text: string;
	try {
		text = decodeText(bytes);
	} catch {
		state.diagnostics.push(
			diagnostic("invalid-utf8", "warning", "discover", "SKILL.md is not valid UTF-8", {
				path: canonicalFile,
				origin: root.origin,
			}),
		);
		return;
	}
	const input = {
		text,
		directoryName: basename(lexicalDirectory),
		path: canonicalFile,
		maxFrontmatterBytes: state.limits.maxFrontmatterBytes,
		maxYamlDepth: state.limits.maxYamlDepth,
	};
	const parsed = state.profile === "strict" ? validateAgentSkill(input) : parseAgentSkill(input);
	const parsedDiagnostics = candidateDiagnostics(parsed.diagnostics, root.origin);
	state.diagnostics.push(...parsedDiagnostics);
	if ((state.profile === "strict" && "valid" in parsed && !parsed.valid) || !parsed.skill) return;
	const skillHash = sha256(bytes);
	state.candidates.set(canonicalFile, {
		id: skillId(canonicalFile),
		revision: revisionFor(skillHash),
		directory: lexicalDirectory,
		skillFile: join(lexicalDirectory, SKILL_FILE),
		canonicalDirectory,
		canonicalSkillFile: canonicalFile,
		parsed: parsed.skill,
		provenance: [provenance],
		diagnostics: [...parsedDiagnostics],
	});
}

async function walkDirectory<Origin>(
	lexicalDirectory: string,
	canonicalDirectory: string,
	depth: number,
	root: RootRuntime<Origin>,
	state: DiscoveryState<Origin>,
	visited: Set<string>,
): Promise<void> {
	state.signal?.throwIfAborted();
	if (state.stopped) return;
	if (depth > state.limits.maxDepth) {
		state.diagnostics.push(
			diagnostic("scan-depth-exceeded", "error", "discover", `Discovery depth exceeds ${state.limits.maxDepth}`, {
				path: lexicalDirectory,
				origin: root.origin,
			}),
		);
		return;
	}
	if (visited.has(canonicalDirectory)) {
		state.diagnostics.push(
			diagnostic("symlink-cycle", "warning", "discover", "Skipped an already visited canonical directory", {
				path: lexicalDirectory,
				origin: root.origin,
			}),
		);
		return;
	}
	visited.add(canonicalDirectory);
	state.directories++;
	if (state.directories > state.limits.maxDirectories) {
		state.diagnostics.push(
			diagnostic(
				"scan-directory-limit-exceeded",
				"error",
				"discover",
				`Discovery exceeds ${state.limits.maxDirectories} directories`,
				{ path: lexicalDirectory, origin: root.origin },
			),
		);
		state.stopped = true;
		return;
	}
	let entries: readonly SkillDirectoryEntry[];
	try {
		entries = [...(await state.fileSystem.readDirectory(canonicalDirectory))].sort((left, right) =>
			compareText(left.name, right.name),
		);
		state.signal?.throwIfAborted();
	} catch (error) {
		state.signal?.throwIfAborted();
		state.diagnostics.push(
			diagnostic("root-read-failed", "warning", "discover", `Could not read directory: ${String(error)}`, {
				path: lexicalDirectory,
				origin: root.origin,
			}),
		);
		return;
	}
	state.entries += entries.length;
	if (state.entries > state.limits.maxEntries) {
		state.diagnostics.push(
			diagnostic(
				"scan-entry-limit-exceeded",
				"error",
				"discover",
				`Discovery exceeds ${state.limits.maxEntries} entries`,
				{
					path: lexicalDirectory,
					origin: root.origin,
				},
			),
		);
		state.stopped = true;
		return;
	}
	const skillEntry = entries.find((entry) => entry.name === SKILL_FILE);
	if (skillEntry) {
		const resolved = await resolveEntry(join(lexicalDirectory, SKILL_FILE), skillEntry.kind, root, state);
		if (resolved) {
			await loadCandidate(
				lexicalDirectory,
				canonicalDirectory,
				resolved.canonicalPath,
				resolved.status,
				depth,
				root,
				state,
			);
		}
		return;
	}
	for (const entry of entries) {
		if (state.stopped) return;
		if (entry.name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
		if (entry.kind !== "directory" && entry.kind !== "symbolic-link") continue;
		const lexicalChild = join(lexicalDirectory, entry.name);
		const resolved = await resolveEntry(lexicalChild, entry.kind, root, state);
		if (!resolved || resolved.status.kind !== "directory") continue;
		await walkDirectory(lexicalChild, resolved.canonicalPath, depth + 1, root, state, visited);
	}
}

function freezeCandidate<Origin>(builder: CandidateBuilder<Origin>): PrivateCandidate<Origin> {
	const candidate: SkillCandidate<Origin> = Object.freeze({
		id: builder.id,
		revision: builder.revision,
		directory: builder.directory,
		skillFile: builder.skillFile,
		metadata: builder.parsed.metadata,
		conformant: builder.parsed.conformant,
		provenance: Object.freeze([...builder.provenance]),
		diagnostics: Object.freeze([...builder.diagnostics]),
	});
	return Object.freeze({
		candidate,
		canonicalDirectory: builder.canonicalDirectory,
		canonicalSkillFile: builder.canonicalSkillFile,
	});
}

async function listResources<Origin>(
	privateCandidate: PrivateCandidate<Origin>,
	fileSystem: SkillFileSystem,
	limits: Readonly<SkillLimits>,
	signal: AbortSignal | undefined,
): Promise<{ readonly resources: readonly string[]; readonly diagnostics: readonly SkillDiagnostic<Origin>[] }> {
	const candidate = privateCandidate.candidate;
	const resources: string[] = [];
	const diagnostics: SkillDiagnostic<Origin>[] = [];
	const origin = candidate.provenance[0]?.origin;
	const visited = new Set<string>();
	let entriesSeen = 0;
	let limitReported = false;
	const walk = async (lexicalDirectory: string, canonicalDirectory: string, depth: number): Promise<void> => {
		signal?.throwIfAborted();
		if (depth > limits.maxResourceDepth) {
			diagnostics.push(
				diagnostic(
					"resource-depth-exceeded",
					"warning",
					"resource",
					`Resource traversal exceeds depth ${limits.maxResourceDepth}`,
					{ path: lexicalDirectory, ...(origin !== undefined ? { origin } : {}) },
				),
			);
			return;
		}
		if (visited.has(canonicalDirectory)) {
			diagnostics.push(
				diagnostic(
					"resource-symlink-skipped",
					"info",
					"resource",
					"Ignored an already visited Skill resource directory",
					{ path: lexicalDirectory, ...(origin !== undefined ? { origin } : {}) },
				),
			);
			return;
		}
		visited.add(canonicalDirectory);
		let entries: readonly SkillDirectoryEntry[];
		try {
			entries = [...(await fileSystem.readDirectory(canonicalDirectory))].sort((left, right) =>
				compareText(left.name, right.name),
			);
			signal?.throwIfAborted();
		} catch (error) {
			signal?.throwIfAborted();
			diagnostics.push(
				diagnostic(
					"resource-read-failed",
					"warning",
					"resource",
					`Could not list Skill resources: ${String(error)}`,
					{
						path: lexicalDirectory,
						...(origin !== undefined ? { origin } : {}),
					},
				),
			);
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
			const path = join(lexicalDirectory, entry.name);
			const relativePath = relative(candidate.directory, path).split(sep).join("/");
			if (relativePath === SKILL_FILE) continue;
			entriesSeen++;
			if (entriesSeen > limits.maxResourceEntries) {
				if (!limitReported) {
					limitReported = true;
					diagnostics.push(
						diagnostic(
							"resource-limit-exceeded",
							"warning",
							"resource",
							`Resource listing exceeds ${limits.maxResourceEntries} entries`,
							{ path: candidate.directory, ...(origin !== undefined ? { origin } : {}) },
						),
					);
				}
				return;
			}
			let status: SkillFileStatus;
			try {
				status = await fileSystem.lstat(path);
				signal?.throwIfAborted();
			} catch (error) {
				signal?.throwIfAborted();
				diagnostics.push(
					diagnostic(
						"resource-read-failed",
						"warning",
						"resource",
						`Could not inspect Skill resource: ${String(error)}`,
						{ path, ...(origin !== undefined ? { origin } : {}) },
					),
				);
				continue;
			}
			if (entry.kind === "symbolic-link" || status.kind === "symbolic-link") {
				diagnostics.push(
					diagnostic("resource-symlink-skipped", "info", "resource", "Ignored symlink Skill resource", {
						path,
						...(origin !== undefined ? { origin } : {}),
					}),
				);
				continue;
			}
			if (status.kind === "file") {
				try {
					const canonicalPath = await fileSystem.realpath(path);
					const canonicalStatus = await fileSystem.stat(canonicalPath);
					signal?.throwIfAborted();
					if (canonicalStatus.kind === "file" && isContained(privateCandidate.canonicalDirectory, canonicalPath)) {
						resources.push(relativePath);
					} else {
						diagnostics.push(
							diagnostic(
								"resource-symlink-skipped",
								"info",
								"resource",
								"Ignored resource file outside the Skill bundle",
								{ path, ...(origin !== undefined ? { origin } : {}) },
							),
						);
					}
				} catch (error) {
					signal?.throwIfAborted();
					diagnostics.push(
						diagnostic(
							"resource-read-failed",
							"warning",
							"resource",
							`Could not resolve Skill resource file: ${String(error)}`,
							{ path, ...(origin !== undefined ? { origin } : {}) },
						),
					);
				}
				continue;
			}
			if (status.kind !== "directory") continue;
			try {
				const canonicalPath = await fileSystem.realpath(path);
				const canonicalStatus = await fileSystem.stat(canonicalPath);
				signal?.throwIfAborted();
				if (
					canonicalStatus.kind !== "directory" ||
					!isContained(privateCandidate.canonicalDirectory, canonicalPath)
				) {
					diagnostics.push(
						diagnostic(
							"resource-symlink-skipped",
							"info",
							"resource",
							"Ignored resource directory whose canonical identity changed",
							{ path, ...(origin !== undefined ? { origin } : {}) },
						),
					);
					continue;
				}
				await walk(path, canonicalPath, depth + 1);
			} catch (error) {
				signal?.throwIfAborted();
				diagnostics.push(
					diagnostic(
						"resource-read-failed",
						"warning",
						"resource",
						`Could not resolve Skill resource directory: ${String(error)}`,
						{ path, ...(origin !== undefined ? { origin } : {}) },
					),
				);
			}
		}
	};
	await walk(candidate.directory, privateCandidate.canonicalDirectory, 0);
	return Object.freeze({ resources: Object.freeze(resources), diagnostics: Object.freeze(diagnostics) });
}

async function activateCandidate<Origin>(
	privateCandidate: PrivateCandidate<Origin>,
	fileSystem: SkillFileSystem,
	limits: Readonly<SkillLimits>,
	options: SkillActivationOptions | undefined,
): Promise<SkillActivationResult<Origin>> {
	const candidate = privateCandidate.candidate;
	const origin = candidate.provenance[0]?.origin;
	options?.signal?.throwIfAborted();
	try {
		const canonicalFile = await fileSystem.realpath(candidate.skillFile);
		options?.signal?.throwIfAborted();
		if (canonicalFile !== privateCandidate.canonicalSkillFile) {
			throw new Error("SKILL.md canonical identity changed");
		}
		const status = await fileSystem.lstat(privateCandidate.canonicalSkillFile);
		options?.signal?.throwIfAborted();
		if (status.kind !== "file" || status.size > limits.maxSkillFileBytes)
			throw new Error("SKILL.md changed kind or size");
		const bytes = await fileSystem.readFile(privateCandidate.canonicalSkillFile);
		options?.signal?.throwIfAborted();
		if (bytes.byteLength > limits.maxSkillFileBytes) throw new Error("SKILL.md exceeds the activation size limit");
		if ((await fileSystem.realpath(candidate.skillFile)) !== privateCandidate.canonicalSkillFile) {
			throw new Error("SKILL.md canonical identity changed");
		}
		const text = decodeText(bytes);
		if (text.includes("\0")) throw new Error("SKILL.md contains a NUL byte");
		const revision = revisionFor(sha256(bytes));
		if (revision !== candidate.revision) {
			const stale = diagnostic(
				"snapshot-stale",
				"error",
				"activate",
				"Skill content changed after this snapshot was created",
				{ path: candidate.skillFile, ...(origin !== undefined ? { origin } : {}) },
			);
			return Object.freeze({ ok: false, diagnostic: stale, diagnostics: Object.freeze([stale]) });
		}
		const parsed = parseAgentSkill({
			text,
			directoryName: basename(candidate.directory),
			path: candidate.skillFile,
			maxFrontmatterBytes: limits.maxFrontmatterBytes,
			maxYamlDepth: limits.maxYamlDepth,
		});
		if (!parsed.skill) throw new Error("SKILL.md no longer parses");
		if ((await fileSystem.realpath(candidate.directory)) !== privateCandidate.canonicalDirectory) {
			throw new Error("Skill bundle canonical identity changed");
		}
		const resources = await listResources(privateCandidate, fileSystem, limits, options?.signal);
		const activationDiagnostics = resources.diagnostics;
		return Object.freeze({
			ok: true,
			activation: Object.freeze({
				candidate,
				revision,
				contents: text,
				body: parsed.skill.body,
				baseDirectory: candidate.directory,
				...(safeArguments(options?.arguments) ? { arguments: safeArguments(options?.arguments) } : {}),
				resources: resources.resources,
				diagnostics: activationDiagnostics,
			}),
			diagnostics: activationDiagnostics,
		});
	} catch (error) {
		options?.signal?.throwIfAborted();
		const failed = diagnostic(
			"activation-read-failed",
			"error",
			"activate",
			`Could not activate Skill: ${error instanceof Error ? error.message : String(error)}`,
			{ path: candidate.skillFile, ...(origin !== undefined ? { origin } : {}) },
		);
		return Object.freeze({ ok: false, diagnostic: failed, diagnostics: Object.freeze([failed]) });
	}
}

async function createSnapshot<Origin>(
	options: CreateSkillsOptions,
	limits: Readonly<SkillLimits>,
	request: SkillsSnapshotRequest<Origin>,
): Promise<SkillsSnapshot<Origin>> {
	const state: DiscoveryState<Origin> = {
		fileSystem: options.fileSystem,
		limits,
		profile: request.profile ?? "compatible",
		signal: request.signal,
		diagnostics: [],
		candidates: new Map(),
		directories: 0,
		entries: 0,
		stopped: false,
	};
	if (state.profile !== "compatible" && state.profile !== "strict") throw new TypeError("Unknown Skill load profile");
	for (const input of request.roots) {
		request.signal?.throwIfAborted();
		if (state.stopped) break;
		const root = await prepareRoot(input, state);
		if (!root) continue;
		await walkDirectory(root.lexicalRoot, root.canonicalRoot, 0, root, state, new Set());
	}
	const finalized = Object.freeze(
		[...state.candidates.values()]
			.map(freezeCandidate)
			.sort((left, right) => compareText(left.candidate.skillFile, right.candidate.skillFile)),
	);
	const candidates = Object.freeze(finalized.map(({ candidate }) => candidate));
	const privateCandidates = new Map(finalized.map((candidate) => [candidate.candidate.id, candidate]));
	const diagnostics = Object.freeze([...state.diagnostics]);
	const snapshot: SkillsSnapshot<Origin> = {
		candidates,
		diagnostics,
		activate: async (
			id: SkillId,
			activationOptions?: SkillActivationOptions,
		): Promise<SkillActivationResult<Origin>> => {
			const selected = privateCandidates.get(id);
			if (selected) return activateCandidate(selected, options.fileSystem, limits, activationOptions);
			const missing = diagnostic<Origin>(
				"activation-not-found",
				"error",
				"activate",
				`Skill is not present in this snapshot: ${String(id)}`,
			);
			return Object.freeze({ ok: false, diagnostic: missing, diagnostics: Object.freeze([missing]) });
		},
	};
	return Object.freeze(snapshot);
}

class FileOperationLimiter {
	readonly #maximum: number;
	readonly #waiting: (() => void)[] = [];
	#active = 0;

	constructor(maximum: number) {
		this.#maximum = maximum;
	}

	async #acquire(): Promise<void> {
		if (this.#active < this.#maximum) {
			this.#active++;
			return;
		}
		await new Promise<void>((resolve) => this.#waiting.push(resolve));
	}

	#release(): void {
		const next = this.#waiting.shift();
		if (next) next();
		else this.#active--;
	}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		await this.#acquire();
		try {
			return await operation();
		} finally {
			this.#release();
		}
	}
}

function boundedFileSystem(fileSystem: SkillFileSystem, maximum: number): SkillFileSystem {
	const limiter = new FileOperationLimiter(maximum);
	return Object.freeze({
		realpath: (path: string) => limiter.run(() => fileSystem.realpath(path)),
		stat: (path: string) => limiter.run(() => fileSystem.stat(path)),
		lstat: (path: string) => limiter.run(() => fileSystem.lstat(path)),
		readFile: (path: string) => limiter.run(() => fileSystem.readFile(path)),
		readDirectory: (path: string) => limiter.run(() => fileSystem.readDirectory(path)),
	});
}

export function createSkills<Origin = unknown>(options: CreateSkillsOptions): Skills<Origin> {
	if (!options || typeof options !== "object" || !options.fileSystem) throw new TypeError("fileSystem is required");
	const limits = resolveLimits(options.limits);
	const runtimeOptions: CreateSkillsOptions = Object.freeze({
		...options,
		fileSystem: boundedFileSystem(options.fileSystem, limits.maxConcurrentReads),
	});
	return Object.freeze({
		snapshot: (request: SkillsSnapshotRequest<Origin>) => {
			if (!request || !Array.isArray(request.roots)) throw new TypeError("snapshot roots are required");
			return createSnapshot(runtimeOptions, limits, request);
		},
	});
}
