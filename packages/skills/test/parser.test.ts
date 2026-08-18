import { describe, expect, it } from "vitest";
import { parseAgentSkill, validateAgentSkill } from "../src/index.ts";

describe("Agent Skills parsing", () => {
	it("separates interoperable loading from strict conformance", () => {
		const text = "---\ndescription: Reviews code: carefully\n---\nUse the review checklist.\n";
		const parsed = parseAgentSkill({ text, directoryName: "review", path: "/skills/review/SKILL.md" });

		expect(parsed.skill).toMatchObject({
			metadata: { name: "review", description: "Reviews code: carefully" },
			body: "Use the review checklist.\n",
			conformant: false,
		});
		expect(parsed.diagnostics.map((entry) => entry.code)).toEqual([
			"frontmatter-repaired-unquoted-colon",
			"missing-name",
		]);

		const strict = validateAgentSkill({ text, directoryName: "review", path: "/skills/review/SKILL.md" });
		expect(strict.valid).toBe(false);
		expect(strict.diagnostics.map((entry) => entry.code)).toContain("frontmatter-invalid");
	});

	it("validates every standard frontmatter field", () => {
		const text = [
			"---",
			"name: review-code",
			"description: Review code when a change needs careful inspection.",
			"license: MIT",
			"compatibility: Requires git",
			"metadata:",
			"  owner: coda",
			"allowed-tools: read grep",
			"---",
			"Review the requested change.",
			"",
		].join("\n");
		const result = validateAgentSkill({ text, directoryName: "review-code" });

		expect(result.valid).toBe(true);
		expect(result.skill).toMatchObject({
			metadata: {
				name: "review-code",
				metadata: { owner: "coda" },
				allowedTools: "read grep",
			},
		});
		expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
	});

	it("reports standard name, directory, and field violations", () => {
		const result = validateAgentSkill({
			text: "---\nname: Review--Code\ndescription: ok\ncompatibility: \nmetadata:\n  count: 2\n---\nbody",
			directoryName: "review-code",
		});
		expect(result.valid).toBe(false);
		expect(result.diagnostics.map((entry) => entry.code)).toEqual(
			expect.arrayContaining(["invalid-name", "name-directory-mismatch", "invalid-field", "invalid-metadata"]),
		);
	});

	it("accepts BOM and CRLF compatibly while rejecting malformed data", () => {
		const bom = parseAgentSkill({
			text: "\uFEFF---\r\nname: review\r\ndescription: Review changes\r\n---\r\nBody\r\n",
			directoryName: "review",
		});
		expect(bom.skill?.body).toBe("Body\r\n");
		expect(bom.diagnostics).toContainEqual(expect.objectContaining({ recovered: true }));

		const duplicate = parseAgentSkill({
			text: "---\nname: one\nname: two\ndescription: bad\n---\nbody",
			directoryName: "one",
		});
		expect(duplicate.skill).toBeUndefined();
		expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({ code: "frontmatter-invalid" }));

		const alias = parseAgentSkill({
			text: "---\nname: one\ndescription: ok\nmetadata: &meta\n  owner: coda\nextra: *meta\n---\nbody",
			directoryName: "one",
		});
		expect(alias.skill).toBeUndefined();
		expect(alias.diagnostics).toContainEqual(expect.objectContaining({ code: "frontmatter-invalid" }));

		const customTag = parseAgentSkill({
			text: "---\nname: one\ndescription: !untrusted tagged\n---\nbody",
			directoryName: "one",
		});
		expect(customTag.skill).toBeUndefined();
		expect(customTag.diagnostics).toContainEqual(expect.objectContaining({ code: "frontmatter-invalid" }));
	});

	it("skips missing descriptions and enforces frontmatter bounds", () => {
		const missing = parseAgentSkill({ text: "---\nname: empty\n---\nbody", directoryName: "empty" });
		expect(missing.skill).toBeUndefined();
		expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-description" }));

		const bounded = parseAgentSkill({
			text: "---\nname: bounded\ndescription: long\n---\nbody",
			directoryName: "bounded",
			maxFrontmatterBytes: 8,
		});
		expect(bounded.skill).toBeUndefined();
		expect(bounded.diagnostics).toContainEqual(expect.objectContaining({ code: "frontmatter-too-large" }));
	});

	it.each([
		{
			name: "missing opener",
			text: "name: missing\ndescription: no fence\n",
			code: "frontmatter-missing",
		},
		{ name: "unterminated", text: "---\nname: open\ndescription: no close\n", code: "frontmatter-unterminated" },
		{ name: "empty", text: "---\n---\nbody", code: "frontmatter-not-mapping" },
		{ name: "NUL", text: "---\nname: nul\ndescription: bad\0value\n---\n", code: "nul-byte" },
	])("rejects $name frontmatter", ({ text, code }) => {
		const result = parseAgentSkill({ text, directoryName: "test" });
		expect(result.skill).toBeUndefined();
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
	});

	it("enforces YAML nesting without relying on parser recursion failure", () => {
		const result = parseAgentSkill({
			text: "---\nname: deep\ndescription: Deep\nmetadata:\n  one:\n    two: value\n---\nbody",
			directoryName: "deep",
			maxYamlDepth: 2,
		});
		expect(result.skill).toBeUndefined();
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "yaml-depth-exceeded" }));
	});

	it("retains invocation-policy booleans while still reporting them as unknown fields", () => {
		const result = parseAgentSkill({
			text: [
				"---",
				"name: standard-only",
				"description: A portable Agent Skill",
				"disable-model-invocation: true",
				"model: vendor-model",
				"---",
				"body",
			].join("\n"),
			directoryName: "standard-only",
		});
		const strict = validateAgentSkill({
			text: [
				"---",
				"name: standard-only",
				"description: A portable Agent Skill",
				"disable-model-invocation: true",
				"model: vendor-model",
				"---",
				"body",
			].join("\n"),
			directoryName: "standard-only",
		});

		expect(result.skill?.metadata).toEqual({
			name: "standard-only",
			description: "A portable Agent Skill",
			metadata: {},
			disableModelInvocation: true,
		});
		expect(result.diagnostics.filter(({ code }) => code === "unknown-field")).toHaveLength(2);
		expect(strict.valid).toBe(false);
		expect(strict.diagnostics.filter(({ code }) => code === "unknown-field")).toHaveLength(2);
	});

	it("applies standard text limits to Unicode characters rather than UTF-16 code units", () => {
		const valid = validateAgentSkill({
			text: `---\nname: unicode\ndescription: ${"😀".repeat(1_024)}\ncompatibility: ${"😀".repeat(500)}\n---\nbody`,
			directoryName: "unicode",
		});
		const invalid = validateAgentSkill({
			text: `---\nname: unicode\ndescription: ${"😀".repeat(1_025)}\ncompatibility: ${"😀".repeat(501)}\n---\nbody`,
			directoryName: "unicode",
		});

		expect(valid.valid).toBe(true);
		expect(invalid.diagnostics.map(({ code }) => code)).toEqual(
			expect.arrayContaining(["description-too-long", "compatibility-too-long"]),
		);
	});

	it("accepts Unicode lowercase names using the reference validator's normalized comparison", () => {
		const valid = validateAgentSkill({
			text: "---\nname: 数据-分析2\ndescription: 分析数据\n---\nbody",
			directoryName: "数据-分析2",
		});
		const invalid = validateAgentSkill({
			text: "---\nname: Überprüfung\ndescription: Review data\n---\nbody",
			directoryName: "Überprüfung",
		});

		expect(valid.valid).toBe(true);
		expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-name" }));
	});

	it("rejects invalid parser limit arguments", () => {
		expect(() =>
			parseAgentSkill({ text: "---\nname: one\ndescription: one\n---\n", directoryName: "one", maxYamlDepth: 0 }),
		).toThrow("maxYamlDepth");
		expect(() =>
			parseAgentSkill({
				text: "---\nname: one\ndescription: one\n---\n",
				directoryName: "one",
				maxFrontmatterBytes: Number.POSITIVE_INFINITY,
			}),
		).toThrow("maxFrontmatterBytes");
	});
});
