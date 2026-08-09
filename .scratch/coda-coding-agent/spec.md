# `@coda/coding-agent` Initial Design Spec

Status: Milestone 1 core and the TUI visual-refresh milestone are implemented and verified

## Objective

Compose Coda's AI, TUI, and Agent packages into the local terminal Coding Agent used by its creator every day.

## Package boundary

- The package depends on `@coda/ai`, `@coda/tui`, and `@coda/agent`.
- It owns application policy: model selection, Credential persistence, settings, sessions, coding Tools, filesystem and Shell integration, prompts, and terminal composition.
- Lower packages do not import this package or know its configuration paths.
- All dependencies enter through explicit factories or constructors; importing the package has no process-global side effects.

## First interaction modes

- interactive TUI for daily coding
- one-shot print mode for scripts, tests, and diagnosis

Print mode exits after the requested Agent run settles.

### Interactive Composer

- The interactive Composer uses the application-neutral `@coda/tui` Editor while Coding Agent policy supplies Reasoning-level border color, queue commands, Attachments, and footer help.
- Sent User Prompts use the same full-width horizontal-border geometry as the Composer and remain literal, unlabeled text. Assistant replies remain open and unlabeled.
- Enter sends a Prompt while idle and queues Steering while running. Alt+Enter queues a durable Follow-up. Shift+Enter inserts a newline; `/follow-up` and backslash+Enter cover legacy terminals.
- Aborted or failed Runs pause unconsumed Follow-ups. Empty Enter resumes FIFO; input typed while paused appends before resume; Alt+Up reclaims the newest pending or failed item for editing.
- Plain Up/Down replays current-Session Prompt History directly into the Editor only at the first/last visual row. Entering history snapshots the exact draft state; moving beyond the newest entry restores text and cursor. History contains accepted Prompt, Steering, and Follow-up text, collapses adjacent duplicates, survives Session resume, and excludes User Shell commands.
- A leading `!` enters Shell mode by moving the bang into a red bold prefix, turning the Composer border red, and showing a red `Shell mode` footer. `\!` sends a literal leading bang to the Model and remains escaped in Prompt History.
- The InputQueueController is the application seam for media preparation, Agent mutation, User Shell scheduling, Session facts, compensation, resume, and reclaim. Chat presentation never appends raw Session records.

### Print contract

- Default stdout contains only the final assistant text.
- `--json` writes stable JSONL Agent events.
- Logs and Diagnostics go to stderr.
- A successful final outcome exits `0`; final error, abort, configuration failure, or fatal Tool failure exits `1`.
- Non-TTY stdin or stdout selects print mode unless the user explicitly chooses a mode.

## Deferred modes and public surfaces

- RPC
- client/server protocol
- public application SDK
- extension API

These are not required to validate the first useful Coding Agent and must not expand lower-package public contracts early.

## Already assigned responsibilities

- FileSystem and Shell capabilities
- coding Tool implementations
- persistent CredentialStore
- settings and default Model policy
- eventual session persistence and restore
- composition of TUI Components with Agent events
- the user-facing decision for whole-turn retry defaults

## Initial coding Tools

The first application provides `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`. Implementation proceeds through the four read-only Tools before mutation and Shell Tools. `read` is text-only initially; image reading is deferred.

The interactive TUI also provides explicit User Shell mode. It is a separate, user-authorized local capability rather than an Agent Tool: commands never enter model Context, Tool policy, Prompt History, or Session persistence. Print and JSON modes continue to treat leading-bang input as ordinary model input.

## Model selection

Resolution order is:

1. an explicit CLI Model
2. the Model restored from a Session
3. the user's configured default Model
4. an interactive first-run selection that is saved for later

Print mode without a configured, authenticated Model fails with a configuration error. Coda never chooses the first catalog entry or a hard-coded OpenCode Go Model as an implicit fallback.

### Reasoning selection

- Reasoning resolution is explicit CLI value, Session value, user settings, then application default `medium`.
- A Model without reasoning capability has effective value `off`; a reasoning Model maps or narrows the requested level through its advertised capabilities.
- The effective value is visible in the TUI, JSON `run_start`, and Session history.
- Interactive changes are Session-local unless the user separately saves a global default.

## Default security posture

- `@coda/coding-agent` owns an injected Policy Gate; lower packages do not know paths or approval UI.
- File Tools default to an explicit workspace root.
- Access outside the workspace, protected writes, and high-risk Shell require approval.
- Interactive mode may prompt; non-interactive mode fails closed when approval is unavailable.
- Policy is not a sandbox. An approved process still runs with host-user authority unless a separately configured execution backend provides stronger isolation.

