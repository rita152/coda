import { describe, expect, it } from "vitest";
import { extractDollarMentions, isTriggerCompatibleName } from "../../src/commands/mentions.ts";

describe("extractDollarMentions", () => {
	it("extracts `$` tokens at Composer boundaries and skips common environment variables", () => {
		expect(extractDollarMentions("$inspect do the work")).toEqual([{ name: "inspect", start: 0, end: 8 }]);
		expect(extractDollarMentions("Use $review then $search")).toEqual([
			{ name: "review", start: 4, end: 11 },
			{ name: "search", start: 17, end: 24 },
		]);
		expect(extractDollarMentions("($inspect)")).toEqual([{ name: "inspect", start: 1, end: 9 }]);
		expect(extractDollarMentions("$HOME and $PATH stay literal")).toEqual([]);
		expect(extractDollarMentions("foo$inspect")).toEqual([]);
		expect(extractDollarMentions("$docs:search and $shared@user-abcd")).toEqual([
			{ name: "docs:search", start: 0, end: 12 },
			{ name: "shared@user-abcd", start: 17, end: 34 },
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
