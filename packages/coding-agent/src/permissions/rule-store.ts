import { chmod, mkdir, open, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeNetworkHost } from "@coda/sandbox";
import type { CommandPolicy, CommandRule } from "./command-policy.ts";
import { parseCommandPolicy } from "./command-policy-parser.ts";
import type { NetworkRule } from "./permission-engine.ts";

const NETWORK_RULES_VERSION = 1;

export interface PermissionRuleStore {
	loadCommandPolicy(): Promise<CommandPolicy>;
	appendCommandRule(rule: CommandRule): Promise<void>;
	loadNetworkRules(): Promise<readonly NetworkRule[]>;
	appendNetworkRule(rule: NetworkRule): Promise<void>;
}

export interface PermissionRuleStorePaths {
	readonly commandRules: string;
	readonly networkRules: string;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validateCommandRule(value: unknown, source: string): CommandRule {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid Command Rule in ${source}`);
	const input = value as Record<string, unknown>;
	if (!hasOnlyKeys(input, ["pattern", "decision", "justification"])) {
		throw new Error(`Invalid Command Rule field in ${source}`);
	}
	if (!Array.isArray(input.pattern) || input.pattern.length === 0) {
		throw new Error(`Command Rule pattern must be non-empty in ${source}`);
	}
	const pattern = input.pattern.map((token) => {
		if (typeof token === "string" && token !== "") return token;
		if (
			Array.isArray(token) &&
			token.length > 0 &&
			token.every((entry) => typeof entry === "string" && entry !== "")
		) {
			return Object.freeze([...token] as string[]);
		}
		throw new Error(`Invalid Command Rule pattern token in ${source}`);
	});
	if (input.decision !== "allow" && input.decision !== "prompt" && input.decision !== "forbidden") {
		throw new Error(`Invalid Command Rule decision in ${source}`);
	}
	if (
		input.justification !== undefined &&
		(typeof input.justification !== "string" || input.justification.trim() === "")
	) {
		throw new Error(`Invalid Command Rule justification in ${source}`);
	}
	return Object.freeze({
		pattern: Object.freeze(pattern),
		decision: input.decision,
		...(input.justification ? { justification: input.justification } : {}),
	});
}

function serializeCommandRule(rule: CommandRule): string {
	const validated = validateCommandRule(rule, "append request");
	return `prefix_rule(pattern=${JSON.stringify(validated.pattern)}, decision=${JSON.stringify(validated.decision)}${validated.justification ? `, justification=${JSON.stringify(validated.justification)}` : ""})`;
}

function validateNetworkRule(value: unknown, source: string): NetworkRule {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid Network Rule in ${source}`);
	const input = value as Record<string, unknown>;
	if (!hasOnlyKeys(input, ["host", "protocol", "action", "justification"])) {
		throw new Error(`Invalid Network Rule field in ${source}`);
	}
	if (typeof input.host !== "string") {
		throw new Error(`Invalid Network Rule host in ${source}`);
	}
	const rawHost = input.host.trim();
	if (!rawHost || rawHost.includes("://") || /[/?#]/u.test(rawHost)) {
		throw new Error(`Invalid Network Rule host in ${source}`);
	}
	const host = normalizeNetworkHost(rawHost);
	if (!host || host.includes("[") || host.includes("]") || host.includes("*") || /\s/u.test(host)) {
		throw new Error(`Invalid Network Rule host in ${source}`);
	}
	if (input.protocol !== "http" && input.protocol !== "https") {
		throw new Error(`Invalid Network Rule protocol in ${source}`);
	}
	if (input.action !== "allow" && input.action !== "deny") {
		throw new Error(`Invalid Network Rule action in ${source}`);
	}
	if (
		input.justification !== undefined &&
		(typeof input.justification !== "string" || input.justification.trim() === "")
	) {
		throw new Error(`Invalid Network Rule justification in ${source}`);
	}
	return Object.freeze({
		host,
		protocol: input.protocol,
		action: input.action,
		...(input.justification ? { justification: input.justification } : {}),
	});
}

async function loadText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function ensurePrivateParent(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
}

let temporaryIdentity = 0;
const mutationQueues = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 30_000;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

async function removeAbandonedLock(lockDirectory: string, ownerPath: string): Promise<boolean> {
	try {
		await unlink(ownerPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	try {
		await rmdir(lockDirectory);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTEMPTY") return false;
		throw error;
	}
}

async function removeAbandonedEmptyLock(lockDirectory: string): Promise<boolean> {
	const recoveryPath = join(lockDirectory, `recovery-${process.pid}-${++temporaryIdentity}`);
	let recovery: Awaited<ReturnType<typeof open>>;
	try {
		recovery = await open(recoveryPath, "wx", 0o600);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") return false;
		throw error;
	}
	await recovery.close();
	try {
		await unlink(recoveryPath);
		await rmdir(lockDirectory);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTEMPTY") return false;
		throw error;
	}
}

async function acquireMutationLock(path: string): Promise<() => Promise<void>> {
	await ensurePrivateParent(path);
	const lockDirectory = `${path}.coda-lock`;
	const ownerPath = join(lockDirectory, "owner.json");
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockDirectory, { mode: 0o700 });
			try {
				await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`, {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				await rmdir(lockDirectory).catch(() => undefined);
				throw error;
			}
			return async () => {
				await unlink(ownerPath).catch((error) => {
					if (errorCode(error) !== "ENOENT") throw error;
				});
				await rmdir(lockDirectory).catch((error) => {
					if (errorCode(error) !== "ENOENT") throw error;
				});
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}

		let lockAge = 0;
		try {
			lockAge = Date.now() - (await stat(lockDirectory)).mtimeMs;
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		try {
			const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { readonly pid?: unknown };
			if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
				if (!processIsAlive(owner.pid) && (await removeAbandonedLock(lockDirectory, ownerPath))) continue;
			} else if (lockAge >= LOCK_STALE_MS && (await removeAbandonedLock(lockDirectory, ownerPath))) {
				continue;
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				if (lockAge >= LOCK_STALE_MS && (await removeAbandonedLock(lockDirectory, ownerPath))) continue;
			} else if (errorCode(error) === "ENOENT") {
				if (lockAge >= LOCK_STALE_MS && (await removeAbandonedEmptyLock(lockDirectory))) continue;
			} else {
				throw error;
			}
		}
		if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
			throw new Error(`Timed out waiting for Permission Rule lock: ${path}`);
		}
		await delay(LOCK_RETRY_MS);
	}
}

function serializeMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
	const previous = mutationQueues.get(path) ?? Promise.resolve();
	const mutation = previous
		.catch(() => undefined)
		.then(async () => {
			const release = await acquireMutationLock(path);
			try {
				return await mutate();
			} finally {
				await release();
			}
		});
	const settled = mutation.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(path, settled);
	void settled.then(() => {
		if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
	});
	return mutation;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
	await ensurePrivateParent(path);
	const temporary = `${path}.tmp-${process.pid}-${++temporaryIdentity}`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function createPermissionRuleStore(paths: PermissionRuleStorePaths): PermissionRuleStore {
	return {
		loadCommandPolicy: async () => {
			const contents = await loadText(paths.commandRules);
			return contents === undefined
				? Object.freeze({ rules: Object.freeze([]), hostExecutables: Object.freeze([]) })
				: parseCommandPolicy(contents, paths.commandRules);
		},
		appendCommandRule: async (rule) => {
			const line = serializeCommandRule(rule);
			await serializeMutation(paths.commandRules, async () => {
				const current = (await loadText(paths.commandRules)) ?? "";
				if (current.split(/\r?\n/u).includes(line)) return;
				const handle = await open(paths.commandRules, "a", 0o600);
				try {
					await handle.writeFile(`${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await chmod(paths.commandRules, 0o600);
			});
		},
		loadNetworkRules: async () => {
			const contents = await loadText(paths.networkRules);
			if (contents === undefined) return Object.freeze([]);
			let document: unknown;
			try {
				document = JSON.parse(contents);
			} catch (error) {
				throw new Error(`Invalid Network Rule store: ${paths.networkRules}`, { cause: error });
			}
			if (!document || typeof document !== "object" || Array.isArray(document)) {
				throw new Error(`Invalid Network Rule store: ${paths.networkRules}`);
			}
			const input = document as Record<string, unknown>;
			if (
				!hasOnlyKeys(input, ["version", "rules"]) ||
				input.version !== NETWORK_RULES_VERSION ||
				!Array.isArray(input.rules)
			) {
				throw new Error(`Unsupported Network Rule store version: ${paths.networkRules}`);
			}
			return Object.freeze(
				input.rules.map((rule, index) => validateNetworkRule(rule, `${paths.networkRules}#${index}`)),
			);
		},
		appendNetworkRule: async (rule) => {
			return serializeMutation(paths.networkRules, async () => {
				const currentContents = await loadText(paths.networkRules);
				let current: NetworkRule[] = [];
				if (currentContents !== undefined) {
					const document = JSON.parse(currentContents) as Record<string, unknown>;
					if (
						!document ||
						typeof document !== "object" ||
						Array.isArray(document) ||
						!hasOnlyKeys(document, ["version", "rules"]) ||
						document.version !== NETWORK_RULES_VERSION ||
						!Array.isArray(document.rules)
					) {
						throw new Error(`Unsupported Network Rule store version: ${paths.networkRules}`);
					}
					current = document.rules.map((entry, index) =>
						validateNetworkRule(entry, `${paths.networkRules}#${index}`),
					);
				}
				const next = validateNetworkRule(rule, "append request");
				current = current.filter((entry) => entry.host !== next.host || entry.protocol !== next.protocol);
				current.push(next);
				current.sort(
					(left, right) => left.host.localeCompare(right.host) || left.protocol.localeCompare(right.protocol),
				);
				await atomicWrite(
					paths.networkRules,
					`${JSON.stringify({ version: NETWORK_RULES_VERSION, rules: current }, null, 2)}\n`,
				);
			});
		},
	};
}

export function defaultPermissionRulePaths(homeDirectory: string): PermissionRuleStorePaths {
	return Object.freeze({
		commandRules: join(homeDirectory, ".coda", "rules", "default.rules"),
		networkRules: join(homeDirectory, ".coda", "network-rules.json"),
	});
}

export function createInMemoryPermissionRuleStore(): PermissionRuleStore {
	const commandRules: CommandRule[] = [];
	const networkRules: NetworkRule[] = [];
	return {
		loadCommandPolicy: async () =>
			Object.freeze({ rules: Object.freeze([...commandRules]), hostExecutables: Object.freeze([]) }),
		appendCommandRule: async (rule) => {
			commandRules.push(rule);
		},
		loadNetworkRules: async () => Object.freeze([...networkRules]),
		appendNetworkRule: async (rule) => {
			const index = networkRules.findIndex((entry) => entry.host === rule.host && entry.protocol === rule.protocol);
			if (index >= 0) networkRules.splice(index, 1);
			networkRules.push(rule);
		},
	};
}
