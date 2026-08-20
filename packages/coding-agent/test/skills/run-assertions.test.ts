import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@coda/agent";
import { createRunCapabilityHost, type RunToolContribution } from "@coda/runtime";
import { createSkills, type SkillsSnapshot } from "@coda/skills";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareUserPrompt } from "../../src/app/prepare-user-prompt.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import type { CodingPluginsSnapshot } from "../../src/plugins/types.ts";
import type { ProjectRunCapabilityBundle } from "../../src/runtime/project-capability-bundle.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { createSkillsCapabilitySource } from "../../src/skills/run-capability.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot } from "../../src/skills/types.ts";

const temporaryDirectories: string[] = [];

const model = Object.freeze({
	id: "model",
	name: "Model",
	api: "test",
	provider: "provider",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text" as const],
	contextWindow: 128_000,
	maxTokens: 16_000,
});

const emptyPlugins: CodingPluginsSnapshot = Object.freeze({
	installations: Object.freeze([]),
	plugins: Object.freeze([]),
	snapshots: Object.freeze([]),
	skills: Object.freeze([]),
	mcpSources: Object.freeze([]),
	diagnostics: Object.freeze([]),
});

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "coda-skill-run-assertion-"));
	temporaryDirectories.push(path);
	return path;
}

async function writeSkill(path: string, description: string, body: string): Promise<void> {
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "SKILL.md"), `---\nname: review\ndescription: ${description}\n---\n\n${body}\n`);
}

async function pluginSkillsSnapshot(
	root: string,
	origin: CodingSkillOrigin,
): Promise<SkillsSnapshot<CodingSkillOrigin>> {
	return createSkills<CodingSkillOrigin>({ fileSystem: createNodeFileSystem() }).snapshot({
		roots: [{ path: join(root, "skills", "review"), origin }],
		profile: "strict",
	});
}

function bundle(revision: string, skills: CodingSkillsSnapshot): ProjectRunCapabilityBundle {
	return Object.freeze({
		revision,
		plugins: emptyPlugins,
		skills,
		mcp: Object.freeze({
			revision: 0,
			servers: Object.freeze([]),
			tools: Object.freeze([]),
			agentPluginServerIds: Object.freeze([]),
			callTool: async () => {
				throw new Error("not used");
			},
			dispose: async () => undefined,
		}),
		dispose: async () => undefined,
	});
}

async function preparedSelection(snapshot: CodingSkillsSnapshot, projectRevision: string) {
	const skill = snapshot.resolved[0]!;
	return prepareUserPrompt({
		text: "$review inspect this",
		composerText: "$review inspect this",
		references: [
			{
				id: "reference:review",
				commandId: String(skill.candidate.id),
				source: "skill",
				name: "review",
				start: 0,
				end: "$review".length,
			},
		],
		attachmentIds: [],
		mediaLibrary: undefined as never,
		skills: snapshot,
		projectRevision,
	});
}

async function acquire(
	current: () => ProjectRunCapabilityBundle,
	capabilitySelections: NonNullable<Awaited<ReturnType<typeof preparedSelection>>["capabilitySelections"]>,
) {
	const host = createRunCapabilityHost({
		model: {
			acquire: () => ({
				model,
				revision: "model:1",
				stream: () => {
					throw new Error("not used");
				},
				complete: async () => {
					throw new Error("not used");
				},
				dispose: () => undefined,
			}),
		},
		contributors: [createSkillsCapabilitySource({ acquireProjectBundle: async () => current() })],
		now: () => 0,
		platform: "linux",
		interactionMode: "evaluation",
	});
	return host.acquire({
		selection: { model, reasoning: "off", authSnapshot: { auth: {} } },
		placement: { placementId: "main", root: "/workspace", baseIdentity: "base", kind: "memory" },
		mode: "write",
		baseTools: Object.freeze([]),
		bindTools: (tools: readonly RunToolContribution[]): readonly AgentTool[] => tools.map(({ tool }) => tool),
		capabilitySelections,
		signal: new AbortController().signal,
	});
}

