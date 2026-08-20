import { describe, expect, it } from "vitest";
import { extractDollarMentions, isTriggerCompatibleName } from "../../src/commands/mentions.ts";

describe("extractDollarMentions", () => {
	it("extracts catalog-shaped `$` tokens without deciding whether they are installed", () => {
		expect(extractDollarMentions("$inspect do the work")).toEqual([{ name: "inspect", start: 0, end: 8 }]);
		expect(extractDollarMentions("Use $review then $search")).toEqual([
			{ name: "review", start: 4, end: 11 },
			{ name: "search", start: 17, end: 24 },
		]);
		expect(extractDollarMentions("($inspect)")).toEqual([{ name: "inspect", start: 1, end: 9 }]);
		expect(extractDollarMentions("$HOME and $PATH stay literal")).toEqual([
			{ name: "HOME", start: 0, end: 5 },
			{ name: "PATH", start: 10, end: 15 },
		]);
		expect(extractDollarMentions("foo$inspect")).toEqual([{ name: "inspect", start: 3, end: 11 }]);
		expect(extractDollarMentions("$docs:search and $shared@user-abcd")).toEqual([
			{ name: "docs:search", start: 0, end: 12 },
			{ name: "shared@user-abcd", start: 17, end: 34 },
		]);
	});

	it("extracts Unicode Skill names and stops at Unicode punctuation", () => {
		expect(extractDollarMentions("请用 $数据-分析，再用（$审查）")).toEqual([
			{ name: "数据-分析", start: 3, end: 9 },
			{ name: "审查", start: 13, end: 16 },
		]);
	});

	it("rejects names that cannot live in a `$` token", () => {
		expect(isTriggerCompatibleName("inspect")).toBe(true);
		expect(isTriggerCompatibleName("docs:search")).toBe(true);
		expect(isTriggerCompatibleName("")).toBe(false);
		expect(isTriggerCompatibleName("has space")).toBe(false);
		expect(isTriggerCompatibleName("has$dollar")).toBe(false);
	});
});
