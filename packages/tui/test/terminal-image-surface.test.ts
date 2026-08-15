import { describe, expect, it } from "vitest";
import {
	createTerminalImageSurface,
	detectTerminalImageCapability,
	type ImagePlacement,
	VirtualTerminal,
} from "../src/index.ts";

describe("TerminalImageSurface", () => {
	it("enables only reliable Kitty-family terminals outside multiplexers", () => {
		expect(detectTerminalImageCapability({ TERM: "xterm-kitty" })?.protocol).toBe("kitty");
		expect(detectTerminalImageCapability({ TERM_PROGRAM: "ghostty" })?.protocol).toBe("kitty");
		expect(detectTerminalImageCapability({ TERM_PROGRAM: "WezTerm" })?.protocol).toBe("kitty");
		expect(detectTerminalImageCapability({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
		expect(detectTerminalImageCapability({ TERM: "xterm-kitty", TMUX: "/tmp/tmux" })).toBeNull();
		expect(detectTerminalImageCapability({ TERM: "xterm-kitty", ZELLIJ: "1" })).toBeNull();
		expect(detectTerminalImageCapability({ TERM: "screen-256color" })).toBeNull();
	});

	it("caches uploads, reconciles placements, and deletes only Session-owned images", async () => {
		const terminal = new VirtualTerminal({ capabilities: { synchronizedOutput: false } });
		let nextId = 40;
		const surface = createTerminalImageSurface({
			terminal,
			environment: { TERM: "xterm-kitty" },
			allocateId: () => ++nextId,
		});
		const placement: ImagePlacement = {
			stableKey: "asset:one",
			generation: "v1",
			png: new Uint8Array([1, 2, 3, 4]),
			row: 2,
			column: 3,
			width: 20,
			height: 8,
		};

		await surface.reconcile([placement]);
		const first = terminal.takeOutput();
		expect(first).toContain("a=t,f=100,t=d,i=41");
		expect(first).not.toContain("a=T");
		expect(first).toContain("AQIDBA==");
		expect(first).toContain("\x1b[3;4H");
		expect(first).toContain("a=p,i=41,p=41,c=20,r=8,q=2,z=1,C=1");

		await surface.reconcile([placement]);
		const stable = terminal.takeOutput();
		expect(stable).not.toContain("a=t");
		expect(stable).not.toContain("a=d");
		expect(stable).toContain("a=p,i=41,p=41,c=20,r=8,q=2,z=1,C=1");

		await surface.reconcile([{ ...placement, row: 4 }]);
		const moved = terminal.takeOutput();
		expect(moved).not.toContain("a=t");
		expect(moved).not.toContain("a=d");
		expect(moved).toContain("\x1b[5;4H");
		expect(moved).toContain("a=p,i=41,p=41,c=20,r=8,q=2,z=1,C=1");

		await surface.reconcile([]);
		expect(terminal.takeOutput()).toContain("a=d,d=I,i=41");

		await surface.reconcile([placement, { ...placement, stableKey: "asset:two", generation: "v2", row: 6 }]);
		terminal.clearOutput();

		await surface.dispose();
		const disposed = terminal.takeOutput();
		expect(disposed).toContain("a=d,d=I,i=42");
		expect(disposed).toContain("a=d,d=I,i=43");
		expect(disposed).not.toContain("a=d,d=A");
	});

	it("is a no-op when terminal graphics are unsupported", async () => {
		const terminal = new VirtualTerminal();
		const surface = createTerminalImageSurface({
			terminal,
			environment: { TERM_PROGRAM: "iTerm.app" },
			allocateId: () => 1,
		});
		await surface.reconcile([
			{
				stableKey: "one",
				generation: "v1",
				png: new Uint8Array([1]),
				row: 0,
				column: 0,
				width: 1,
				height: 1,
			},
		]);
		expect(terminal.readOutput()).toBe("");
	});
});
