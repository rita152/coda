import { describe, expect, it } from "vitest";
import { PatchParseError, parsePatch } from "../src/tools/patch/parser.ts";

describe("native patch parser", () => {
	it("parses ordered add, multi-hunk update, and delete operations", () => {
		const parsed = parsePatch(`*** Begin Patch
*** Add File: added.txt
+first
+second
*** Update File: src/value.ts
@@ const first = 1;
-const second = 2;
+const second = 20;
@@ const third = 3;
-const fourth = 4;
+const fourth = 40;
*** End of File
*** Delete File: obsolete.txt
*** End Patch`);

		expect(parsed.files).toEqual([
			{ operation: "add", path: "added.txt", content: "first\nsecond\n" },
			{
				operation: "update",
				path: "src/value.ts",
				chunks: [
					{
						context: "const first = 1;",
						oldLines: ["const second = 2;"],
						newLines: ["const second = 20;"],
						endOfFile: false,
					},
					{
						context: "const third = 3;",
						oldLines: ["const fourth = 4;"],
						newLines: ["const fourth = 40;"],
						endOfFile: true,
					},
				],
			},
			{ operation: "delete", path: "obsolete.txt" },
		]);
	});

	it.each([
		["absolute POSIX path", "/tmp/escape.txt"],
		["absolute Windows path", "C:\\escape.txt"],
		["parent traversal", "../escape.txt"],
		["embedded traversal", "src/../escape.txt"],
	])("rejects %s during parsing", (_label, path) => {
		expect(() =>
			parsePatch(`*** Begin Patch
*** Add File: ${path}
+blocked
*** End Patch`),
		).toThrow(PatchParseError);
	});

	it("rejects conflicting operations for the same lexical path", () => {
		expect(() =>
			parsePatch(`*** Begin Patch
*** Add File: conflict.txt
+created
*** Delete File: conflict.txt
*** End Patch`),
		).toThrow(/Conflicting duplicate file operation/u);
	});

	it("rejects fuzzy or marker-free update syntax", () => {
		expect(() =>
			parsePatch(`*** Begin Patch
*** Update File: value.txt
replacement without a prefix
*** End Patch`),
		).toThrow(/must start with/u);
	});
});
