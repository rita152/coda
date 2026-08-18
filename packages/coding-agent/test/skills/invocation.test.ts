import { describe, expect, it } from "vitest";
import { allowsImplicitInvocation, parseAllowImplicitInvocation } from "../../src/skills/invocation.ts";

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
});