### Path containment

- Workspace root is an absolute canonical realpath fixed at launch.
- Relative paths resolve from that root; absolute paths are automatically eligible only when still contained by it.
- `~` and `file://` inputs are not accepted initially.
- Existing targets are checked by realpath. New targets check the nearest existing ancestor and are checked again immediately before commit.
- Symlinks that resolve outside the Workspace are rejected by default.
- Approved external access creates a one-operation Path Grant for the exact canonical path rather than disabling containment.
- Diagnostics retain both requested and resolved paths.

### Approval defaults

- Ordinary in-Workspace `read`, `grep`, `find`, and `ls` are automatically allowed.
- Ordinary in-Workspace `edit` and `write` are automatically allowed in interactive mode.
- `.git/**`, `.coda/**`, `.env*`, private-key, and certificate paths require approval for reading or writing.
- All outside-Workspace access requires an exact Path Grant.
- Interactive `bash` asks each time and may be allowed once or for the current Run; there is no persistent allow-all in the first release.
- Print mode is read-only unless passed `--allow-workspace-write`; Shell additionally requires `--allow-bash`.
- Non-interactive execution never opens an approval UI and never treats missing approval as consent.
- Built-in sensitive-path protection cannot be permanently removed in the first release. Users may add globs or approve an exact operation; explicit rules exempt public examples such as `.env.example`.

### Policy Decision contract

Interactive approval returns `allow_once`, `allow_run`, `deny`, or `deny_and_abort`.

- `deny` produces an explicit rejected Tool result and permits the Run to continue; `deny_and_abort` also aborts the Run.
- The presentation includes Tool name, command or diff, requested and canonical paths, cwd, policy reason, exact grant scope, and the fact that Shell is not network- or host-sandboxed.
- Outside-Workspace Path Grants are exact and one-operation only.
- A protected-path Run grant binds Tool, operation, and canonical path.
- A Shell Run grant explicitly covers all later Bash invocations in that Run.
- The first release has no permanent allow choice. Non-interactive execution consumes only predeclared CLI Policy and never simulates an approval UI.

### Shell execution

