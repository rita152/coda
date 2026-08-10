# Coda Approval Bar

Status: Implemented and verified on 2026-08-10

## Objective

Replace the interactive command-approval modal with a source-aligned reproduction of Codex's full-width bottom Approval Bar at reference commit `f93109615ff27ab58007601434b27c940d5500c7`. The bar supports light, dark, unknown-background, reduced-color, and NO_COLOR terminals without raising Coda's existing terminal requirements.

The milestone delivers the complete command Approval Request loop. The presentation Module is reusable for later filesystem, network, Skill, and MCP approval migrations, but those migrations are deferred.

## Runtime scope

- The Approval Bar is used only by the interactive FullScreenTui. Print, JSON, `--no-tui`, and non-TTY modes retain their existing behavior.
- It replaces the centered command approval modal directly; there is no feature flag or legacy interactive path.
- Approval Requests remain FIFO and individually reviewed without adding queue metadata to Codex's compact presentation.
- The Tool Invocation says `Awaiting approval` until authority is granted and `Running` only after execution starts.

## Information hierarchy

The bar renders, in order:

1. `Would you like to run the following command?`
2. the optional Environment
3. `Reason`
4. an optional Additional Permission rule
5. the complete command, with terminal controls and bidi controls rendered visibly rather than interpreted
6. the available decisions, including the exact eligible Session prefix in the option text
7. `Press enter to confirm or esc to cancel`

Canonical Workspace, effective Authority, and executable identity remain enforced and audited by the Permission Engine but are not expanded in the Codex-compatible primary surface. When there is not enough space to review safely, the bar displays `Approval pending — resize terminal`, disables approval shortcuts, and retains only scrolling, Escape-to-cancel, and Ctrl-C-to-abort.

## Interaction state machine

- The first decision is selected initially, matching Codex; Enter confirms the selected decision.
- Up/Down wraps through decisions. PageUp/Home selects the first decision and PageDown/End selects the last.
- `y` or the displayed number approves once. `p` or the displayed number grants an eligible prefix for this process. Decision numbers are sequential, so denial is `2` without a prefix and `3` with one. Direct shortcuts never activate from pasted input.
- Escape and Ctrl-C cancel the Run, matching Codex's `Cancel` decision.
- Selecting `No, and tell Coda what to do differently` also cancels the Run, closes all queued reviews, and returns focus to the Composer.
- The Approval Bar owns focus. Ordinary Steering and Follow-up input is unavailable until the request is resolved.
- Resize and suspend/resume preserve selection and scroll position. The interactive Approval Request has no timeout and no mouse interface.

## Responsive and accessible presentation

- The bar is a full-width, content-height bottom focus overlay and covers the Composer while active.
- The menu surface uses one row of vertical padding and two columns of horizontal padding. A blank row separates the header from the decisions; the dim footer remains on the terminal background.
- Details wrap and vertically scroll; the component never relies on horizontal terminal scrolling.
- The selected row uses Codex's `›` marker and bold cyan foreground on the same surface background; selection never creates a second background block.
- Focus, selection, disabled approval, success, and denial are expressed with glyphs and text as well as color.
- Diagnostics cannot cover the Approval Bar. Background Timeline updates cannot mutate the reviewed command, prefix, or Authority.
- The UI is English and uses the product name Coda. User-facing copy is centralized.

## Appearance and Theme

- `ui.colorScheme` and `--color-scheme` accept `auto | light | dark`; precedence is CLI, user setting, then `auto`.
- `NO_COLOR` and `--no-color` override every scheme and emit no SGR.
- In `auto`, ProcessTerminal queries OSC 11 during its existing startup-negotiation window, bounded to 100 ms. Explicit light/dark skips the query. Malformed, late, or unsupported responses cannot mutate the settled capability.
- Unknown appearance uses the terminal's default foreground/background and an unfilled structural fallback.
- Theme exposes semantic appearance/surface/on-surface/muted/strong/emphasis/code tokens. Components do not hard-code palette colors.
- Dark surfaces approximate Codex's 12% light blend and light surfaces its 4% dark blend; light-mode selection uses the Codex `(0, 95, 135)` accent.
- True-color light and dark pairs target 4.5:1 normal-text contrast. 256-color, 16-color, and NO_COLOR modes retain the same information hierarchy.
- Appearance is resolved once at startup in this milestone; live switching is deferred.

