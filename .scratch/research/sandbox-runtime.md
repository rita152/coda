# Anthropic Sandbox Runtime (`@anthropic-ai/sandbox-runtime`)

Researched: 2026-08-17.
Primary sources: GitHub repo `anthropic-experimental/sandbox-runtime` at commit [`5feb5269f1c86f49e62224ffb8297b2f01a31806`](https://github.com/anthropic-experimental/sandbox-runtime/commit/5feb5269f1c86f49e62224ffb8297b2f01a31806) (tag [`v0.0.73`](https://github.com/anthropic-experimental/sandbox-runtime/releases/tag/v0.0.73), 2026-08-13), plus the published npm package of the same version.

The repo has **no `docs/` tree, no CHANGELOG, and no CONTRIBUTING**. User-facing documentation is `README.md` plus inline TypeScript. Test-fixture READMEs are not API docs.

Coda comparison uses this repo’s `ProcessRunner` / `ProcessSessionRunner` types. CONTEXT.md avoids the word “sandbox”; this note uses SRT’s own terms for SRT, and Coda’s ProcessRunner / Workspace / Tool Invocation terms for the wrap question.

---

## Executive summary (for a Coda wrap)

1. **What it is:** a Node library + `srt` CLI that wraps a **command string** with OS-level filesystem and network restrictions. Not a container runtime. License Apache-2.0. Consume as npm `@anthropic-ai/sandbox-runtime@0.0.73` (Node `>=20.11.0`).
2. **Public run API:** `SandboxManager.initialize(config)` once, then `wrapWithSandbox(command)` (POSIX shell string) or `wrapWithSandboxArgv(command)` (`{argv, env}`). **The library does not spawn the workload.** The caller `spawn`s the wrapper. There is no API that takes `executable + args + env + stdin` as Coda’s `ProcessRunRequest` does.
3. **Isolation:** macOS Seatbelt (`sandbox-exec`), Linux bubblewrap + optional vendored `apply-seccomp`, Windows alpha via bundled `srt-win.exe` + a dedicated `srt-sandbox` user. Network is allow-only through host HTTP/SOCKS proxies. Writes are allow-only; reads are deny-then-allow (open by default).
4. **Not a drop-in spawn interceptor.** An injected ProcessRunner can *use* wrap-then-spawn, but SRT always inserts a shell (`bash -c` / `cmd`) around a string, relative FS paths resolve against **`process.cwd()`** (not spawn `cwd` on POSIX), and Windows does not currently forward caller stdin or caller env into the child.
5. **Seam:** session-level `initialize`/`reset` plus a wrap step. `SandboxManager` is a **process-wide singleton**; a second `initialize()` is a no-op until `reset()`. That lifecycle is not on `ProcessRunner`. Wrapping *all* ProcessRunner callers would also confine Coda-internal `find`/`grep`/`git`.
6. **Stability:** README labels it a **Beta Research Preview**; package is `0.0.73` with rapid releases. README export list and “custom proxy not yet supported” are already stale vs `src/index.ts` / `sandbox-config.ts`. Native risk: Linux needs host `bwrap`+`socat`+`rg`; Windows needs a one-time elevated install; npm tarball ships `apply-seccomp` and `srt-win.exe`.

---

## 1. What the project is, license, language, install/consume

### Identity

GitHub description: “A lightweight sandboxing tool for enforcing filesystem and network restrictions on arbitrary processes at the OS level, without requiring a container.” ([repo](https://github.com/anthropic-experimental/sandbox-runtime))

README: Anthropic Sandbox Runtime (`srt`). Uses `sandbox-exec` on macOS, bubblewrap on Linux, and (alpha) a Windows `srt-sandbox` user + WFP. Intended for agents, local MCP servers, bash commands, and arbitrary processes. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L1–L11)

**Beta Research Preview.** Developed for Claude Code; “APIs and configuration formats may evolve.” Org is [`anthropic-experimental`](https://github.com/anthropic-experimental). ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L7–L9)

Language: TypeScript (`"type": "module"`), compiled to `dist/`. Native helpers: C `apply-seccomp` (Linux) and Rust `srt-win.exe` (Windows), both vendored into the npm package. ([package.json](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/package.json); [vendor/seccomp-src](https://github.com/anthropic-experimental/sandbox-runtime/tree/5feb5269f1c86f49e62224ffb8297b2f01a31806/vendor/seccomp-src); [vendor/srt-win-src](https://github.com/anthropic-experimental/sandbox-runtime/tree/5feb5269f1c86f49e62224ffb8297b2f01a31806/vendor/srt-win-src))

### License

Apache-2.0. ([package.json](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/package.json) `license`; [LICENSE](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/LICENSE); GitHub `licenseInfo.key: apache-2.0`)

### Consume story

| Channel | Fact | Source |
|---|---|---|
| npm name | `@anthropic-ai/sandbox-runtime` | [package.json](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/package.json); [npm v0.0.73](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.73) |
| Install (CLI) | `npm install -g @anthropic-ai/sandbox-runtime` | [README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L11–L15 |
| Library | `import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'` | [README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L177–L184; [src/index.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/index.ts) |
| Entry | `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, bin `srt` → `dist/cli.js` | package.json |
| Engines | `node >= 20.11.0` | package.json |
| Git dependency | Possible (`git+https://github.com/anthropic-experimental/sandbox-runtime.git`) but **not** the documented consume path. Published artifacts live in `dist/` + `vendor/`. | package.json `repository`; `"files": ["dist", "vendor/seccomp", "vendor/srt-win", "README.md", "LICENSE"]` |
| JS deps | `@pondwader/socks5-server`, `commander`, `node-forge`, `zod` | package.json `dependencies` |
| Native binaries in npm tarball | `vendor/seccomp/{x64,arm64}/apply-seccomp` (~0.6–0.8 MB each); `vendor/srt-win/{x64,arm64}/srt-win.exe` (~2.7–3.1 MB). Tarball ~3.8 MB, unpacked ~8.5 MB, 153 files. | `npm pack --dry-run` for `@anthropic-ai/sandbox-runtime@0.0.73` |
| Host packages (Linux) | `bubblewrap`, `socat`, `ripgrep` required at runtime | [README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L467–L482; `checkLinuxDependencies` in [linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L543–L574 |
| Host packages (macOS) | README says `ripgrep` is required. **Code disagrees:** `checkDependencies` only requires `rg` on Linux; macOS comment is “no ripgrep needed”. | README L502–L506 vs [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L978–L981 and [macos-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts) L617 |
| Windows | No extra packages; one-time elevated `npx @anthropic-ai/sandbox-runtime windows-install` | [README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L512–L528 |

Related (not this package’s API): [Claude Code sandboxing docs](https://docs.claude.com/en/docs/claude-code/sandboxing), [Anthropic engineering post](https://www.anthropic.com/engineering/claude-code-sandboxing). Cited from README L132–L135.

---

## 2. Public interface: start a sandboxed command, config, returns, errors

### Two consume modes

**CLI `srt`:** wraps argv or `-c <string>`, loads `~/.srt-settings.json` (or `--settings`), `initialize`, then spawn. POSIX: `spawn(sandboxedCommand, { shell: true, stdio: 'inherit' })`. Windows: `wrapWithSandboxArgv` then `spawn(argv[0], argv.slice(1), { shell: false, stdio: 'inherit', env })`. ([cli.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/cli.ts) L133–L310)

CLI flags: `--debug` (`SRT_DEBUG`), `--settings`, `-c`, `--control-fd` (JSON-lines config updates). Subcommands: `windows-install`, `windows-uninstall`. ([cli.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/cli.ts) L49–L150)

Default CLI config if `~/.srt-settings.json` is missing: empty allow/deny lists (no network, no writes, full reads). An **explicit** `--settings` path that fails to load **refuses to run** (exit 1). ([cli.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/cli.ts) L24–L37, L169–L187)

`loadConfig` / `loadConfigFromString` live in [config-loader.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/utils/config-loader.ts) and are **not** exported from [src/index.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/index.ts). Library consumers are expected to pass a typed object (and may call exported `SandboxRuntimeConfigSchema` themselves).

**Library:** process-wide `SandboxManager` object implementing `ISandboxManager`. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L2270–L2368)

### Lifecycle

```text
initialize(runtimeConfig, sandboxAskCallback?, enableLogMonitor?)
  → wrapWithSandbox / wrapWithSandboxArgv  (per command, as many as needed)
  → caller spawn(...)
  → cleanupAfterCommand() after each Linux command
  → reset() when the session ends
```

- **`initialize`:** stores config, checks deps, starts host HTTP/SOCKS (mux) proxies, Linux socat bridges, optional macOS/Linux violation monitors, Windows ACL grant/stamp. Throws if Linux deps missing or Windows not provisioned. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L595–L941)
- **Idempotence:** if `initializationPromise` is already set, a later `initialize()` **awaits the first one and returns** — it does **not** apply a new config. Call `reset()` then `initialize()` to reconfigure. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L600–L604)
- **`initialize` does not Zod-parse** the object. Validation is CLI-only (`SandboxRuntimeConfigSchema.safeParse`) unless the embedder calls the exported schema. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L606–L607 vs [config-loader.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/utils/config-loader.ts) L19–L24)
- **`updateConfig`:** live-swaps **network allow/deny** (proxies read `config` per request). Filesystem changes are **not** live; need `reset()` + `initialize()`. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1891–L1936)
- **`reset`:** tears down proxies, Linux bridges, Windows ACEs, MITM CA. Registered on `exit`/`SIGINT`/`SIGTERM`. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L175–L188, L2064–L2198)

### Wrap APIs (the actual “start a command” surface)

`wrapWithSandbox(command, binShell?, customConfig?, abortSignal?, options?) → Promise<string>`

- Input is a **shell command string**, not argv.
- POSIX: returns a quoted string such as `env … /usr/bin/sandbox-exec -p <profile> <shell> -c <command>` (macOS) or `bwrap … -- <shell> -c <command>` (Linux). ([macos-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts) L1148–L1161; [linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L1957–L1987)
- **Throws on Windows.** ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1714–L1723)
- Default inner shell: `bash` resolved via PATH (`whichSync`). Missing shell throws. ([macos-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts) L1131–L1135; [linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L1960–L1964)
- README example then `spawn(sandboxedCommand, { shell: true, stdio: 'inherit' })`. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L199–L215)

`wrapWithSandboxArgv(command, binShell?, customConfig?, abortSignal?, cwd?, options?) → Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>`

- Documented as suitable for `spawn(argv[0], argv.slice(1), { shell: false, env })`. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1733–L1753)
- **Windows:** `argv` is `srt-win.exe [--srt-win] exec … -- <shell> <command>`; `env` is broker env. Child env is a **fresh `srt-sandbox` profile** plus `--env` overlay (PATH/PATHEXT, proxy vars, mask sentinels, git config) — not the caller’s env object. ([windows-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/windows-sandbox-utils.ts) L2020–L2129)
- **macOS/Linux:** delegates to `wrapWithSandbox`, then `{ argv: [binShell ?? '/bin/bash', '-c', wrapped], env: process.env }`. `cwd` is unused on POSIX. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1747–L1880)

`WrapWithSandboxOptions`: `commandId` (violation key; compared on first 100 characters), `commandText` (for `ignoreViolations` matching). ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1486–L1506; [README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L218–L230)

`abortSignal` on wrap: used on Linux to abort the **ripgrep mandatory-deny scan at wrap time**, not to kill a running command. ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L272–L281, L910, L1713)

`customConfig?: Partial<SandboxRuntimeConfig>`: per-command FS/network/credential overrides. Windows **throws** if per-exec `allowRead`/`allowWrite` are set. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1795–L1806)

### Required config shape

`SandboxRuntimeConfig` requires `network` and `filesystem` objects. ([sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L1057–L1134)

Required arrays:

- `network.allowedDomains`, `network.deniedDomains`
- `filesystem.denyRead`, `filesystem.allowWrite`, `filesystem.denyWrite`
- `filesystem.allowRead` is optional

Optional top-level: `credentials`, `ignoreViolations`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep`, `mandatoryDenySearchDepth` (1–10, default 3), `allowPty`, `seccomp`, `bwrapPath`, `socatPath`, `windows`, `git`.

Empty `allowedDomains` = no network. Empty `allowWrite` = no user writes (plus hardcoded default write paths). Empty `denyRead` = full read. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L117–L120, L300–L303)

### Return values

| Call | Returns | Meaning |
|---|---|---|
| `initialize` | `Promise<void>` | Proxies/bridges ready, or throw |
| `wrapWithSandbox` | `Promise<string>` | POSIX wrapper command string |
| `wrapWithSandboxArgv` | `{ argv, env }` | Spawn descriptor; **not** exit code/stdout |
| caller `spawn` | OS child | Exit code/stdio belong to **your** spawn, not SRT |
| `annotateStderrWithSandboxFailures(key, stderr)` | string | Appends `<sandbox_violations>…` if the store has events for that key ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L2204–L2224) |
| `checkDependencies` | `{ errors, warnings }` | errors → cannot run; warnings → degraded (e.g. no seccomp) ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L498–L501; [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1014–L1018) |

SRT never returns a Coda-style `ProcessRunResult`. The README library sample only logs `child.on('exit', code => …)`.

### Error modes (documented in code)

**Throw at initialize**

- `Sandbox dependencies not available: …` (Linux: missing bwrap/socat/rg; unsupported platform; Windows srt-win resolve failure). ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L643–L648, L970–L971)
- `network.tlsTerminate and network.mitmProxy are mutually exclusive`. (L621–L624)
- Windows `WindowsSandboxError('not_provisioned', …)` if `srt-sandbox` user/cred missing. (L694–L702)
- Windows WFP egress verify failure; CA trust missing/mismatch (`trust_ca_not_installed`, `trust_ca_thumbprint_mismatch`). (L712–L773)
- Unreadable/non-PEM CA when `tlsTerminate` is set. (L619–L620)

**Throw at wrap**

- `wrapWithSandbox()` on Windows. (L1719–L1723)
- `Sandbox configuration is not supported on platform: …` (L1725–L1729)
- `Shell '…' not found in PATH`. (macos L1133–L1135; linux L1962–L1964)
- Linux HTTP/SOCKS bridge socket missing. (linux L1843–L1853)
- Windows per-exec `allowRead`/`allowWrite`. (manager L1801–L1806)
- Windows `WindowsSandboxError('argv_too_long', …)` if estimated command line > ~30 000 chars. ([windows-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/windows-sandbox-utils.ts) L2109–L2119)
- Credential `onExtractNoMatch: "error"` at wrap time (schema docs). ([sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L327–L334)

**At runtime (child / proxy; not thrown by wrap)**

- Filesystem: OS `EPERM` / “Operation not permitted”. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L34–L36, L724–L728)
- Network deny: proxy blocks; HTTP 403 with reason; SOCKS refusal (including in-band SSH disconnect for port 22). ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L25–L27, L306–L307; [request-filter.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/request-filter.ts) L19–L38)
- Linux tools that ignore `HTTP_PROXY` simply cannot connect (namespace is empty). ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L787–L788; [linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L595–L598)

**CLI process exits:** command exit code propagated; SIGINT/SIGTERM → 0; spawn error → 1; Windows install UAC cancel → 2. ([cli.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/cli.ts) L85–L88, L312–L333)

**Ask callback:** hosts on neither allow nor deny list are denied unless `sandboxAskCallback` returns true **and** `network.strictAllowlist` is not set. Callback throw → deny. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L349–L369; schema comment in [sandbox-schemas.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-schemas.ts) L79–L85)

### Public TypeScript exports (actual `src/index.ts`, not the README list)

README “Available exports” (L232–L252) lists `SandboxManager`, `SandboxViolationStore`, and a subset of types. **The compiled public surface is larger**, including:

- `WrapWithSandboxOptions`
- `SandboxRuntimeConfigSchema` and related Zod schemas (`NetworkConfigSchema`, `FilesystemConfigSchema`, `CredentialsConfigSchema`, `WindowsConfigSchema`, …)
- `FilterRequestCallback`, `RequestDecision`
- Windows: `installWindowsSandbox`, `uninstallWindowsSandbox`, `windowsTrustCa`, `WindowsSandboxError`, `VENDORED_SRT_WIN_EXE`, ACL helpers, …
- `generateCa` / `validateCaPair` (MITM CA)
- `getDefaultWritePaths`, `getWslVersion`

Source: [src/index.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/index.ts) L1–L126.

`wrapWithSandboxArgv` is **not mentioned in the README** at all; it exists only on `SandboxManager`.

---

## 3. Isolation model

### Dual isolation (stated requirement)

README: both filesystem and network isolation are required; either alone is insufficient. Restrictions apply to the **entire process tree**. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L105–L115)

### Filesystem

| | Default | Pattern | Enforcement |
|---|---|---|---|
| Read | Allow everywhere | deny-then-allow; `allowRead` overrides `denyRead`, except a **more specific** `denyRead` inside an allow stays denied | macOS Seatbelt; Linux bwrap bind mounts; Windows NTFS ACEs |
| Write | Deny everywhere | allow-only; `denyWrite` overrides `allowWrite` | same |

([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L117–L120, L342–L354; [sandbox-schemas.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-schemas.ts) L3–L40)

**macOS:** dynamically generated Seatbelt profile; git-style globs. Profile allows `process-exec` and `process-fork` (children stay in the same sandbox). ([macos-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts) L490–L627, L677–L679)

**Linux:** if write policy is on: `--ro-bind / /` then `--bind` allowWrite paths; denyWrite rebound read-only / `/dev/null` stubs. Always `--dev /dev`. Relative/mandatory-deny paths use `process.cwd()`. Globs on **write** paths are **skipped** (logged), not expanded; deny/allow **read** globs are expanded via ripgrep. ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L939–L942, L1916–L1919; [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1551–L1561)

**Windows:** sandboxed process runs as `srt-sandbox`, which has **no inherent rights** on the caller’s files. `initialize()` adds inheriting ACEs: MODIFY on `allowWrite` (without `FILE_DELETE_CHILD`), READ|EXECUTE on `allowRead`, DENY on deny lists. Globs expanded **once at initialize**; a path created later is not covered. Per-exec grants are not supported. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L532–L546, L573)

**Mandatory write denies** (always, unless `filesystem.disabled`): `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.mcp.json`; dirs `.vscode/`, `.idea/`, `.claude/commands/`, `.claude/agents/`; `.git/hooks/` and `.git/config` (config can be re-enabled with `allowGitConfig`). Linux: only **existing** files; search depth default 3. macOS globs also block new files. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L652–L694; [sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L11–L40)

**Default extra write paths** always unioned into allowWrite when FS policy is on: `/dev/stdout|stderr|null|tty|…`, `/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`. Documented as “intentionally broad”. ([sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L410–L432; [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1568–L1569)

**`filesystem.disabled`:** no read/write rules and **no** mandatory denies. Network/credential-env still apply. Linux still replaces `/dev` with bwrap’s minimal devtmpfs. ([sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L876–L886)

Relative paths and `~` expand; normalization uses **`process.cwd()`**, not wrap’s `cwd` argument on POSIX. ([sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L314–L315; README L381–L384)

### Network

Allow-only. Empty allowlist = deny all. `deniedDomains` checked first. Optional `:port` suffix; IPv6 must be `[addr]` / `[addr]:port`. Overly broad allow wildcards like `*.com` or `*` are **rejected** on allow; deny may use `*` / `*:22`. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L121–L130, L300–L307; [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L21–L119)

Traffic is forced through host proxies (see §4). The proxy, not the kernel, evaluates domain lists (Linux comment: `--unshare-net` is all-or-nothing). ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L595–L598)

Unix sockets **blocked by default**. macOS: path allowlist. Linux: seccomp blocks `socket(AF_UNIX)` (x64/arm64 prebuilt); cannot filter by path; `allowAllUnixSockets` disables. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L330–L340)

`allowLocalBinding` default false. ([sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L748–L751)

### Environment

- POSIX: child inherits spawn env; SRT prefixes `env -u …` / `bwrap --unsetenv` / `--setenv` for credentials and **bakes proxy vars into the wrapper command**.
- Windows: child starts with a **fresh logon profile**; overlay is PATH/PATHEXT + generated proxy/CA vars + mask sentinels. Caller `ProcessEnv` does not become the child env. ([windows-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/windows-sandbox-utils.ts) L2080–L2129)
- `credentials.envVars` `mode: "deny"` unsets; `mode: "mask"` sets a sentinel (proxy substitutes on TLS-terminated egress). ([sandbox-schemas.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-schemas.ts) L42–L65)
- Generated child vars include `SANDBOX_RUNTIME=1`, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`GRPC_PROXY`, optional `TMPDIR=/tmp/claude`, and CA trust vars when MITM is on. ([sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L461–L570)

### Subprocesses / PID

- **Linux:** `--new-session --die-with-parent --unshare-pid`; unless `enableWeakerNestedSandbox`, also `--unshare-user --cap-drop ALL --proc /proc`. apply-seccomp adds a nested PID namespace so the user command cannot ptrace unfiltered helpers. Comment: without `--unshare-pid` “it is possible to escape the sandbox.” ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L1638–L1654, L1747, L1921–L1938)
- **macOS:** Seatbelt allows fork/exec; children inherit the profile. Not a PID namespace. (macos L677–L679)
- **Windows:** two-hop `CreateProcessWithLogonW` + restricted token **inside a job object**; any out-of-band spawn still carries the `srt-sandbox` SID so WFP/ACLs still apply. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L532–L536)

### Platform support

| Platform | Status | Notes |
|---|---|---|
| macOS | Supported | `sandbox-exec`; no extra packages in **code** (README still lists rg) |
| Linux | Supported | Needs bwrap, socat, rg; WSL2 treated as Linux; **WSL1 unsupported** (`getWslVersion() === '1'`) ([platform.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/utils/platform.ts) L40–L50; [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L944–L950) |
| Windows | **Alpha** | Bundled `srt-win.exe`; elevated install; see known limitations |
| Other | `isSupportedPlatform()` false | `checkDependencies` error `Unsupported platform` |

Ubuntu 24.04+: `kernel.apparmor_restrict_unprivileged_userns` breaks bwrap/seccomp; README documents a sysctl workaround. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L484–L490)

Seccomp prebuilts: **x64 and arm64 only**. ia32 explicitly unsupported (`socketcall` bypass). ([generate-seccomp-filter.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/generate-seccomp-filter.ts) L86–L122)

### What is NOT confined (stated limitations)

From [README.md Security Limitations / Known Limitations](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L771–L793 and code comments:

- Domain allowlists do **not** inspect request bodies unless experimental `network.tlsTerminate` is on. Broad domains (`github.com`) can still exfiltrate. Domain fronting is called out.
- Linux: processes that ignore proxy env vars cannot reach the network; they are not silently unsandboxed, but there is no proxychains/`LD_PRELOAD` yet.
- Linux seccomp does not block use of **inherited** Unix socket FDs or `SCM_RIGHTS`. (linux L1662–L1668)
- `allowUnixSockets` can be a full host escape (e.g. Docker socket). (README L778)
- Broad write to `$PATH` / shell rc / system config can escalate. Mandatory denies mitigate some rc/git-hook cases only. (README L779)
- `enableWeakerNestedSandbox` (Docker): considerably weaker. (README L781; linux L1926–L1948)
- `enableWeakerNetworkIsolation` (macOS): re-allows `com.apple.trustd.agent` — exfil vector. (README L782; schema L1077–L1081)
- `allowAppleEvents` (macOS): **removes code-execution isolation**; launched apps run **outside** the sandbox. (README L391, L783; macos L710–L718)
- macOS file **mask** degrades to **deny** (SBPL cannot redirect reads). (macos L1020–L1037; schema L300–L302)
- Windows: DNS via system `Dnscache` is not fenced; schannel CRL/OCSP blocked by WFP (revocation workarounds); per-user tool installs not readable; `proxyAuthToken` visible on runner argv; glob coverage is point-in-time. (README L569–L575)
- Not a VM. Linux is namespaces + bind mounts, not a full container image.
- Reads of the rest of the host remain allowed unless you `denyRead` a broad prefix and `allowRead` the Workspace.

Violation monitoring: macOS log store (optional `enableLogMonitor`); Linux seccomp observer is best-effort; README still tells Linux users to use `strace` for FS denies. Store keeps last **100** events. ([sandbox-violation-store.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-violation-store.ts) L8–L11; README L734–L749)

---

## 4. Network allowlists, filesystem mounts/roots, proxying

### Allowlists

`filterNetworkRequest` (host proxy):

1. Reject malformed hosts (control characters).
2. Canonicalize (`127.1` / integer IPs).
3. Match `deniedDomains` (with optional port) → deny + optional `deniedDomainReasons`.
4. Match `allowedDomains` → allow.
5. Else deny, unless `sandboxAskCallback` allows and `strictAllowlist` is not set.

([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L290–L369)

`network.filterRequest`: library-only callback (`Request` → `{action, reason?}`). Applies to plain HTTP and, with `tlsTerminate`, decrypted HTTPS. Throw → deny. **Cannot be expressed in JSON settings.** ([request-filter.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/request-filter.ts); [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L790–L802)

### How proxying is forced

**Host side:** SRT starts a mux proxy (HTTP CONNECT + SOCKS5 on one port) unless `network.httpProxyPort` / `socksProxyPort` point at an external proxy (then SRT skips starting that side and **does not** do domain filtering for it — “The external proxy must handle domain filtering”). ([sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L769–L786; [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L871–L908)

Auth: 16-byte hex token embedded in proxy URLs (`user:token@localhost:port`). Username also carries encoded `commandId` for violation attribution. SOCKS5 requires username/password; unauthenticated clients get a refusal (SSH port 22 can get an in-band deny banner). ([sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L469–L481; [socks-proxy.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/socks-proxy.ts) L238–L293)

**macOS:** Seatbelt allows outbound only to the proxy localhost ports (and loopback if `allowLocalBinding`). Other TCP is kernel-denied. Child env points tools at those ports. ([macos-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts) L843–L931; README L126)

**Linux:** `bwrap --unshare-net` (no interfaces). Host `socat` bridges Unix sockets → host proxy ports. Those sockets are bind-mounted in. Inside the sandbox, socat listens on **3128** (HTTP) and **1080** (SOCKS); env `HTTP_PROXY=http://localhost:3128`. ([linux-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts) L576–L594, L1832–L1875)

**Windows:** WFP `ALE_AUTH_CONNECT` BLOCK for `srt-sandbox` SID except loopback into proxy port range (default `60080–60089`). Env points at the mux. Unsetting proxy env does not bypass WFP. NO_PROXY is **deleted** on Windows so localhost still goes through the proxy. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L128, L537–L538; [windows-sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/windows-sandbox-utils.ts) L2051–L2061)

**Parent/upstream proxy:** `network.parentProxy` or `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` on the **host** (resolved before SRT starts its listeners). ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L609–L611; [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L157–L177, L864–L869)

**MITM / TLS terminate (experimental):** `network.tlsTerminate` decrypts HTTPS CONNECTs so `filterRequest` and credential injection can see requests. `excludeDomains` for mTLS/pinning. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L310–L328; schema L803–L863 marked `[EXPERIMENTAL]`)

README L752–L767 still says “Custom proxy configuration is not yet supported in the new configuration format.” **That sentence is stale:** `httpProxyPort`, `socksProxyPort`, `mitmProxy`, and `parentProxy` exist in the schema.

### Filesystem “mounts” / roots

There is **no container rootfs image**. Linux bind-mounts the **host** `/` read-only, then rebinds write roots. macOS/Windows confine the existing host tree. Workspace-only recipes in the README are `denyRead: ["/Users"]` + `allowRead: ["."]` + `allowWrite: ["."]`, with system paths remaining readable. ([README.md](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md) L432–L449)

Linux leftover: bwrap may create empty host files as mount points for non-existent deny paths; `cleanupAfterCommand()` deletes them. ([sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1938–L1949)

---

## 5. Can it wrap an existing spawn (executable + args + cwd + env + stdin + abort/timeout)?

**No first-class argv spawn API.** Both wrap functions take a **command string**. The library never calls `spawn` on the user command (except internally for proxies, `log stream`, socat, `srt-win`, ripgrep).

| Coda `ProcessRunRequest` field | SRT support | Evidence |
|---|---|---|
| `executable` + `args` (`shell: false`) | Not directly. Caller must quote into a string. Wrap **always** ends in `<shell> -c <command>` (POSIX) or `srt-win exec -- <shell> <command>` (Windows). | wrap implementations above; Coda [process-runner.ts](packages/coding-agent/src/host/process-runner.ts) L1–L14 |
| `cwd` | Caller passes spawn `cwd`. POSIX wrap **ignores** the `cwd` argument; FS policy relative paths use `process.cwd()`. Windows uses `cwd` for `git.safe.directory` only. | [sandbox-manager.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts) L1747–L1752, L1872–L1880; [sandbox-utils.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-utils.ts) L314–L315 |
| `environment` | POSIX: inherit from **your** spawn env; proxy/credential vars injected inside the wrapper. Returned `env` from `wrapWithSandboxArgv` is `process.env`. Windows: child **does not** receive caller env. | manager L1880; windows L2080–L2129 |
| `stdin` | POSIX: whatever stdio you pass to spawn is inherited by sandbox-exec/bwrap. Windows: broker writes a length-prefixed `RunnerCmd` to runner stdin then **closes it**; comment says “future stdin-after-spec use”. **User stdin is not forwarded today.** | [logon.rs](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/vendor/srt-win-src/src/logon.rs) L380–L396; [runner.rs](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/vendor/srt-win-src/src/runner.rs) L72–L75 |
| `signal` / `timeoutMs` | Not SRT’s job after spawn. Wrap `abortSignal` only cancels Linux wrap-time rg. You still kill the wrapper process. Linux `--die-with-parent` helps if the wrapper dies. | linux L1747, L272–L281 |
| `maxOutputBytes` / `onOutput` | Unrelated; caller’s spawn pipes. | — |

CLI is not required; the library is the wrap API. CLI is one embedder of that API.

Coda bash already plans `executable: shell, args: […, command]` ([bash.ts](packages/coding-agent/src/tools/bash.ts) L122–L125). Feeding that argv into SRT by quoting it would **double-wrap** (`bash -c 'env … sandbox-exec bash -c …'`). The intended SRT shape for a shell command is `wrapWithSandbox(command, binShell)` with the inner script as `command`.

---

## 6. ProcessRunner adapter vs a different seam

Coda today:

- `ProcessRunner.run(ProcessRunRequest) → ProcessRunResult` — [process-runner.ts](packages/coding-agent/src/host/process-runner.ts)
- Node implementation: `spawn(executable, args, { cwd, env, stdio, detached: platform !== "win32", shell: false })` — [node-process-runner.ts](packages/coding-agent/src/host/node-process-runner.ts) L62–L74
- Same request shape for `ProcessSessionRunner.start` (piped stdin, background Process Session) — [node-process-session-runner.ts](packages/coding-agent/src/host/node-process-session-runner.ts) L51–L62
- Injected at composition root: `options.processRunner ?? createNodeProcessRunner(...)` — [node-application.ts](packages/coding-agent/src/node-application.ts) L174–L175
- Callers include bash Tool, User Shell, find, grep, git status, completion evidence, media, work coordinator.

**What an injected ProcessRunner adapter can do (facts, not a design):**

1. On first use / composition root: `SandboxManager.initialize(config)` with **absolute** Workspace paths (because `.` is `process.cwd()`).
2. Per `run`/`start`: `wrapWithSandboxArgv(quotedCommand, binShell, undefined, request.signal, request.cwd)` then `spawn(argv[0], argv.slice(1), { shell: false, cwd, env, stdio })`, keeping Coda’s timeout, output budget, and abort.
3. After Linux commands: `cleanupAfterCommand()`.
4. On process exit: `reset()` (SRT also registers its own `exit` handler).

**Why that adapter is a poor 1:1 map (facts):**

- SRT requires **session** `initialize`/`reset` and a singleton manager. `ProcessRunner` has neither. A second `initialize()` is ignored. Multi-Workspace in one Node process would share one allowlist/ACL set.
- Wrap input is a **string + extra shell**, not argv. Generic quoting of `executable+args` is possible but adds a shell (Coda currently uses `shell: false` on purpose). Bash/User Shell already have a command string; find/grep do not.
- Injecting at ProcessRunner would also wrap **Coda-internal** git/find/grep, not only model-directed Shell / User Shell.
- Windows: no caller env, no caller stdin, session-wide ACL grants at `initialize`, no per-exec write roots.
- POSIX `detached: true` (Coda) vs Linux `--die-with-parent`: interaction is not documented by SRT; killing by process group (`process.kill(-pid)`) is Coda’s current policy.

**Different seam that the SRT API actually matches:** a host-level SandboxRuntime **session** (initialize once per Coda process/Workspace) plus wrap **only** at Shell / User Shell / Process Session construction, passing the script string and `binShell`. That is closer to SRT’s CLI and README library sample than to `ProcessRunRequest`.

Unclear without a Coda product decision: whether Workspace file Tools (read/write/edit) should stay on Coda’s FileSystem (unsandboxed Node `fs`) while only process execution is confined. SRT does not intercept Node `fs`; it only confines descendant processes.

---

## 7. Stability

| Signal | Fact | Source |
|---|---|---|
| Experimental | README “Beta Research Preview”; org `anthropic-experimental`; Windows “alpha” | README L7–L9, L512–L514 |
| Semver | `0.0.73` — 0.0.x, 73 tagged releases from 2025-10-20 (npm created) through 2026-08-13 | npm `time.created` / `time.modified`; [releases](https://github.com/anthropic-experimental/sandbox-runtime/releases) |
| Churn | HEAD is a release commit; recent PRs include Windows ACL/WFP, proxy host canonicalization, macOS glob deny, SOCKS auth. No CHANGELOG file. | [commits on main](https://github.com/anthropic-experimental/sandbox-runtime/commits/main) |
| Docs lag | README export list omits `wrapWithSandboxArgv`, schemas, Windows APIs, credentials. README says custom proxy “not yet supported” while schema has four proxy knobs. README says macOS needs ripgrep; `checkDependencies` does not. | README vs [index.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/index.ts) / [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) |
| Singleton / global process hooks | One `SandboxManager`; `SIGINT`/`SIGTERM`/`exit` handlers | sandbox-manager.ts L175–L188, L2336 |
| Native risk | Linux: **unbundled** bwrap/socat/rg + AppArmor userns sysctl; vendored `apply-seccomp`. Windows: elevated install, machine-wide WFP, `srt-sandbox` account, DPAPI password in HKLM, bundled `.exe`. macOS: system `sandbox-exec` (deprecated-but-present Apple tool; SRT does not discuss deprecation). | README platform sections; vendor binaries in npm pack |
| Embedder surface | `seccomp.argv0` / `windows.srtWin.path` exist specifically so hosts can fold helpers into a multicall binary | [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L953–L977, L1039–L1051 |
| Popularity (not quality) | ~5k GitHub stars, 160 open issues (2026-08-17) | GitHub API |
| Credentials / TLS MITM | Large, still-moving subsystem (`mask`, JWT `decode`, AWS SigV4 re-sign). Optional for a first Coda wrap. Schema still says “Additional modes (e.g. mask) will be added” in one comment while `mask` already exists — leftover comment. | [sandbox-config.ts](https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts) L655–L664 vs L189 |

Pinning `@anthropic-ai/sandbox-runtime@0.0.73` (or a git SHA) is the only way to freeze API; the project itself warns formats may evolve.

---

## 8. Source index

Pinned tree: https://github.com/anthropic-experimental/sandbox-runtime/tree/5feb5269f1c86f49e62224ffb8297b2f01a31806

| What | URL / path |
|---|---|
| README | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/README.md |
| package.json | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/package.json |
| Public exports | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/index.ts |
| Manager API | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-manager.ts |
| Zod config schema | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-config.ts |
| Internal FS/network types | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/sandbox-schemas.ts |
| CLI | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/cli.ts |
| Config file loader (CLI) | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/utils/config-loader.ts |
| macOS wrap | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/macos-sandbox-utils.ts |
| Linux wrap | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/linux-sandbox-utils.ts |
| Windows wrap | https://github.com/anthropic-experimental/sandbox-runtime/blob/5feb5269f1c86f49e62224ffb8297b2f01a31806/src/sandbox/windows-sandbox-utils.ts |
| npm | https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.73 |
| Release | https://github.com/anthropic-experimental/sandbox-runtime/releases/tag/v0.0.73 |
| Coda ProcessRunner | `packages/coding-agent/src/host/process-runner.ts` |
| Coda Node runner | `packages/coding-agent/src/host/node-process-runner.ts` |
| Coda bash Tool | `packages/coding-agent/src/tools/bash.ts` |

### Unclear / contradictions (do not invent)

- Whether Apple will keep `sandbox-exec` available; SRT does not document a fallback.
- Whether Coda’s `detached: true` + Linux `--die-with-parent` compose safely; not tested here.
- README vs code on macOS ripgrep.
- README vs schema on “custom proxy not yet supported.”
- Windows user-stdin after `RunnerCmd`: code comments imply it is unfinished.
- How `filterRequest` (a function) could ever live in `~/.srt-settings.json` — it cannot; JSON config is a subset of the library config.
- Whether wrapping FileSystem-backed Tools is in scope; SRT cannot confine in-process Node `fs`.
