# Codex-compatible Permissions and Sandbox

Status: Confirmed for implementation on 2026-08-10

## Objective

Replace Coda's existing advisory Tool policy with an end-to-end permission engine and real operating-system Sandbox whose observable behavior for the three built-in Permission Profiles matches the local Codex checkout at commit `f93109615ff27ab58007601434b27c940d5500c7`.

The implementation is behaviorally redesigned for Coda in TypeScript. It does not mechanically translate Rust and has no build or runtime dependency on `/Users/zp/Desktop/codex`. A small auditable native Linux launcher is permitted only where process setup ordering cannot be made safe from Node.js.

## Confirmed seams

Tests and callers use only these three seams:

1. The `@coda/sandbox` `execute(request, callbacks)` interface. It accepts canonical absolute roots and a compiled Permission Profile, streams output, supports cancellation and timeout, owns the entire descendant process tree, and returns typed launch, denial, timeout, cancellation, and process outcomes.
2. The `@coda/coding-agent` Policy Gate seam at the model Tool Invocation boundary. It resolves policy, command and host rules, caches, approval routing, Additional Permissions, denial, abort, and explicit escalation without leaking those concerns into `@coda/agent`.
3. The application seam shared by CLI, interactive TUI, print output, JSON events, settings, and Session audit records. Every surface must observe the same effective permission engine.

The Sandbox has internal platform seams with a production and conformance adapter. They are not exported merely for tests.

## Permission Profiles

### Read Only

- the filesystem is readable by default;
- there are no writable roots;
- managed network access is restricted;
- the preset Approval Policy is On Request.

### Workspace

- the filesystem is readable by default;
- every explicitly configured canonical workspace root, `/tmp`, and canonical `$TMPDIR` is writable;
- `.git`, `.agents`, `.codex`, and `.coda` directly below every restricted writable root are protected read-only, including deny-create behavior when absent;
- managed network access is restricted;
- the preset Approval Policy is On Request.

Additional roots are admitted only by explicit configuration or an approved Additional Permission. Coda never expands writable authority to an arbitrary Git parent. A more-specific approved write path reopens only that reviewed descendant, including when it is inside protected metadata; it does not reopen the protected ancestor or its siblings.

### Full Access

- no outer filesystem or network Sandbox is applied;
- network access is enabled;
- the preset Approval Policy is Never;
- hard-deny command classification, persistent forbid rules, exec policy, and application hooks still apply.

Interactive Full Access selection first chooses the profile and then shows one warning confirmation; the override lasts only for the current process. An explicit CLI or settings selection does not prompt. Restricted profiles fail closed if their platform Sandbox is unavailable; Coda never falls back to Full Access.

## Approval Policies and decisions

Coda supports Unless Trusted, On Request, Granular, and Never with Codex-equivalent command routing. Granular retains Codex's fields for Sandbox approval, Command Rule prompts, Skill approval, standalone permission requests, and MCP elicitations. Managed-network host review remains available for every policy except Never. Skill and MCP have generic protocol types but no product implementations in this milestone, and inline model elevation remains an On Request flow.

An Approval Request may be approved once, approved for the process-local Session cache, persisted as a Command Rule, persisted as a Network Rule, denied while allowing the model to continue, or denied while aborting the current Run. Approval timeout is a reserved typed outcome. Persistence failure warns but does not revoke the current approval.

The model shell protocol supports default execution, execution with precise Additional Permissions, and require-escalated execution with an optional justification and optional proposed command prefix. A normal Sandbox denial is returned to the model and never causes an automatic unsandboxed retry. The model must explicitly request escalation. A recognized managed-network denial alone may enter the host approval flow.

Print mode uses the same Policy Gate and Sandbox with a rejecting approval adapter. It never reads stdin, never hangs, emits an `approval_required` Tool result and JSON event, permits the model to choose another approach, and exits nonzero if the Run cannot ultimately complete.

## Command and network rules

- Command Rules use Codex prefix semantics and the user-editable Starlark-like syntax at `~/.coda/rules/default.rules`.
- Persistent Network Rules use a Coda-owned versioned format.
- Session command decisions are in memory only.
- Session network decisions are keyed by environment, lowercase host, protocol, and port.
- Managed network access identifies a blocked host, applies persistent and Session decisions, and can request an allow-once, allow-for-session, or persistent amendment.

## Execution provenance

- model shell, model-triggered search executables, and every future model process use the Sandbox execution capability;
- built-in File Tools use a centralized canonical, descriptor-safe permission evaluator and never rely on a pre-check followed by an unrestricted pathname operation;
- explicit interactive User Shell remains unsandboxed and is reachable only through a distinct host execution capability that no model Tool receives;
- the fixed macOS Keychain helper and explicit user image viewer remain trusted host paths.

## Platform adapters

macOS uses fixed `/usr/bin/sandbox-exec` and generated Seatbelt policy. Linux uses bubblewrap with user, mount, PID, and appropriate network namespaces, `no_new_privs`, seccomp, and the managed proxy route. Coda prefers a capable system bubblewrap and otherwise uses a bundled, checksum-validated build with its license and provenance retained.

The supported matrix is macOS arm64/x64 and Linux arm64/x64. WSL2 is Linux; WSL1 and native Windows are unsupported. This milestone adds no PTY, background terminal, terminal recovery, or remote execution.

## Configuration and lifecycle

Permission Profile and Approval Policy are independent. The ordinary user interface exposes Read Only, Workspace, and Full Access presets; advanced CLI/settings/JSON may choose independent values and Granular details.

Resolution order is invocation CLI override, current-process `/permissions` override, explicit settings default, then Project Trust-derived default. Known trusted or untrusted status defaults to Workspace when a platform Sandbox is available; unknown status defaults to Read Only. A cold resume recomputes from the new process and never restores `/permissions`, transient Full Access, Session command approvals, or temporary host grants.

Settings and Session schemas may break compatibility. Old allow flags and old permission records are removed with no fallback. Session records are audit facts, never authorization, and record initial/effective policy, changes, backend and roots, escalation details, decisions, rule amendments and persistence warnings, and Sandbox denial versus normal failure.

## Acceptance matrix

- one unit matrix covers all Permission Profile × Approval Policy × request-kind combinations;
- command parsing, safe/dangerous classification, hard deny, prefix-rule matching/amendment, Session cache, host rules, rejecting approval, denial, abort, and no-automatic-escalation are verified through the Coding Agent seam;
- real macOS and Linux escape tests cover writes outside configured roots, protected metadata write/create, symlink and rename races, network denial/approval, descendants, timeout/cancellation, and fail-closed startup;
- CI runs Node 22 on `macos-15`, `macos-15-intel`, `ubuntu-24.04`, and `ubuntu-24.04-arm`;
- local macOS and all four CI jobs must pass before completion is claimed.

## Delivery

The current local history replaces the failed public `rita152/coda` history. After local verification, configure `origin`, confirm remote `main` still equals `760907eeadbaa9e2ad8a3949ad7b8ddaf24ec2a1`, and update it with an exact `--force-with-lease`. Then monitor and repair CI until all four platform jobs pass.
