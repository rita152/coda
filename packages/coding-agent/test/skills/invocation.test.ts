import type { SkillCandidate, SkillFileSystem, SkillId, SkillRevision } from "@coda/skills";
import { describe, expect, it, vi } from "vitest";
import {
	allowsImplicitInvocation,
	parseAllowImplicitInvocation,
	parseSkillSidecarMetadata,
	readSkillSidecarMetadata,
} from "../../src/skills/invocation.ts";
import type { CodingSkillOrigin } from "../../src/skills/types.ts";

function sidecarCandidate(index: number): SkillCandidate<CodingSkillOrigin> {
	const name = `skill-${index}`;
	return {
		id: `skill:${String(index).padStart(32, "0")}` as SkillId,
		revision: `revision:${index}` as SkillRevision,
		directory: `/skills/${name}`,
		skillFile: `/skills/${name}/SKILL.md`,
		metadata: { name, description: `${name} description`, metadata: {} },
		conformant: true,
		provenance: [],
		diagnostics: [],
	};
}

describe("Skill implicit invocation policy", () => {
	it("defaults to allowing implicit invocation", () => {
		expect(allowsImplicitInvocation({})).toBe(true);
		expect(allowsImplicitInvocation({ sidecarAllowImplicit: true })).toBe(true);
	});

	it("hides Skills that disable model invocation or Codex implicit policy", () => {
		expect(allowsImplicitInvocation({ disableModelInvocation: true })).toBe(false);
		expect(allowsImplicitInvocation({ sidecarAllowImplicit: false })).toBe(false);
		expect(allowsImplicitInvocation({ disableModelInvocation: true, sidecarAllowImplicit: true })).toBe(false);
	});

	it("reads Codex allow_implicit_invocation from agents/openai.yaml text", () => {
		expect(
			parseAllowImplicitInvocation(
				"interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: false\n",
			),
		).toBe(false);
		expect(parseAllowImplicitInvocation("policy:\n  allow_implicit_invocation: true\n")).toBe(true);
		expect(parseAllowImplicitInvocation("interface:\n  display_name: Demo\n")).toBeUndefined();
	});

	it("only recognizes allow_implicit_invocation under the policy mapping", () => {
		expect(parseAllowImplicitInvocation("interface:\n  allow_implicit_invocation: false\n")).toBeUndefined();
		expect(parseAllowImplicitInvocation("allow_implicit_invocation: false\n")).toBeUndefined();
	});

	it("resolves and normalizes official Codex interface metadata", () => {
		expect(
			parseSkillSidecarMetadata(
				[
					"interface:",
					'  display_name: "  Review   helper  "',
					"  short_description: >-",
					"    Review   a selected",
					"    change",
					"  icon_small: ./assets/icon.svg",
					"  icon_large: ../../assets/icon-large.png",
					'  brand_color: " #12aBcD "',
					"  default_prompt: |",
					"    Review   the",
					"    selected change",
					"policy:",
					"  allow_implicit_invocation: false",
				].join("\n"),
				{
					skillDirectory: "/plugins/demo/skills/review",
					pluginRoot: "/plugins/demo",
				},
			),
		).toEqual({
			interface: {
				displayName: "Review helper",
				shortDescription: "Review a selected change",
				iconSmall: "/plugins/demo/skills/review/assets/icon.svg",
				iconLarge: "/plugins/demo/assets/icon-large.png",
				brandColor: "#12aBcD",
				defaultPrompt: "Review the selected change",
			},
			policy: { allowImplicitInvocation: false, products: [] },
		});
	});

	it("drops invalid interface fields independently after successful YAML deserialization", () => {
		expect(
			parseSkillSidecarMetadata(
				[
					"interface:",
					`  display_name: ${"x".repeat(65)}`,
					'  short_description: "   "',
					"  icon_small: ../outside.svg",
					"  icon_large: icon.png",
					"  brand_color: blue",
					`  default_prompt: ${"x".repeat(1_025)}`,
					"policy:",
					"  allow_implicit_invocation: true",
				].join("\n"),
				{ skillDirectory: "/skills/review" },
			),
		).toEqual({ policy: { allowImplicitInvocation: true, products: [] } });
	});

	it("keeps the 1024-character default prompt boundary and ignores blank prompts", () => {
		const boundaryPrompt = "x".repeat(1_024);
		expect(
			parseSkillSidecarMetadata(`interface:\n  default_prompt: "  ${boundaryPrompt}  "\n`, {
				skillDirectory: "/skills/review",
			}),
		).toEqual({ interface: { defaultPrompt: boundaryPrompt } });
		expect(
			parseSkillSidecarMetadata('interface:\n  default_prompt: "   "\n', {
				skillDirectory: "/skills/review",
			}),
		).toEqual({});
	});

	it("fails optional metadata open when a recognized YAML field has the wrong type", () => {
		expect(
			parseSkillSidecarMetadata("interface:\n  display_name: 42\npolicy:\n  allow_implicit_invocation: false\n", {
				skillDirectory: "/skills/review",
			}),
		).toEqual({});
		expect(
			parseSkillSidecarMetadata(
				'interface:\n  display_name: Review\npolicy:\n  allow_implicit_invocation: "false"\n',
				{ skillDirectory: "/skills/review" },
			),
		).toEqual({});
	});

	it("parses and freezes official tool dependencies and product policy", () => {
		const metadata = parseSkillSidecarMetadata(
			[
				"dependencies:",
				"  tools:",
				"    - type: '  mcp  '",
				"      value: '  openai   docs  '",
				"      description: '  Search   official docs  '",
				"      transport: '  streamable-http  '",
				"      command: '  run   docs  '",
				"      url: '  https://developers.openai.com/mcp  '",
				"policy:",
				"  allow_implicit_invocation: false",
				"  products: [codex, CHATGPT, atlas]",
			].join("\n"),
			{ skillDirectory: "/skills/review" },
		);

		expect(metadata).toMatchObject({
			policy: {
				allowImplicitInvocation: false,
				products: ["codex", "chatgpt", "atlas"],
			},
			dependencies: {
				tools: [
					{
						type: "mcp",
						value: "openai docs",
						description: "Search official docs",
						transport: "streamable-http",
						command: "run docs",
						url: "https://developers.openai.com/mcp",
					},
				],
			},
		});
		expect(Object.isFrozen(metadata)).toBe(true);
		expect(Object.isFrozen(metadata.policy)).toBe(true);
		expect(Object.isFrozen(metadata.policy?.products)).toBe(true);
		expect(Object.isFrozen(metadata.dependencies)).toBe(true);
		expect(Object.isFrozen(metadata.dependencies?.tools)).toBe(true);
		expect(Object.isFrozen(metadata.dependencies?.tools[0])).toBe(true);
	});

	it("isolates invalid dependency tools and optional fields", () => {
		const metadata = parseSkillSidecarMetadata(
			[
				"dependencies:",
				"  tools:",
				"    - type: mcp",
				"    - type: ''",
				"      value: missing-type",
				"    - type: mcp",
				"      value: docs-search",
				"      description: ''",
				`      transport: ${"t".repeat(65)}`,
				`      command: ${"c".repeat(1_025)}`,
				"      url: https://developers.openai.com/mcp",
				"    - type: shell",
				"      value: run-review",
				"      transport: stdio",
			].join("\n"),
			{ skillDirectory: "/skills/review" },
		);

		expect(metadata.dependencies).toEqual({
			tools: [
				{ type: "mcp", value: "docs-search", url: "https://developers.openai.com/mcp" },
				{ type: "shell", value: "run-review", transport: "stdio" },
			],
		});
	});

	it("fails the entire optional sidecar open when a dependency entry has a known field with the wrong type", () => {
		const metadata = parseSkillSidecarMetadata(
			[
				"dependencies:",
				"  tools:",
				"    - type: mcp",
				"      value: valid-server",
				"    - type: mcp",
				"      value: invalid-server",
				"      description: 42",
				"    - not-a-tool",
				"policy:",
				"  products: [codex]",
			].join("\n"),
			{ skillDirectory: "/skills/review" },
		);

		expect(metadata).toEqual({});
	});

	it("keeps unknown fields compatible while preserving typed OAuth callback aliases", () => {
		expect(
			parseSkillSidecarMetadata(
				[
					"future_top_level:",
					"  nested: 42",
					"dependencies:",
					"  future_container: [one, two]",
					"  tools:",
					"    - type: mcp",
					"      value: camel-docs",
					"      url: https://camel.example.test/mcp",
					"      future_tool_field: 42",
					"      oauth:",
					"        callbackPort: 3118",
					"        future_oauth_field: true",
					"    - type: mcp",
					"      value: snake-docs",
					"      url: https://snake.example.test/mcp",
					"      oauth:",
					"        callback_port: 4118",
				].join("\n"),
				{ skillDirectory: "/skills/review" },
			),
		).toEqual({
			dependencies: {
				tools: [
					{
						type: "mcp",
						value: "camel-docs",
						url: "https://camel.example.test/mcp",
						oauth: { callbackPort: 3118 },
					},
					{
						type: "mcp",
						value: "snake-docs",
						url: "https://snake.example.test/mcp",
						oauth: { callbackPort: 4118 },
					},
				],
			},
		});
		expect(
			parseSkillSidecarMetadata(
				"dependencies:\n  tools:\n    - type: mcp\n      value: docs\n      oauth:\n        callback_port: '3118'\npolicy:\n  allow_implicit_invocation: false\n",
				{ skillDirectory: "/skills/review" },
			),
		).toEqual({});
	});

	it("fails the entire optional sidecar open for dependency-container or product errors", () => {
		expect(
			parseSkillSidecarMetadata("dependencies:\n  tools: not-a-list\npolicy:\n  products: [codex]\n", {
				skillDirectory: "/skills/review",
			}),
		).toEqual({});
		expect(parseSkillSidecarMetadata("policy:\n  products: [Codex]\n", { skillDirectory: "/skills/review" })).toEqual(
			{},
		);
	});

	it("bounds optional sidecar bytes before and after reading and emits bounded diagnostics", async () => {
		const candidates = [sidecarCandidate(1), sidecarCandidate(2), sidecarCandidate(3)];
		const readFile = vi.fn(async (path: string) => {
			if (path.includes("skill-2")) return new Uint8Array(64 * 1024 + 1);
			throw new Error(`read failed: ${"x".repeat(4_000)}`);
		});
		const fileSystem: SkillFileSystem = {
			realpath: async (path) => path,
			lstat: async () => ({ kind: "file", size: 1 }),
			stat: async (path) => ({ kind: "file", size: path.includes("skill-1") ? 64 * 1024 + 1 : 1 }),
			readFile,
			readDirectory: async () => [],
		};

		const result = await readSkillSidecarMetadata(fileSystem, candidates);

		expect(result.metadataById.size).toBe(0);
		expect(readFile.mock.calls.some(([path]) => String(path).includes("skill-1"))).toBe(false);
		expect(result.diagnostics.map(({ code }) => code)).toEqual([
			"skill-sidecar-too-large",
			"skill-sidecar-too-large",
			"skill-sidecar-read-failed",
		]);
		expect(Math.max(...result.diagnostics.map(({ message }) => message.length))).toBeLessThanOrEqual(768);
	});

	it("reads optional sidecars with bounded parallelism while preserving every healthy result", async () => {
		const candidates = Array.from({ length: 40 }, (_, index) => sidecarCandidate(index));
		let activeReads = 0;
		let maximumActiveReads = 0;
		const fileSystem: SkillFileSystem = {
			realpath: async (path) => path,
			lstat: async () => ({ kind: "file", size: 32 }),
			stat: async () => ({ kind: "file", size: 32 }),
			readFile: async () => {
				activeReads++;
				maximumActiveReads = Math.max(maximumActiveReads, activeReads);
				await new Promise((resolve) => setTimeout(resolve, 2));
				activeReads--;
				return new TextEncoder().encode("policy:\n  allow_implicit_invocation: false\n");
			},
			readDirectory: async () => [],
		};

		const result = await readSkillSidecarMetadata(fileSystem, candidates);

		expect(result.metadataById.size).toBe(40);
		expect(result.diagnostics).toEqual([]);
		expect(maximumActiveReads).toBeGreaterThan(1);
		expect(maximumActiveReads).toBeLessThanOrEqual(16);
	});
});
