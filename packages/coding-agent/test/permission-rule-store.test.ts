import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionRuleStore, defaultPermissionRulePaths } from "../src/permissions/rule-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Permission Rule storage", () => {
	it("appends Codex-compatible prefix_rule syntax and preserves alternative tokens", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		const store = createPermissionRuleStore(paths);

		await store.appendCommandRule({
			pattern: ["git", ["push", "fetch"]],
			decision: "prompt",
			justification: "Review remote Git access",
		});

		await expect(store.loadCommandPolicy()).resolves.toEqual({
			rules: [
				{
					pattern: ["git", ["push", "fetch"]],
					decision: "prompt",
					justification: "Review remote Git access",
				},
			],
			hostExecutables: [],
		});
		expect(await readFile(paths.commandRules, "utf8")).toBe(
			'prefix_rule(pattern=["git",["push","fetch"]], decision="prompt", justification="Review remote Git access")\n',
		);
		expect((await stat(paths.commandRules)).mode & 0o777).toBe(0o600);
	});

	it("inserts a missing newline and deduplicates concurrent exact Command Rule amendments", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-concurrent-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda", "rules"), { recursive: true });
		await writeFile(paths.commandRules, 'prefix_rule(pattern=["ls"], decision="allow")', { mode: 0o600 });
		const first = createPermissionRuleStore(paths);
		const second = createPermissionRuleStore(paths);
		const rule = { pattern: ["git", "status"], decision: "allow" as const };

		await Promise.all([first.appendCommandRule(rule), second.appendCommandRule(rule)]);

		expect(await readFile(paths.commandRules, "utf8")).toBe(
			[
				'prefix_rule(pattern=["ls"], decision="allow")',
				'prefix_rule(pattern=["git","status"], decision="allow")',
				"",
			].join("\n"),
		);
	});

	it("loads multiline Starlark-like rules, defaults to allow, and validates examples", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-multiline-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda", "rules"), { recursive: true });
		await writeFile(
			paths.commandRules,
			`# reviewed command policy
host_executable(
    paths = ["/usr/bin/git", "/opt/homebrew/bin/git"],
    name = "git",
)

prefix_rule(
    match = ["git status", ["git", "log"]],
    pattern = ['git', ['status', 'log']],
    not_match = ["git push"],
    justification = "Read-only Git inspection",
)
`,
			{ mode: 0o600 },
		);
		const store = createPermissionRuleStore(paths);

		await expect(store.loadCommandPolicy()).resolves.toEqual({
			rules: [
				{
					pattern: ["git", ["status", "log"]],
					decision: "allow",
					justification: "Read-only Git inspection",
				},
			],
			hostExecutables: [{ name: "git", paths: ["/usr/bin/git", "/opt/homebrew/bin/git"] }],
		});
	});

	it("fails closed when a rule example contradicts the loaded policy", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-example-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda", "rules"), { recursive: true });
		await writeFile(
			paths.commandRules,
			'prefix_rule(pattern=["git", "status"], match=["git push"], decision="allow")\n',
			{ mode: 0o600 },
		);

		await expect(createPermissionRuleStore(paths).loadCommandPolicy()).rejects.toThrow(/example did not match/iu);
	});

	it("validates examples against their declaring rule rather than a neighboring rule", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-scoped-example-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda", "rules"), { recursive: true });
		await writeFile(
			paths.commandRules,
			[
				'prefix_rule(pattern=["git"], decision="allow")',
				'prefix_rule(pattern=["npm"], match=["git status"], decision="allow")',
				"",
			].join("\n"),
			{ mode: 0o600 },
		);

		await expect(createPermissionRuleStore(paths).loadCommandPolicy()).rejects.toThrow(/example did not match/iu);
	});

	it("atomically upserts versioned exact-host Network Rules", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-network-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		const store = createPermissionRuleStore(paths);

		await Promise.all([
			store.appendNetworkRule({ host: "EXAMPLE.com.", protocol: "https", action: "allow" }),
			store.appendNetworkRule({ host: "api.example.com", protocol: "https", action: "deny" }),
		]);
		await store.appendNetworkRule({ host: "example.com", protocol: "https", action: "deny" });

		await expect(store.loadNetworkRules()).resolves.toEqual([
			{ host: "api.example.com", protocol: "https", action: "deny" },
			{ host: "example.com", protocol: "https", action: "deny" },
		]);
		expect(JSON.parse(await readFile(paths.networkRules, "utf8"))).toMatchObject({ version: 1 });
		expect((await stat(paths.networkRules)).mode & 0o777).toBe(0o600);
	});

	it("does not lose concurrent Network Rule amendments from separate store instances", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-concurrent-network-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		const first = createPermissionRuleStore(paths);
		const second = createPermissionRuleStore(paths);

		await Promise.all([
			first.appendNetworkRule({ host: "one.example.com", protocol: "https", action: "allow" }),
			second.appendNetworkRule({ host: "two.example.com", protocol: "https", action: "deny" }),
		]);

		await expect(first.loadNetworkRules()).resolves.toEqual([
			{ host: "one.example.com", protocol: "https", action: "allow" },
			{ host: "two.example.com", protocol: "https", action: "deny" },
		]);
	});

	it("normalizes bracketed IP hosts and rejects wildcard or URL rules", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-network-host-rules-"));
		temporaryDirectories.push(home);
		const store = createPermissionRuleStore(defaultPermissionRulePaths(home));

		await store.appendNetworkRule({ host: "[2001:DB8::1]:443", protocol: "https", action: "allow" });
		await expect(store.loadNetworkRules()).resolves.toEqual([
			{ host: "2001:db8::1", protocol: "https", action: "allow" },
		]);
		await expect(
			store.appendNetworkRule({ host: "*.example.com", protocol: "https", action: "allow" }),
		).rejects.toThrow(/Invalid Network Rule host/);
		await expect(
			store.appendNetworkRule({ host: "https://example.com", protocol: "https", action: "allow" }),
		).rejects.toThrow(/Invalid Network Rule host/);
		await expect(
			store.appendNetworkRule({ host: "[2001:db8::1]:notaport", protocol: "https", action: "allow" }),
		).rejects.toThrow(/Invalid Network Rule host/);
	});

	it("only strips a numeric port from an unbracketed Network Rule host", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-network-port-rules-"));
		temporaryDirectories.push(home);
		const store = createPermissionRuleStore(defaultPermissionRulePaths(home));

		await store.appendNetworkRule({ host: "EXAMPLE.com:notaport", protocol: "https", action: "allow" });

		await expect(store.loadNetworkRules()).resolves.toEqual([
			{ host: "example.com:notaport", protocol: "https", action: "allow" },
		]);
	});

	it("trims surrounding host whitespace before exact Network Rule normalization", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-network-whitespace-rule-"));
		temporaryDirectories.push(home);
		const store = createPermissionRuleStore(defaultPermissionRulePaths(home));

		await store.appendNetworkRule({ host: "  EXAMPLE.com.:443  ", protocol: "https", action: "allow" });

		await expect(store.loadNetworkRules()).resolves.toEqual([
			{ host: "example.com", protocol: "https", action: "allow" },
		]);
	});

	it("fails closed on malformed rule files", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-invalid-rules-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		const store = createPermissionRuleStore(paths);
		await store.appendCommandRule({ pattern: ["true"], decision: "allow" });
		await writeFile(paths.commandRules, "this is executable-looking junk\n", { mode: 0o600 });

		await expect(store.loadCommandPolicy()).rejects.toThrow(/Invalid Command Rule/);
	});

	it.each([
		{ version: 1, rules: [], ignored: true },
		{
			version: 1,
			rules: [{ host: "example.com", protocol: "https", action: "allow", ignored: true }],
		},
	])("fails closed on unknown fields in the versioned Network Rule store", async (document) => {
		const home = await mkdtemp(join(tmpdir(), "coda-unknown-network-rule-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda"), { recursive: true });
		await writeFile(paths.networkRules, JSON.stringify(document), { mode: 0o600 });

		await expect(createPermissionRuleStore(paths).loadNetworkRules()).rejects.toThrow(/Network Rule/u);
	});

	it("rejects unknown Command and Network Rule fields before persistence", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-append-unknown-network-rule-"));
		temporaryDirectories.push(home);
		const store = createPermissionRuleStore(defaultPermissionRulePaths(home));

		await expect(
			store.appendCommandRule({ pattern: ["git"], decision: "allow", ignored: true } as never),
		).rejects.toThrow(/Command Rule/u);
		await expect(
			store.appendNetworkRule({
				host: "example.com",
				protocol: "https",
				action: "allow",
				ignored: true,
			} as never),
		).rejects.toThrow(/Network Rule/u);
	});

	it("rejects a whitespace-only rule justification", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-empty-justification-"));
		temporaryDirectories.push(home);
		const paths = defaultPermissionRulePaths(home);
		await mkdir(join(home, ".coda", "rules"), { recursive: true });
		await writeFile(paths.commandRules, 'prefix_rule(pattern=["git"], decision="prompt", justification="   ")\n', {
			mode: 0o600,
		});

		await expect(createPermissionRuleStore(paths).loadCommandPolicy()).rejects.toThrow(
			/justification cannot be empty/,
		);
	});

	it("rejects whitespace-only justifications before appending either persistent rule type", async () => {
		const home = await mkdtemp(join(tmpdir(), "coda-append-empty-justification-"));
		temporaryDirectories.push(home);
		const store = createPermissionRuleStore(defaultPermissionRulePaths(home));

		await expect(
			store.appendCommandRule({ pattern: ["git"], decision: "prompt", justification: "   " }),
		).rejects.toThrow(/Invalid Command Rule justification/);
		await expect(
			store.appendNetworkRule({ host: "example.com", protocol: "https", action: "allow", justification: "   " }),
		).rejects.toThrow(/Invalid Network Rule justification/);
	});
});
