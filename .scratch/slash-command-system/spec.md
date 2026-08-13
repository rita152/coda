# Unified Slash Command System

Status: Implemented and verified

## Objective

Replace hard-coded Composer slash branches with one internal command system that supports Core Controls, Core Actions, and future Skill/MCP Extension References through a shared upper-drawer interaction.

The system must preserve Coda's Editor/Composer/Agent boundaries, freeze Model and Credential state for each active Run, and allow multiple workspace-scoped Session Runtimes to remain live while the user switches focus.

## Confirmed semantics

- Core configuration commands are `/auth`, `/model`, and `/session`; they accept no arguments.
- `/new` creates and focuses a new Session; `/follow-up <text>` remains a parameterized Core Action.
- Unknown slash text remains ordinary User Prompt text.
- Search is case-insensitive, ranks prefix matches before fuzzy subsequence matches, and shows a source label for every candidate.
- Core commands trigger only when `/` is the first Composer character. Skill/MCP references may also trigger at an inline whitespace boundary.
- Tab completes the highlighted candidate. Enter invokes a Core candidate or inserts an Extension Reference. Escape restores ordinary Prompt submission.
- Slash candidates use a borderless Pi-style upper list: `→` marks selection, source-tagged names and descriptions align as columns when space permits, and clipped lists show position/total.
- Auth, Model, Session, and nested forms share the same borderless upper-list Flow host.
- Model selection belongs to one Session; Provider configuration, Credentials, and the Model Catalog are global.
- An active Run keeps an immutable Model/Credential snapshot. A not-yet-started Follow-up resolves the latest state when its Run begins.
- `/session` switches focus only. Other live Session Runtimes continue Runs and Follow-ups in the background.
- Sessions are limited to the current Workspace. Cross-Workspace switching requires exiting Coda and restarting from the other directory.
- Graceful CLI exit cancels every Run and discards every pending Follow-up. Coda does not detach from the terminal.
- Custom Providers use one of `openai.chatcompletions`, `openai.responses`, or `anthropic.messages`, discover models through a protocol-defined endpoint, and preserve unknown metadata as unknown.
- Models with unknown metadata remain selectable through an explicit Compatibility Mode confirmation.
- Compatibility Mode keeps Provider metadata unknown while disclosing Coda's conservative local execution caps; those caps are constraints, not discovered capabilities or prices.
- Background MCP Elicitations mark their owning Session as `needs attention` and remain deferred until that Session receives focus.
- V1 defines Extension registration and reference tokens but does not implement a Skill/MCP loader or direct MCP Tool execution.
- Submitting a structured Extension Reference without a loader is blocked while preserving the exact Composer draft.

## Module seams

### Command Registry

`@coda/coding-agent` owns immutable command definitions, dynamic registration, collision-safe identity, availability, source labels, matching, and invocation effects. TUI primitives do not know command semantics.

### Command Composer

`@coda/coding-agent` composes the application-neutral Editor with slash parsing, suggestions, Flow navigation, Extension References, Prompt History, and submission policy. The upper drawer remains in the Composer dock so the Editor and candidate list share one input owner.

### Session Runtime Manager

One workspace-scoped manager owns all live Session Runtimes and the active focus. Each Runtime owns its Agent, Session, Input Queue Controller, Timeline, Composer, Model selection, and Run snapshot slot.

### Run Runtime Slot

The Coding Agent asynchronously prepares an immutable runtime before a Prompt or Follow-up Run starts. Stable Agent adapters read only the active slot for Stream and System Prompt behavior. Steering remains inside the current slot.

### Provider Manager

The Coding Agent owns non-secret Provider configuration, Credential operations, protocol-driven discovery, Model Catalog persistence, stale state, and deletion policy. `@coda/ai` owns Api adapters and prepared request dispatch.

## Persistence

- Non-secret Provider configuration and its discovered Model Catalog snapshot are atomically persisted in global settings.
- Credentials remain in an injected secure Credential Store; insecure plaintext fallback is forbidden.
- Session records continue to hide JSONL details behind the Session facade.
- Session v6 stores ordered Extension References in Composer Submission facts while v1-v5 remain readable.
- Draft Sessions and Composer drafts remain process-local until the first durable action materializes a Session.

## Deferred

- Cross-Workspace Session switching
- Session rename, delete, and archive
- Skill/MCP discovery and execution
- OAuth implementation
- Custom model-discovery paths
- Cross-Session file-write coordination, conflict detection, or warnings
- Detached or daemon Session execution

## Verification seams

- `CommandRegistry` registration, collision handling, availability, and ranked search
- `CommandParser` start-only Core recognition, inline Extension recognition, and raw Prompt fallback
- `CommandComposer` key behavior, exact draft restoration, and Extension marker invalidation
- `RunRuntimeSlot` current-Run immutability and next-Run refresh
- `ProviderManager` persistence, discovery, stale/unknown models, and secret handling
- `SessionRuntimeManager` focus switching, background progress, close, LRU, and shutdown