- Shell cwd is the Workspace root.
- The default Shell is non-interactive and non-login.
- Only `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, and locale are inherited automatically.
- Provider keys, tokens, secrets, cloud credentials, npm tokens, and SSH agent sockets are stripped unless explicitly allowlisted by the user.
- Environment allowlisting uses exact variable names rather than wildcard secret patterns. Diagnostics may name stripped variables but never include values.
- Default timeout is 120 seconds. Abort and timeout terminate the whole process group.
- Managed background jobs are not supported initially.
- Model-visible output is capped at 2,000 lines or 50KB. Overflow is written to a `0600` temporary log with cleanup policy.
- Shell networking is not sandboxed and approval UI states that fact.

### Explicit User Shell execution

- Only the interactive Composer recognizes a leading `!`; the bang is absorbed into Shell-mode presentation and Enter submits the remaining non-empty command.
- Commands run from the Workspace through `$SHELL -lc`, falling back to `/bin/sh`, with the complete current environment and host-user authority. The explicit leading bang is the authorization; Policy Gate and approval overlays do not apply.
- Execution is non-interactive with ignored stdin and no PTY. macOS and Unix are supported; Windows produces a clear local diagnostic.
- User Shell work shares one strict process-local deferred FIFO with Agent Follow-ups. Steering still enters an active Agent Run immediately. Agent failure or abort pauses the FIFO; Shell failure, timeout, or cancellation continues it.
- Live stdout and stderr are merged in Node callback-observation order. Output is terminal-sanitized, converts carriage returns to append-only lines, removes bidi overrides/isolates, and remains bounded in memory to 50 KiB and 2,000 normalized lines with a true head/tail omission marker.
- Ctrl-C terminates the process group with SIGTERM and a one-second SIGKILL grace; timeout is one hour. No overflow file or Transcript View exists for User Shell output.
- Pending User Shell commands disappear on process exit with a warning. They and their output are absent from Session, Agent Seed, model Context, and Prompt History.

### File mutation

- `edit` validates expected old content and unique non-overlapping matches.
- `edit` and `write` use a same-directory temporary file followed by atomic rename.
- Existing mode, BOM, and newline style are retained when editing.
- Mutations serialize per canonical target.
- Abort before commit preserves the target; a completed atomic rename reports success even if cancellation arrives afterward.
- Containment is rechecked around commit and results include a structured diff or create/overwrite summary.
- Cross-file transactions and rollback are not promised.

### Search executables

`grep` and `find` prefer installed `rg` and `fd` but never download executables. Built-in Node.js fallbacks preserve ignore, limit, truncation, and abort semantics.

## Credential persistence

- macOS uses Keychain service `coda.cli.credentials.v1` with Provider ID as account.
- Interactive flows may prompt and save; print mode never prompts.
- Explicit request key and `OPENCODE_API_KEY` remain available through the AI credential precedence.
- Session, settings, diagnostics, and logs never contain the secret.
- Logout removes the Keychain entry.
- Linux and Windows use environment credentials until a secure platform store exists; there is no plaintext auth-file fallback.

## Initial Session policy

- Interactive mode persists Sessions by default and supports `--no-session`.
- Print mode is in-memory by default and persists only when explicitly requested.
- The format is versioned append-only JSONL with stable record identity, parent identity, Run sequence, and timestamp.
- The initial implementation supports list, resume, and linear continuation, not branch, compaction, or summary.
- Files live below `~/.coda/sessions/<workspace-id>/` and are explicitly created with mode `0600`.
- Session content is local plaintext but excludes Credentials, environment variables, and default stack traces.

### Session durability and recovery

- One writer owns a Session through an exclusive lockfile containing process identity and start time.
- Records validate schema, unique identity, monotonic sequence, and parent relationships.
- Only a truncated final line is recoverable: it is ignored with a warning while the original file is preserved.
- Mid-file corruption, duplicate IDs, sequence regression, or unknown format versions refuse resume and are never silently rewritten.
- Persisted records include the header, completed Messages, Tool Invocations and results, Model changes, and Run/Turn outcomes.
- Streaming deltas, raw Provider responses, and complete environments are not persisted.
- Overflow Shell logs are separate `0600` files; the Session contains only the truncated model-visible result and a reference.

### Session v4 schema and compatibility

The first JSONL line is a `session` header with `version: 4`, Session identity, Workspace identity and canonical path, and creation time. Every later Session Record contains its type, stable Record and Session identity, monotonically increasing Session sequence, `previousRecordId`, timestamp, optional Run/Turn/Attempt identity, and typed payload. Image content is stored as a validated Media Asset reference; bytes live in the mode-`0600` Session Media Store. All Agent-event and application writes are serialized through one append tail so physical order and predecessor identity cannot diverge.

Version 1, 2, and 3 journals remain readable. Opening v1 externalizes inline image bytes; every older version migrates directly to v4. Each migration writes and syncs a complete temporary journal, validates it, preserves a versioned backup, and atomically replaces the active journal before exposing the Session.

`previousRecordId` deliberately names a linear predecessor rather than implying a tree parent.

Allowed Record types are:

```text
run_started
attempt_started
attempt_finished
retry_scheduled
message_committed
tool_started
tool_finished
turn_finished
run_finished
follow_up_enqueued
follow_up_consumed
follow_up_canceled
follow_up_reclaimed
composer_submission_recorded
composer_submission_retracted
model_selected
project_trust_changed
```

- Unconsumed Follow-up survives resume; Steering does not. Restored unmatched items are Paused.
- Failed Follow-ups are projected from `follow_up_enqueued`, `follow_up_consumed`, `run_started`, and `run_finished` facts and remain recoverable. `follow_up_reclaimed` is the durable tombstone used by Alt+Up.
- Composer Submission facts project current-Session Prompt History independently from Message commit order. Retraction removes a reclaimed, unconsumed Follow-up. User Shell is never a Session Record.
- A crashed active Run becomes interrupted, loses unconsumed Steering, and never restores pending approval or process state.
- Streaming deltas, render events, and approval UI events are not Session Records.

### Tool crash barrier

- `tool_started` is appended and synced before `execute()` begins.
- `tool_finished` is appended immediately after settlement.
- An unmatched start is an Interrupted Tool Invocation with unknown side effects.
- The first release never automatically replays an interrupted Tool, regardless of its replay metadata.
- Interactive recovery requires the user to skip or explicitly re-execute; `replay: never` can only be skipped with an interrupted Tool result.
- Print recovery fails on an Interrupted Tool Invocation.
- If `tool_started` cannot be made durable, execution does not begin.

### Lock ownership

The lockfile records an owner token, PID, process start time, hostname, Session identity, and creation time. A matching live owner blocks other writers. A definitely dead owner may be archived and recovered interactively; uncertain ownership is never removed automatically. Print requires explicit `--force-unlock`, and close removes only a lock with the caller's owner token.

### Session Module Interface

```ts
interface SessionManager {
  open(request: OpenSessionRequest): Promise<Session>;
}

