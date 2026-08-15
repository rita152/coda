# CLI Session statusline

Status: implemented

Historical implementation record. Implementation and verification completed on
2026-08-12. Current rendering is enforced by
[`status-line.test.ts`](../../packages/coding-agent/test/status-line.test.ts).
The example below retains the retired `Workspace / On Request` label; the
current first row contains only Workspace and Git state.

## Goal

Place a compact, ambient two-row statusline directly below the Composer so the focused Session always exposes its Workspace, Git state, cumulative cost, current model-visible Context, Model, Provider, and effective Reasoning effort.

## Default presentation

```text
~/Desktop/coda (main*)                    Workspace / On Request
$1.23 · 128k/1m          opencode-go/deepseek-v4-flash(max)
```

## Behavior

- Keep the top Header to `Coda` plus transient modes such as `Transcript`; never duplicate statusline information there.
- Render Workspace/Git on row one. Render cumulative Session cost and Context on the left of row two, with `provider/model(reasoning)` right-aligned.
- Use the canonical Workspace root, abbreviate the home directory with `~`, and shorten narrow paths semantically to `~/…/coda` and then `coda`.
- Render Git as `(main)`, dirty Git as `(main*)`, and detached HEAD as `(@a1b2c3d)`. Omit the segment outside Git repositories.
- Render Context as current model-visible used tokens / current Model window, for example `128k/1m`. Prefix estimated usage with `~`; never substitute accumulated Session tokens for the current projection.
- Render cost as cumulative Session model cost, including discarded attempts and compaction calls. Use adaptive precision (`$0.003`, `$1.23`), show `sub` for subscription-backed use, and omit cost when reliable pricing is unavailable.
- Render a reasoning-capable Model with its effective level, including `(off)`. Omit parentheses when the Model does not support reasoning.
- Prefer content on narrow terminals in this order: Model, Context, Workspace basename plus Git, Provider, cost, then Workspace parent path. Hide whole segments before producing ambiguous fragments; use `…` only inside a shortened path or field.
- Keep the ambient statusline visible during active Runs; Run progress belongs to the Activity row above the Composer. Temporarily replace both statusline rows with action feedback for image/attachment focus, Shell mode, unread Timeline updates, Transcript mode, paused queues, active User Shell, and exit confirmation. Restore the ambient statusline when the action ends; do not retain idle shortcut hints.
- Use muted styling for Workspace, cost, and normal Context; accent for Model; warning for dirty Git and Context at 80%; error for Context at 95%. Preserve complete textual meaning under `NO_COLOR`.
- Refresh Git asynchronously at startup, after Coda-run commands that can modify the Workspace, and periodically so external branch/dirty changes become visible.

## Acceptance criteria

1. Wide and narrow frames match the confirmed two-row information hierarchy, remain within terminal display width, and preserve cursor, attachment, drawer, preview, and viewport geometry.
2. Model switching updates Provider/Model/Reasoning and Context window without rebuilding the Composer; cross-Model token usage is explicitly estimated.
3. Compaction immediately switches Context to its replacement projection and persists compaction cost; resumed Sessions preserve cumulative cost for successful, discarded, and compacting Model calls when prices are known.
4. Header duplication and idle shortcut hints are absent. Active Runs retain both ambient rows below the Composer, while the remaining actionable Footer states still replace them temporarily.
5. Git branches, dirty state, detached HEAD, non-Git Workspaces, cost precision/absence, Context thresholds/estimation, reasoning off/unsupported, sanitization, Unicode display width, and `NO_COLOR` have automated coverage.
