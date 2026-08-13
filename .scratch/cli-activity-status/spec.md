# CLI runtime activity status

## Goal

Show the focused Session's current Coda runtime activity in one left-aligned row immediately above the Composer. The row supplies evidence that work is progressing; it never labels a Run as stuck or suspected-stuck.

## Behavior

- Hide the row while idle and show `Working...` whenever a Run is active but no more specific status is available.
- Cover pre-Run preparation, model work, retry backoff, MCP waits, manual compaction, and explicit User Shell execution.
- Keep the row stable through Tool start, progress, and completion events. Tool details remain in the Timeline while the row keeps the Provider summary or `Working...`.
- Prefer actionable waits over retry, Provider summary, and generic work, in that order.
- Use native reasoning summaries from OpenAI Responses-family and Anthropic Messages protocols only when the streamed content yields a complete concise status.
- Explicitly ignore reasoning extensions from OpenAI Chat Completions and fall back to `Working...`.
- Present a Provider summary directly, for example `Proposing concurrent tool status formatting`; do not prefix it with `Thinking ·`.
- Sanitize terminal controls and remove common Markdown decoration. Promote only a complete Provider heading or action sentence no longer than 120 characters; keep `Working...` while a fragment is incomplete or the available reasoning prose is too verbose. Clip the final row to terminal width.
- Show phase elapsed time and time since the latest semantic runtime event when width permits.
- Animate active work with a Codex-style left-to-right shimmer. User waits are static. Reduced motion and `--no-animations` render static text while time and retry countdowns continue to update.
- Keep state scoped to each `ChatComponent`, so multi-Session mode displays only the focused Session's row.

## Acceptance criteria

1. Concise Responses-family and Anthropic summaries appear without a `Thinking` prefix; incomplete or verbose thinking stays `Working...`, and Chat Completions thinking never appears in the row.
2. Tool start, progress, and completion do not change the row text; retry, MCP Elicitation, and User Shell states override summaries and return to the correct fallback after completion.
3. Run end and Shell completion remove the row and stop high-frequency animation.
4. The additional dock row preserves full-screen height, viewport, cursor, attachments, and command drawer geometry.
5. Truecolor terminals use the two-second cosine-band shimmer; lower color levels use DIM/normal/BOLD; reduced motion is static.
