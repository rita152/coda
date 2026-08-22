# Coda TUI Visual Refresh

Status: implemented

Current terminal behavior is documented in
[`packages/tui/README.md`](../../packages/tui/README.md) and the generated
capability manifest. The design below is retained as implementation history.

## Objective

Make every interactive Coda Run use a robust full-screen terminal experience with a scrollable semantic Timeline, a Pi-style multiline Composer, compact Codex-inspired Tool Invocation presentation, CommonMark/GFM Messages, visible Thinking Blocks, durable input queues, and safe image attachment previews.

Print and JSON modes remain non-interactive. The visual refresh does not add a regular inline TUI mode.

## Module seams

### FullScreenTui

`@coda/tui` owns a deep FullScreenTui Module. Its interface hides alternate-buffer entry and exit, autowrap, cursor visibility, synchronized output, resize, viewport composition, animation scheduling, and cleanup ordering. `ProcessTerminal` remains the Adapter for raw input, terminal negotiation, and writes.

Renderable Modules receive an immutable `{ width, height, now }` context. A single TUI-owned animation clock invalidates active frames and is canceled on stop.

### MarkdownRenderer

`@coda/tui` owns a pure MarkdownRenderer Module that accepts sanitized CommonMark/GFM source, width, and `streaming | complete` phase and returns physical terminal lines. It never imports AI, Agent, Session, or Coding Agent types.

### SemanticTimeline

`@coda/coding-agent` owns Message, Thinking Block, Tool Invocation, MCP Elicitation, and Attachment presentation policy. One reducer hydrates a Session semantic history snapshot and consumes live Agent events. Stable Tool identity is `invocation.id`; display order is Turn plus `sourceIndex`, never completion order.

### MediaLibrary and TerminalImageSurface

`@coda/coding-agent` owns a Session-scoped, content-addressed MediaLibrary. It validates, stores, normalizes, and resolves Media Assets. FullScreenTui owns a separate TerminalImageSurface that receives semantic preview requests and hides Kitty upload, placement, deletion, and shutdown.

## Full-screen lifecycle and layout

- Every interactive TTY enters the alternate buffer; non-TTY, `--json`, `--print`, and `--no-tui` use print mode.
- Start enters the alternate buffer before raw input begins. Stop disables image placements and input protocols before restoring the main buffer.
- Startup failure, exceptions, SIGTERM/SIGHUP, and suspend restore terminal state. Resume re-enters full-screen and forces a redraw.
- Normal exit prints only the final Assistant answer, Session identity/resume hint, and an error line when applicable.
- Failure to enter full-screen restores the terminal and recommends `--no-tui`; it never falls back to a hidden regular TUI.
- The screen contains a one-line responsive header, a scrollable Timeline viewport, and a bottom editor dock. Below `40x10`, a static too-small view replaces complex layout and animation.
- Header fields disappear in the order Reasoning, Model, Workspace; `Coda` remains. Contextual footer hints disappear by priority while exit/modal instructions remain.

## Scrolling and focus

- Tail-follow is active only while at the bottom. Manual scroll preserves a logical entry plus intra-entry offset across updates and resize.
- Unseen entry additions or updates display `down N updates - Ctrl+End` in the dock.
- PageUp/PageDown page the viewport; Ctrl+PageUp/Ctrl+PageDown move through the Editor; the terminal mouse wheel scrolls by physical rows; Ctrl+Home/Ctrl+End jump to the ends. Submitting a prompt returns to tail-follow.
- Ctrl+T toggles Transcript View. Escape returns from Transcript View before it can exit the main screen.
- Running Ctrl+C aborts; idle Escape is ignored and two idle Ctrl+C presses within 500ms exit.
- MCP Elicitation uses a bounded input overlay owned by the active Session.
- Mouse support is limited to Timeline wheel navigation and image-label button/hover events; keyboard access is complete and native terminal selection remains available through the terminal's modifier behavior.

## Messages and Markdown

- User text remains literal and renders between full-width muted horizontal borders without a label. Attachments render before text inside the same card.
- Assistant text renders as unlabeled open Markdown.
- Thinking Blocks render as full streaming Markdown in original content order, using dim italic text while Assistant text uses normal foreground. NO_COLOR adds a non-color Thinking marker.
- Only committed Assistant content enters the durable Timeline. Discarded retry, failure, and abort partials are removed.
- CommonMark plus GFM covers headings, emphasis, lists, quotes, fenced code, tables, task lists, deletion, and autolinks. Raw HTML is literal text.
- Fenced code shows its language and soft-wraps with a continuation gutter; full syntax highlighting is deferred.
- Tables align when they fit and degrade to stacked `column: value` rows when they do not.
- Coda generates safe OSC 8 links only for http, https, and mailto destinations. Markdown images remain alt text plus URL and are never fetched.

