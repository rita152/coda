import { describe, expect, it } from "vitest";
import { terminalEnvironmentForStartup } from "../src/node-application.ts";

describe("Node Coding Agent Terminal startup", () => {
	it("applies NO_COLOR to one Terminal environment without mutating the process environment snapshot", () => {
		const environment = { TERM: "xterm-256color" } as const;

		const terminalEnvironment = terminalEnvironmentForStartup(environment, true);

		expect(terminalEnvironment).toEqual({ TERM: "xterm-256color", NO_COLOR: "1" });
		expect(terminalEnvironment).not.toBe(environment);
		expect(environment).toEqual({ TERM: "xterm-256color" });
		expect(terminalEnvironmentForStartup(environment, false)).toBe(environment);
	});
});