## Command Session Approval

- When offered, the second decision creates a process-local Session Approval. It is never serialized as active authority and is marked expired when historical audit is restored in a later process.
- Only a model-proposed token prefix that the Permission Engine validates and the Approval Bar displays exactly may be granted. Coda never guesses a prefix.
- A prefix is eligible only for one statically understood simple command. Pipelines, compound commands, redirections, substitutions, variables, control constructs, `sh -c` wrappers, and Additional Permissions are one-time approval only.
- A Session Approval binds environment, canonical Workspace, shell, effective Permission Profile/Authority, Sandbox request, token prefix, and the resolved executable realpath plus stat identity.
- Every reuse re-resolves PATH and executable identity. A mismatch revokes the grant, emits one diagnostic/audit fact, and reviews the current request again.
- Session Approval only suppresses a matching future prompt. It never becomes a persistent Command Rule and never changes whether a command is sandboxed.
- The grant becomes active when the user approves, independent of the command's exit result.
- Changing the Permission Profile or Approval Policy revokes all active Session Approvals.

## Persistent rules and hardening

- The default interactive UI no longer writes persistent Command Rules. Explicit user rule files, their parser/store/evaluator, and the existing custom-handler persistent decision remain supported.
- Complex shell inspection applies `forbidden` and `prompt` guards to statically discovered literal commands while retaining conservative Sandbox behavior for allow rules.
- A shell request that cannot be understood statically prompts in interactive approval modes and rejects under `never`.
- A basename rule cannot match an absolute executable unless an explicit matching `host_executable` establishes that identity. Ambiguous legacy matches fail closed with a diagnostic; Coda never rewrites the user's rule file.

## Management and audit

- `/approvals`, available while the Agent is idle, lists active process-local command Session Approvals and can revoke one or all. Revocation affects future invocations only.
- Each Tool Invocation retains a compact approval result: approved once, approved for this process, denied, or allowed by a Session Approval.
- Historical process-local grants render as expired after Session restore.
- Cancellation is audited as an aborted Approval Request and restores the Composer for the next user message. Custom non-interactive reviewers may still return a model-visible denial Tool Result.
- Termination, fatal failure, external Agent abort, or TUI teardown resolves pending and queued reviews as abort, not as a user denial. Normal suspend/resume preserves the active review.

## Module seams

- `@coda/tui` owns ProcessTerminal appearance negotiation, immutable TerminalCapabilities, input parsing, and overlay composition.
- `@coda/coding-agent` owns Theme selection, Approval Bar presentation/state, approval management, audit projection, and Permission Engine semantics.
- Tests cross the public seams at Terminal, Theme creation, Permission Engine, InteractiveApprovalHandler/Tui, Chat slash commands, Semantic Timeline, and the macOS PTY process.

## Verification

- Deterministic rendering covers light, dark, unknown appearance, True Color, 256 color, 16 color, NO_COLOR, wide, narrow, short, and unsafe-to-review sizes.
- Interaction covers default selection, sequential number keys, direct keys, paste immunity, unsafe-size detail scrolling, resize preservation, FIFO requests, focus restoration, suspend/resume, and teardown.
- Permission tests cover prefix validation, execution-context and executable identity, profile invalidation, revocation, Additional Permissions, complex-shell guards, unknown-shell failure, and absolute/basename matching.
- Terminal tests cover OSC 11 success, BEL/ST termination, timeout, malformed response, late response, and explicit-scheme query suppression.
- Package checks, repository `npm test`, integration tests, and a macOS PTY approval smoke must pass.

## Deferred

- migration of non-command Approval Requests
- mouse interaction
- live appearance switching
- interactive persistent-rule creation
- localization
- non-interactive approval presentation changes
