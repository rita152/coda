import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import * as anthropicLazy from "../src/api/anthropic-messages.lazy.ts";
import * as anthropic from "../src/api/anthropic-messages.ts";
import * as completionsLazy from "../src/api/openai-completions.lazy.ts";
import * as completions from "../src/api/openai-completions.ts";
import * as responsesLazy from "../src/api/openai-responses.lazy.ts";
import * as responses from "../src/api/openai-responses.ts";
import * as root from "../src/index.ts";
import * as opencodeModels from "../src/providers/opencode-go.models.ts";
import * as opencode from "../src/providers/opencode-go.ts";

type Status = "compatible" | "deliberate-deviation" | "type-only" | "excluded";
interface ManifestEntry {
	status: Status;
	test: string;
}
interface CompatibilityManifest {
	rootRuntime: Record<string, ManifestEntry>;
	rootTypes: Record<string, ManifestEntry>;
	subpaths: readonly (ManifestEntry & { path: string; runtime: readonly string[] })[];
	exclusions: readonly (ManifestEntry & { kind: "root" | "subpath"; name: string })[];
}

const subpathModules: Record<string, Record<string, unknown>> = {
	"./api/anthropic-messages": anthropic,
	"./api/anthropic-messages.lazy": anthropicLazy,
	"./api/openai-completions": completions,
	"./api/openai-completions.lazy": completionsLazy,
	"./api/openai-responses": responses,
	"./api/openai-responses.lazy": responsesLazy,
	"./providers/opencode-go": opencode,
	"./providers/opencode-go.models": opencodeModels,
};

async function readManifest(): Promise<CompatibilityManifest> {
	return JSON.parse(
		await readFile(new URL("../compatibility/manifest.v1.json", import.meta.url), "utf8"),
	) as CompatibilityManifest;
}

function sourceExports(): { all: string[]; typeOnly: string[] } {
	const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const config = ts.readConfigFile(resolve(packageDirectory, "tsconfig.json"), ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDirectory);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const source = program.getSourceFile(resolve(packageDirectory, "src/index.ts"));
	if (!source) throw new Error("Could not load src/index.ts for export audit");
	const checker = program.getTypeChecker();
	const moduleSymbol = checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error("Could not resolve the root module symbol");
	const exports = checker.getExportsOfModule(moduleSymbol).map((symbol) => {
		const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		return {
			name: symbol.name,
			type: Boolean(target.flags & ts.SymbolFlags.Type),
			value: Boolean(target.flags & ts.SymbolFlags.Value),
		};
	});
	return {
		all: exports.map((entry) => entry.name).sort(),
		typeOnly: exports
			.filter((entry) => entry.type && !entry.value)
			.map((entry) => entry.name)
			.sort(),
	};
}

describe("versioned compatibility export manifest", () => {
	test("accounts for every root runtime and type-only export exactly", async () => {
		const manifest = await readManifest();
		const source = sourceExports();

		expect(Object.keys(root).sort()).toEqual(Object.keys(manifest.rootRuntime).sort());
		expect(source.typeOnly).toEqual(Object.keys(manifest.rootTypes).sort());
		for (const entry of [...Object.values(manifest.rootRuntime), ...Object.values(manifest.rootTypes)]) {
			expect(["compatible", "deliberate-deviation", "type-only"]).toContain(entry.status);
			expect(entry.test).toBeTruthy();
		}
	}, 15_000);

	test("imports every allowed subpath and finds no extra runtime names", async () => {
		const manifest = await readManifest();
		for (const entry of manifest.subpaths) {
			const module = entry.path === "." ? root : subpathModules[entry.path];
			expect(module, entry.path).toBeDefined();
			expect(Object.keys(module!).sort(), entry.path).toEqual([...entry.runtime].sort());
		}
	});

	test("keeps named exclusions absent from the root and package map", async () => {
		const manifest = await readManifest();
		const source = sourceExports();
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		for (const exclusion of manifest.exclusions) {
			expect(exclusion.status).toBe("excluded");
			if (exclusion.kind === "root") expect(source.all).not.toContain(exclusion.name);
			else expect(packageJson.exports).not.toHaveProperty(exclusion.name);
		}
	});
});
