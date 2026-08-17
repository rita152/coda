import { describe, expect, it } from "vitest";
import { isDangerousCommand, isKnownSafeCommand } from "../src/index.ts";

function argv(...parts: string[]): string[] {
	return parts;
}

describe("known-safe commands", () => {
	it("allows the Codex read-only safelist and conservative bash -lc sequences", () => {
		expect(isKnownSafeCommand(argv("ls"))).toBe(true);
		expect(isKnownSafeCommand(argv("git", "status"))).toBe(true);
		expect(isKnownSafeCommand(argv("git", "branch", "--show-current"))).toBe(true);
		expect(isKnownSafeCommand(argv("sed", "-n", "1,5p", "file.txt"))).toBe(true);
		expect(isKnownSafeCommand(argv("find", ".", "-name", "file.txt"))).toBe(true);
		expect(isKnownSafeCommand(argv("rg", "Cargo.toml", "-n"))).toBe(true);
		expect(isKnownSafeCommand(argv("bash", "-lc", "ls && pwd"))).toBe(true);
		expect(isKnownSafeCommand(argv("zsh", "-lc", "ls"))).toBe(true);
		expect(isKnownSafeCommand(argv("bash", "-lc", "sed -n '1,5p' file.txt"))).toBe(true);
	});

	it("rejects mutating git, unsafe find/base64/rg flags, and complex shell", () => {
		expect(isKnownSafeCommand(argv("git", "branch", "-d", "feature"))).toBe(false);
		expect(isKnownSafeCommand(argv("git", "checkout", "status"))).toBe(false);
		expect(isKnownSafeCommand(argv("git", "-C", ".", "status"))).toBe(false);
		expect(isKnownSafeCommand(argv("git", "log", "--output=/tmp/out"))).toBe(false);
		expect(isKnownSafeCommand(argv("find", ".", "-delete"))).toBe(false);
		expect(isKnownSafeCommand(argv("base64", "-o", "out.bin"))).toBe(false);
		expect(isKnownSafeCommand(argv("rg", "--pre", "pwned", "files"))).toBe(false);
		expect(isKnownSafeCommand(argv("bash", "-lc", "ls && rm -rf /"))).toBe(false);
		expect(isKnownSafeCommand(argv("bash", "-lc", "(ls)"))).toBe(false);
		expect(isKnownSafeCommand(argv("bash", "-lc", "ls > out.txt"))).toBe(false);
		expect(isKnownSafeCommand(argv("cargo", "check"))).toBe(false);
	});
});

describe("dangerous commands", () => {
	it("flags forced rm, including sudo/env wrappers and bash -lc scripts", () => {
		expect(isDangerousCommand(argv("rm", "-rf", "/"))).toBe(true);
		expect(isDangerousCommand(argv("rm", "-f", "/tmp/example"))).toBe(true);
		expect(isDangerousCommand(argv("/bin/rm", "-fr", "/tmp/example"))).toBe(true);
		expect(isDangerousCommand(argv("sudo", "rm", "-rf", "/tmp/example"))).toBe(true);
		expect(isDangerousCommand(argv("env", "TARGET=/tmp/example", "rm", "-rf", "/tmp/example"))).toBe(true);
		expect(isDangerousCommand(argv("bash", "-lc", "printf x | rm -rf /tmp/example"))).toBe(true);
		expect(isDangerousCommand(argv("bash", "-lc", "if test -d /tmp/example; then rm --force /tmp/example; fi"))).toBe(
			true,
		);
		expect(isDangerousCommand(argv("bash", "-lc", "trap 'rm -rf /tmp/example' EXIT"))).toBe(true);
		expect(isDangerousCommand(argv("rm", "-r", "/tmp/example"))).toBe(false);
		expect(isDangerousCommand(argv("bash", "-lc", "echo 'rm -rf /tmp/example'"))).toBe(false);
	});
});