### Main Timeline rhythm

- Main Timeline blocks retain exact event order and near-equal information weight; no final-answer-first regrouping is allowed.
- One blank display row separates adjacent visible blocks only when their semantic content type changes. Consecutive blocks of the same type remain compact.
- User, Thinking, Exploring, general Tool, Assistant commentary, Assistant final answer, User Shell, error, and notice are distinct spacing types. A User card therefore has one ordinary type-change gap before following model content.
- Internal Turn boundaries never create spacing by themselves. If content also changes type at that boundary, only the ordinary type-change gap appears.
- OpenAI text-signature phases preserve commentary and final answer as distinct spacing types without changing their near-equal Markdown treatment. Providers without a phase use the generic Assistant type.
- Empty streaming blocks do not create or suppress gaps. Spacer rows have stable viewport identities so scroll anchoring and attachment hit regions remain correct.
- Ctrl+T Transcript View retains its existing dense layout; the new rhythm applies only to the main Timeline.

## Tool Invocation presentation

- Main Timeline Tool geometry is behaviorally aligned with OpenAI Codex commit `f93109615ff27ab58007601434b27c940d5500c7`; Coda retains its own semantic lifecycle and does not port Codex's scrollback architecture.
- Main Timeline uses a borderless tree with a state bullet, bold action word, dim gutter and result text, and code-styled command text. Transcript View retains its existing success/failure glyphs and detail layout.
- Action language is Reading/Read, Searching/Searched, Editing/Edited, Writing/Wrote, Running/Ran, and Exploring/Explored.
- States are awaiting input, running, success, failed, aborted, skipped, and interrupted. Interrupted states state that side effects are unknown.
- One or more consecutive read, grep, find, and ls invocations form an Exploring/Explored group without losing child identity, order, concurrency, or error state. Successive exploration calls across turns are appended to the same group. The group uses one dim branch followed by aligned Read, List, and Search actions.
- Preview output is at most five display rows, preserving head and tail with an omitted-row marker and the Codex-aligned `ctrl + t to view transcript` hint. Transcript View shows the complete normalized model-visible result, not raw Provider payloads or hidden overflow data.
- Tool text is stripped of ANSI, OSC, C0, and C1 controls before presentation.
- read/grep/find/ls render compact path/query/count/truncation summaries; edit renders a bounded before/after diff; write renders operation/path/bytes; bash renders command, bounded output, exit/signal/timeout/truncation, and duration.
- Unknown tools use Calling/Called with compact arguments and bounded normalized output.
- Durations appear after one second. Live execution output is not added to the Agent contract in this milestone, but the Timeline model accepts future incremental result updates.

## Theme and motion

- The default terminal background/foreground remain the unknown-appearance fallback. `ui.colorScheme` and `--color-scheme` resolve `auto | light | dark`, and semantic Theme tokens include appearance-aware surfaces for input overlays.
- Running uses accent motion, success green, execution failure red, and denied/aborted/skipped warning yellow. Text and glyphs retain meaning without color.
- True-color terminals use bullet shimmer; lower color levels use a bullet pulse. `ui.motion` is `full | reduced`, and `--no-animations` overrides it.
- Coda ships one semantic Theme with light, dark, and unknown-appearance mappings; user-authored custom Themes remain deferred.

## Composer and input queues

- `@coda/tui` owns an application-neutral Editor with full-width top and bottom `─` borders, no side borders, no placeholder, and no horizontal padding. `@coda/coding-agent` resolves the border color from the current Reasoning level.
- The Editor is grapheme-safe, word-wraps before hard wrapping, supports logical Home/End, visual-row Up/Down with a preferred column, word movement/deletion, Emacs kill/yank, undo, large-paste markers, and a cursor placement contract for IME/native cursor positioning.
- Plain Enter submits, Shift+Enter inserts a logical newline, and backslash followed by Enter is the legacy-terminal newline fallback. Content is capped at `max(5, floor(rows * 0.3))` visible rows with `↑/↓ N more` border indicators.
- While a Run is active, Enter queues Steering and Alt+Enter queues a durable Follow-up. `/follow-up` is the legacy fallback. A provisional User card appears immediately and reconciles in place with Agent events.
- Aborting or failing a Run clears Steering and pauses unconsumed Follow-ups. Empty Enter resumes paused Follow-ups in FIFO order. New input while paused appends to the queue before resuming it. Alt+Up reclaims the newest pending or failed Follow-up into the Editor.
- Restored pending Follow-ups render as Paused; failed Follow-ups remain recoverable across restart and render on their committed User card. Re-sending a reclaimed item creates a new queue identity.
- The Coding Agent InputQueueController owns media preparation, Agent queue mutation, durable Session records, compensation, resume, and reclaim. Each Follow-up gets a fresh per-Run Prompt snapshot and context-budget check when it actually starts.
- Autocomplete, selection, redo, and durable unsent-draft restoration remain deferred.