interface Session {
  readonly descriptor: SessionDescriptor;
  readonly seed: AgentSeed;
  readonly recoverableFollowUps: readonly RecoverableFollowUp[];
  readonly composerSubmissions: readonly ComposerSubmission[];
  readonly toolInvocations: readonly SessionToolLifecycle[];
  readonly mediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]>;
  registerMedia(registrations: readonly SessionMediaRegistration[]): void;
  attach(agent: Agent): DetachSession;
  record(change: SessionChange): Promise<void>;
  close(): Promise<void>;
}
```

- `open()` hides locking, reading, validation, final-line recovery, and state reduction.
- One Session attaches to at most one Agent. Its listener persists within Run settlement.
- `record()` handles application changes such as Model selection and Project Trust that are not Agent events.
- `close()` is asynchronous, idempotent, and releases ownership.
- File and in-memory Session Journal Adapters sit at a private seam; callers do not read or append raw records.

## Temporary logs

- Temporary output lives under `~/.coda/tmp/` with `0700` directories and `0600` files.
- Startup and `coda cleanup` remove unreferenced files older than seven days.
- When total size exceeds 512MB, cleanup removes oldest unreferenced files first.
- Active Session references protect a log from automatic deletion.
- Cleanup failure emits a Diagnostic but does not prevent startup.

## Initial project context

- Only an explicitly named `AGENTS.md` inside the workspace is eligible for automatic project context.
- Project skills, extensions, prompts, themes, packages, and executable settings are deferred.
- The exact trust and non-interactive authorization flow remains open.

### Project Trust

- Only the canonical Workspace root `AGENTS.md` is considered; parent directories are not searched.
- Trust is bound to canonical Workspace path and file SHA-256.
- Interactive mode asks on first discovery and whenever content changes.
- Print mode fails on untrusted or changed instructions unless `--trust-project` is explicit.
- Project Trust permits context loading only and never relaxes Policy Gate decisions.
- Events and Sessions record path and hash, not a second metadata copy of the instruction text.

## System Prompt

- Only `@coda/coding-agent` owns a versioned Prompt Builder; lower packages receive an already-built `Context`.
- Each Run freezes one deterministic prompt snapshot containing identity and behavior boundaries, canonical Workspace facts, registry-derived Tool capabilities, runtime capability facts, and trusted root `AGENTS.md` instructions.
- Time and platform facts come from injected capabilities. Credentials, secret environment values, and unrelated host state never enter the prompt.
- Project instructions are delimited with their canonical source path and content hash, and are capped at 64 KiB. Oversize input is a configuration error, never silently truncated.
- `run_started` persists the Prompt Builder version and SHA-256, not a duplicate of the full prompt.
- Agent invokes the Coding Agent's synchronous pre-Run preparation seam for every Prompt and Follow-up. Prompt freezing and conservative context checks therefore happen when a queued Run actually starts, after all earlier Runs have committed.

## Context Overflow

- Before requesting, Coda conservatively accounts for Messages, Tool schemas, and reserved output against the Model context window.
- Definite overflow prevents the request. Provider-reported overflow becomes a non-retryable `context_overflow` Diagnostic.
- Coda never silently drops, truncates, or summarizes Session history in the first release.
- Failed Attempt partial output is not committed. Interactive mode offers a new empty Session; print mode exits `1`.
- Carrying a summary into another Session requires explicit user-authored input until compaction is implemented.

## Design status

The first-release design frontier is closed. The private Milestone 1 core now composes `@coda/ai`, `@coda/tui`, and `@coda/agent` with both interaction modes, all seven initial Tools, Keychain-backed macOS Credentials, scoped approvals, deterministic per-Run prompts, context checks, retry, append-only Sessions, a multiline Composer, current-Session Prompt History, explicit User Shell mode, and durable recoverable Follow-ups. Autocomplete, selection, redo, durable drafts, compaction, branching, RPC, extension APIs, and public release remain deferred. Markdown presentation, image attachments, terminal previews, and structured Tool Invocation presentation enter the visual-refresh milestone specified in `.scratch/coda-tui-visual-refresh/spec.md`.