describe("explicit Skill Run assertions", () => {
	it("re-resolves explicit Skill context from the coherent Project published after dependency preparation", async () => {
		const base = await temporaryDirectory();
		const directRoot = join(base, "direct");
		const skillDirectory = join(directRoot, "review");
		await writeSkill(skillDirectory, "first revision", "First instructions.");
		const fileSystem = createNodeFileSystem();
		const manager = new CodingSkillsManager({
			fileSystem,
			roots: [
				{
					path: directRoot,
					origin: {
						scope: "workspace",
						root: directRoot,
						priority: 0,
						sourceLabel: "./.agents/skills",
						kind: "direct",
					},
				},
			],
		});
		const first = await manager.refresh();
		await writeSkill(skillDirectory, "second revision", "Second instructions.");
		manager.markDirty();
		const second = await manager.refresh({ rescan: false });
		const prepareSkillMcpDependencies = vi.fn(async () => ({
			skills: second,
			projectRevision: "project:after-install",
			mcpTools: [],
		}));

		const prepared = await prepareUserPrompt({
			text: "$review inspect this",
			composerText: "$review inspect this",
			references: [
				{
					id: "reference:review",
					commandId: String(first.resolved[0]!.candidate.id),
					source: "skill",
					name: "review",
					start: 0,
					end: "$review".length,
				},
			],
			attachmentIds: [],
			mediaLibrary: undefined as never,
			skills: first,
			projectRevision: "project:before-install",
			prepareSkillMcpDependencies,
		});

		expect(prepareSkillMcpDependencies).toHaveBeenCalledWith(
			expect.objectContaining({ selectedSkills: [first.resolved[0]] }),
		);
		expect(JSON.stringify(prepared.input)).toContain("Second instructions.");
		expect(JSON.stringify(prepared.input)).not.toContain("First instructions.");
		expect(prepared.capabilitySelections?.skills).toEqual({
			assertions: [
				{
					skillId: String(second.resolved[0]!.candidate.id),
					candidateRevision: String(second.resolved[0]!.candidate.revision),
					projectRevision: "project:after-install",
				},
			],
		});
	});

	it("does not coordinate MCP dependencies without an explicit Skill selection", async () => {
		const base = await temporaryDirectory();
		const directRoot = join(base, "direct");
		await writeSkill(join(directRoot, "review"), "review workflow", "Review instructions.");
		const manager = new CodingSkillsManager({
			fileSystem: createNodeFileSystem(),
			roots: [
				{
					path: directRoot,
					origin: {
						scope: "workspace",
						root: directRoot,
						priority: 0,
						sourceLabel: "./.agents/skills",
						kind: "direct",
					},
				},
			],
		});
		const snapshot = await manager.refresh();
		const prepareSkillMcpDependencies = vi.fn();

		await prepareUserPrompt({
			text: "inspect this",
			attachmentIds: [],
			mediaLibrary: undefined as never,
			skills: snapshot,
			prepareSkillMcpDependencies,
		});

		expect(prepareSkillMcpDependencies).not.toHaveBeenCalled();
	});

	it.each(["direct", "plugin"] as const)(
		"fails closed when a %s Skill Project revision changes after context activation",
		async (kind) => {
			const base = await temporaryDirectory();
			const directRoot = join(base, "direct");
			const pluginRoot = join(base, "plugin");
			const skillDirectory = kind === "direct" ? join(directRoot, "review") : join(pluginRoot, "skills", "review");
			await writeSkill(skillDirectory, "first revision", "First instructions.");
			const fileSystem = createNodeFileSystem();
			const directOrigin: CodingSkillOrigin = Object.freeze({
				scope: "workspace",
				root: directRoot,
				priority: 0,
				sourceLabel: "./.agents/skills",
				kind: "direct",
			});
			const pluginOrigin: CodingSkillOrigin = Object.freeze({
				scope: "workspace",
				root: pluginRoot,
				pluginRoot,
				priority: 1,
				sourceLabel: "review-tools@team-market",
				kind: "plugin",
				pluginName: "review-tools",
			});
			let supplemental = kind === "plugin" ? await pluginSkillsSnapshot(pluginRoot, pluginOrigin) : undefined;
			const manager = new CodingSkillsManager({
				fileSystem,
				roots: kind === "direct" ? [{ path: directRoot, origin: directOrigin }] : [],
				...(kind === "plugin" ? { supplementalSnapshots: () => [supplemental!] } : {}),
			});
			const first = await manager.refresh();
			const prepared = await preparedSelection(first, "project:before-upgrade");
			const matching = await acquire(() => bundle("project:before-upgrade", first), prepared.capabilitySelections!);
			await matching.dispose();

			await writeSkill(skillDirectory, "second revision", "Second instructions.");
			if (kind === "plugin") supplemental = await pluginSkillsSnapshot(pluginRoot, pluginOrigin);
			manager.markDirty();
			const second = await manager.refresh({ rescan: false });
			const current = bundle("project:after-upgrade", second);

			expect(prepared.capabilitySelections?.skills).toEqual({
				assertions: [
					{
						skillId: String(first.resolved[0]!.candidate.id),
						candidateRevision: String(first.resolved[0]!.candidate.revision),
						projectRevision: "project:before-upgrade",
					},
				],
			});
			expect(Object.isFrozen(prepared.capabilitySelections?.skills)).toBe(true);
			await expect(acquire(() => current, prepared.capabilitySelections!)).rejects.toThrow(
				/Selected Skill Project revision is no longer available/u,
			);
		},
	);
});