## Attachments and previews

- Repeated `--image <path>` and interactive `/attach <path>` add staged Attachments. Unsupported Models block submission without dropping attachments.
- Attachment chips display a safe basename; duplicates gain numeric suffixes. Composer chips wrap to at most two rows and report hidden overflow. Unnamed Tool Result images receive a synthesized filename.
- Hover, click, or keyboard focus shows a compact preview of at least `28x8`; Enter opens a centered modal using 90 percent of available width and height. Escape or q closes it. Zoom and pan are deferred.
- Internal preview is enabled only for reliable Kitty graphics environments such as Kitty, Ghostty, and WezTerm. iTerm2, tmux, Zellij, Screen, unknown terminals, and unsupported protocols use a metadata preview and explicit system viewer activation (`open` or `xdg-open`). Sixel and multiplexer passthrough are deferred.
- One prompt accepts at most ten images, at most 20 MiB each and 50 MiB total, at least 8 pixels on the short edge, and at most 16 megapixels decoded.
- Magic-sniffed PNG, JPEG, GIF, and WebP are accepted. The original is preserved; terminal preview is a static PNG; model rendition is at most 2000 pixels on the long edge and 4.5 MiB.
- Staged media is removed when detached, abandoned, or rejected. Committed media moves into the Session Media Store.
- User and Tool Result image support are separate Provider capabilities. The Timeline warns when it can preview an image that the selected Provider did not send to the Model.

## Session v3 and JSON

- Session v3 journal records refer to Media Assets by digest rather than embedding base64. Media files are mode `0600`, content-addressed by SHA-256, and deduplicated.
- Session v3 adds `follow_up_reclaimed`; pending, consumed, paused, and failed presentation states are projected from queue and Run facts. All journal appends share one serialized predecessor chain.
- Opening v1 externalizes inline media and migrates directly to v3; opening v2 upgrades its header and schema to v3. Both migrations fsync, validate, atomically replace the journal, preserve a versioned backup, and emit a migration Diagnostic.
- Session history exposes presentation-neutral Message and Tool lifecycle facts; Chat never reads raw JSONL.
- JSON v2 emits media descriptors by default. `--include-media-data` explicitly opts into base64.
- Session references protect media. `coda cleanup` removes unreferenced media older than seven days.

## Accessibility and security

- Every interaction is keyboard-operable. Image clicking is an enhancement, not the only path.
- NO_COLOR emits no SGR. Reduced motion starts no periodic animation tasks.
- Model, Tool, Markdown, filename, command, and media metadata text is sanitized before terminal rendering.
- Main Timeline uses requested workspace-relative paths; canonical paths remain limited to diagnostic contexts.

## Performance contract

- Committed Markdown caches by source and width.
- Layout work is proportional to visible or changed blocks, not complete Session size.
- Streaming reparses only the current content block.
- A deterministic 10,000-line history stress test is required; no machine-specific wall-clock threshold is used.

## Verification

Verification covers pure formatter and Editor behavior, strict terminal-text sanitization, protocol ordering, a strict cell-grid screen model, Session migration/hydration and Follow-up recovery, Tool concurrency and state transitions, Markdown streaming and responsive degradation, media admission/storage/preview/fallback, color and motion capability branches, and macOS PTY Prompt-card, multiline-Editor, wheel-navigation, and lifecycle smoke.

## Deferred

- regular inline TUI
- generic mouse interaction and drag selection handling
- live Tool stdout/progress protocol
- custom Themes and Theme selector
- full shell or fenced-code syntax highlighting
- user-authored Markdown rendering
- remote/local Markdown image fetching
- Sixel, iTerm2 full-screen graphics, and multiplexer image passthrough
- image zoom/pan and animated terminal preview
- autocomplete, selection, redo, and durable unsent-draft restoration
