# `@coda/sandbox`

`@coda/sandbox` is Coda's private operating-system Sandbox for every model-started process. It exposes one capability-oriented `execute(request, callbacks)` API with canonical absolute roots, streaming output, cancellation, timeout, bounded retained output, typed denials, and descendant-process ownership. Its immutable `ReadAccessPolicy` projects the same compiled read decision to native callers and Sandbox processes.

## Permission profiles

- **Read Only** reads the canonical Workspace and explicitly reviewed roots, writes nowhere, and has no direct network access.
- **Workspace** reads the canonical Workspace, its temporary/writable roots, and explicitly reviewed roots. It writes only configured canonical roots, `/tmp`, and the canonical temporary directory. `.git`, `.agents`, `.codex`, and `.coda` directly below every restricted writable root are reapplied read-only. A narrower reviewed write root reopens only its exact subtree after the broader metadata mask.
- **Full Access** is the explicit full-disk read/write bypass, applies no outer Sandbox, and enables network access. Configured denied-read roots are intentionally discarded for this profile.

The API accepts multiple Workspace roots. Coda currently supplies the launch Workspace plus only roots explicitly configured or approved; Git parents are never inferred.

## Platform backends

macOS uses `/usr/bin/sandbox-exec` with a generated SBPL profile. Linux uses bubblewrap user/PID/IPC/UTS namespaces, an empty root populated with fixed operating-system runtime support plus readable roots, reviewed writable overlays, `no_new_privs`, capability removal, and a small C launcher that installs a seccomp deny filter before the requested program starts. Restricted Linux network runs in a separate network namespace; reviewed HTTP and CONNECT traffic can traverse a loopback bridge to Coda's host-side exact-destination proxy.

Linux resolves a capable, root-owned, non-writable system `bwrap` first. A build may package the current architecture's system binary as a fallback; both it and the native launcher receive SHA-256 manifests, and the first expected digest is retained in process memory so changing an asset and its adjacent manifest cannot establish a new trust root during that process. WSL2 is supported through the Linux path; WSL1 and native Windows fail closed.

The package does not provide PTY, background-terminal, terminal-recovery, Guardian, custom-profile, or enterprise-management features.

## Development

```sh
npm run build --workspace=@coda/sandbox
npm test --workspace=@coda/sandbox
npm run test:integration --workspace=@coda/sandbox
```

Linux builds require a C11 compiler and a capable trusted system bubblewrap. Generated fallback provenance is written beside the binary under `resources/linux-<arch>/provenance.json`.

See `THIRD_PARTY_NOTICES.md` and `resources/BUBBLEWRAP_COPYING` before distributing a Linux artifact.
