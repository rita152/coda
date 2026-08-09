import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error(`Unsupported Linux architecture: ${process.arch}`);
	}
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const source = join(packageRoot, "native", "coda-linux-sandbox-helper.c");
	const output = join(packageRoot, "native", `linux-${process.arch}`, "coda-linux-sandbox-helper");
	mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
	const compiler = process.env.CC || "cc";
	const result = spawnSync(
		compiler,
		[
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-D_FORTIFY_SOURCE=2",
			"-fstack-protector-strong",
			source,
			"-o",
			output,
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Native Sandbox helper compilation failed with exit ${result.status}`);
	chmodSync(output, 0o755);
	const helperDigest = createHash("sha256")
		.update(await import("node:fs/promises").then(({ readFile }) => readFile(output)))
		.digest("hex");
	writeFileSync(`${output}.sha256`, `${helperDigest}\n`, { mode: 0o644 });

	const trustedBubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => {
		try {
			const canonical = realpathSync(candidate);
			const file = statSync(canonical);
			const parent = statSync(dirname(canonical));
			return (
				file.isFile() &&
				file.uid === 0 &&
				(file.mode & 0o6022) === 0 &&
				parent.uid === 0 &&
				(parent.mode & 0o022) === 0
			);
		} catch {
			return false;
		}
	});
	if (!trustedBubblewrap) {
		throw new Error("A trusted system bubblewrap is required to build the checksum-verified Linux fallback");
	}
	const resourceDirectory = join(packageRoot, "resources", `linux-${process.arch}`);
	const bundledBubblewrap = join(resourceDirectory, "bwrap");
	mkdirSync(resourceDirectory, { recursive: true, mode: 0o755 });
	copyFileSync(realpathSync(trustedBubblewrap), bundledBubblewrap);
	chmodSync(bundledBubblewrap, 0o755);
	const digest = createHash("sha256")
		.update(await import("node:fs/promises").then(({ readFile }) => readFile(bundledBubblewrap)))
		.digest("hex");
	writeFileSync(`${bundledBubblewrap}.sha256`, `${digest}\n`, { mode: 0o644 });
	const versionResult = spawnSync(realpathSync(trustedBubblewrap), ["--version"], { encoding: "utf8" });
	if (versionResult.error) throw versionResult.error;
	if (versionResult.status !== 0) {
		throw new Error(`Could not identify bundled bubblewrap version (exit ${versionResult.status})`);
	}
	const versionOutput = versionResult.stdout.trim();
	const version = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(versionOutput)?.[1];
	if (!version) throw new Error(`Could not parse bubblewrap version from: ${versionOutput}`);
	writeFileSync(
		join(resourceDirectory, "provenance.json"),
		`${JSON.stringify(
			{
				component: "bubblewrap",
				version,
				sha256: digest,
				license: "GNU Library General Public License v2.0",
				source: `https://github.com/containers/bubblewrap/releases/tag/v${version}`,
				buildInput: realpathSync(trustedBubblewrap),
			},
			null,
			2,
		)}\n`,
		{ mode: 0o644 },
	);
}
