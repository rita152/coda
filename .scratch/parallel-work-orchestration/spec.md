# Parallel Work Orchestration

Status: accepted

## Goal

Replace Coda's accidental overlap of independent Agent Runtime instances with one durable, bounded, observable Work Graph that can schedule independent Work Items concurrently, preserve causality, isolate each worker's Session, coordinate Workspace effects, aggregate structured results, survive interruption, and support delegation from an active Agent.

This is a destructive refactor. There is no compatibility requirement for the existing `CodingAgentRuntime`, `AgentRuntime`, `RuntimeInputLifecycle`, `openAgentRuntime`, or `openCodingAgentRuntime` public surfaces.

## Non-goals

- sandboxing, approval, policy prompts, or privilege separation
- downloading or dynamically trusting third-party Extension code
- automatic rollback of Tool, Shell, Process, MCP, or Publication effects
- compatibility wrappers or deprecated aliases for the old Runtime Interface
- making the serial Agent kernel concurrent

## Required architecture

### Ownership

- One public headless Coding Agent instance is scoped to one source Workspace and owns zero or more active Work Graphs.
- One Work Graph represents one coding objective and owns a durable Work Journal.
- One Work Item owns exactly one Worker Runtime, one Session, one Workspace Placement, and one terminal Work Result.
- A Worker Runtime contains one serial Agent. It may execute multiple serial Runs through Steering and Follow-ups, but no second Run overlaps it.
- One interactive user operation is one Work Graph. A later user operation may start a new Work Graph that resumes the same durable Session only after the earlier root Work Item has settled and released its exclusive Session lease.
- Child Work Items create distinct worker Sessions by default. They never append to the root Session.
- Runtime identities are diagnostic metadata. Callers control Work Graph and Work Item identities only.
- A Session is never shared between Work Items. Cross-worker causality belongs exclusively to the Work Journal.

### Public Interface

`@coda/runtime` must export one construction function and the data types required by this Interface. It must not export Worker Runtime construction, input queues, executable Prepared Run snapshots, Context Window controllers, or Agent instances.

```ts
interface CodingAgent {
  submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt>;
  observe(options?: ObservationOptions): AsyncIterable<CodingAgentObservation>;
  close(): Promise<CodingAgentCloseResult>;
}

type CodingAgentCommand =
  | StartWorkGraph
  | AddWorkItems
  | DeliverWorkItemInput
  | ConfigureWorkItem
  | CancelWork;
```

The command algebra is closed, discriminated, serializable, and exhaustively handled. `dispatch(any)` is forbidden.

`StartWorkGraph` contains the objective, root Work Item, maximum concurrency, desired Runtime configuration, a `create` or `resume` Session target, and an optional caller-supplied graph identity. Resuming a Session already leased by another Work Item fails before graph acceptance. `AddWorkItems` atomically adds a batch with stable item identities, a parent Work Item, dependencies, objectives, and `read_only` or `write` execution mode. Dependencies may reference existing items or earlier items in the same accepted batch; cycles and duplicate identities reject the whole batch before any item becomes visible.

`DeliverWorkItemInput` preserves explicit Prompt, Steering, and Follow-up semantics without exposing resource transactions. Input resources are opaque references resolved and committed by the Runtime Module. `ConfigureWorkItem` changes only the desired configuration for later Runs. `CancelWork` targets a graph or item and cascades through descendants.

`submit()` first validates and reserves all identities, Sessions, input resources, and Workspace Placements for the batch. Acceptance is atomic; execution is not. Its receipt distinguishes acceptance failure from asynchronous Work settlement.

Every `observe()` iterator begins with a frozen data-only snapshot and then receives monotonically sequenced observations. Slow consumers receive `resync_required`; they never participate in Run or Work Journal barriers. Observations may expose graph, item, runtime, session, Run, Tool, result, and Publication identities, but never executable Tool, Skill, MCP, Model, or dispose capabilities.

`close()` is idempotent: reject new batches, cancel graphs, await cancellation settlement, roll back unaccepted resources, quiesce Session-owned Processes where possible, close all Worker Runtimes and Sessions once, flush Work Journals, and return dropped/unknown work metadata.

### Work Graph state model

Work Item states are:

```text
pending -> ready -> preparing -> running -> settling -> succeeded
                                             |          failed
                                             |          canceled
                                             +-------> interrupted
pending/ready ------------------------------> blocked
```

- An item becomes `ready` only when every dependency succeeded and its parent permits execution.
- A failed, canceled, interrupted, or blocked dependency blocks dependent items. Independent siblings continue.
- Ready items are selected deterministically by accepted source order, subject to graph and process-wide concurrency limits.
- Completion order never changes result or Publication order.
- A graph settles only when its root and all accepted descendants are terminal and no delegation batch is being accepted.
- Graph outcome is `succeeded`, `partial`, `failed`, `canceled`, or `interrupted`; it is not inferred from the root assistant message.
- Cancellation is idempotent and cascades to descendants. It prevents later Publication but does not claim to undo prior effects.

### Delegation

Add one built-in `delegate` Tool available to write-capable coordinator workers. It accepts a bounded batch of child Work Item specifications and optional dependency edges, submits them through the same Work Graph command path, waits for their structured Work Results, and returns a bounded model-visible projection.

The Tool is bound to the invoking graph and parent Work Item. It cannot name another graph, Worker Runtime, or Session. Delegation does not create Agents directly. Nested delegation is supported and uses the same concurrency budget, cancellation tree, Work Journal, and Workspace Execution Seam.

The delegate Tool itself holds no Workspace mutation lease while waiting. This prevents deadlock in the Direct Adapter.

### Prepared Run and input lifecycle

- Worker Runtime is private Implementation inside `@coda/runtime`.
- One host-only `Submission` envelope carries model-visible input, Work Graph and Work Item causality, input-resource references, and an opaque preparation identity.
- Remove content hashing and in-band Skill snapshot binding.
- Preparation is an explicit observable phase with `AbortSignal` and deadline; close and cancellation abort it.
- Prepared Run executable capabilities are private and disposed exactly once after final barriers.
- Public snapshots contain only descriptors: model identity, prompt digest, contribution revisions, Tool descriptors, budget, and state.

### Event and persistence semantics

Two internal channels are mandatory:

1. Ordered fatal barriers: Worker Session append, input-resource commit/rollback, Work Journal transition, and Publication transition.
2. Isolated observations: TUI, print/JSON, eval projection, telemetry, and future Extension projections.

Barrier failure stops later effects and yields `failed` or `interrupted` according to whether an external effect may already have begun. Observation failure is diagnosed and detached or resynchronized; it cannot abort a Run or Work Graph.

A callback that can causally submit Steering is Worker Control, not an Observation. Completion repair may use one ordered Worker Control hook after the lifecycle event is journaled; the hook may delay later Agent progression so its Work Item command is accepted, but its failure is diagnosed and detached rather than converted into a persistence failure. Presentation, JSON, eval, telemetry, and Extension consumers remain on the isolated Observation channel and are never awaited by the Run or Work Journal barriers.

The Work Journal records accepted graph/item definitions, dependency edges, state transitions, Worker Runtime and Session ownership, placement base identity, Run Results, Run Evidence, Workspace Artifacts, Publication attempts/outcomes, cancellation, and interruption. On recovery, `preparing`, `running`, `settling`, or publishing work is marked interrupted and never replayed automatically.

### Workspace Execution Seam

Define one internal `WorkspaceExecution` Interface with at least two production Adapters and a deterministic in-memory test Adapter.

The Interface must place one Work Item relative to its parent placement, bind all File/Shell/Process Tools to that placement, classify Tool Invocations as read, write, or unknown, acquire/release concurrency leases, capture a source-anchored Workspace Artifact, publish artifacts into the parent placement, preserve recoverable artifacts on failure, and close idempotently.

#### Direct Adapter

- Read Tool Invocations may overlap under a Workspace read lease.
- Write and unknown Tool Invocations use one Workspace-wide FIFO write lease.
- `bash`, mutable/unknown MCP Tools, User Shell, and Process start/write default to unknown/write.
- A background Process retains its lease until exit, stop, timeout, or explicit interrupted settlement.
- Native mutation Tools share one Workspace-owned mutation coordinator; Tool factories never create private coordinators.
- Leases are acquired per Tool Invocation, not for the entire Run, so a parent can wait on delegated children without deadlock.
- This guarantees only Coda single-writer behavior; IDEs and external processes may still race.

#### Git worktree Adapter

- A write Work Item receives a derived worktree from its parent placement's frozen base state.
- File, Shell, Process, evidence, and Session metadata all bind to that derived placement.
- The Adapter captures a commit or equivalent recoverable artifact before cleanup.
- Sibling artifacts publish into the parent placement in accepted source order, never completion order.
- Conflict or changed-source precondition leaves the parent placement unchanged and returns a recoverable `not_published` result.
- Nested delegation publishes children into the invoking worker's placement before its Work Result settles.
- Worktrees and failed artifacts survive interruption until the Work Journal records explicit cleanup.
- A worktree is not described as sandbox or security isolation.

`read_only` workers receive a Tool catalog that excludes write, Shell, Process, and unknown-effect contributions. `write` workers receive the normal catalog and use the selected placement Adapter.

### Structured results

`WorkResult` must contain item identity, parent/dependencies, Runtime and Session identities, terminal state, Run Result, Run Evidence, Workspace Artifact/Publication outcome, diagnostics, timing, and budget usage. Assistant text is one field, never the success criterion.

Graph results preserve accepted source order and include effective concurrency, blocked dependency reasons, cancellation/interruption metadata, and final Publication state.

### Package and caller migration

- Keep `@coda/agent` provider-neutral and serial.
- Make `@coda/runtime` the deep public headless Module with `openCodingAgent()` and the three-entry-point Interface.
- Keep Skills and MCP as leaf Modules; adapt their Tools into per-Run contribution snapshots internally.
- Move Node filesystem, Git worktree, Process, durable Session, Media, and project-instruction behavior into `@coda/coding-agent` Adapters injected at construction.
- Interactive, print, eval, and the delegation Tool use the same public Interface.
- Foreground pane focus stays in the TUI Adapter and never becomes a scheduler invariant.
- Delete duplicate primary/secondary Runtime composition and all obsolete public Runtime exports, tests, and compatibility types.

## Required contract tests

- deterministic DAG scheduling and source-order results under randomized completion order
- concurrency caps shared by root and nested delegated work
- atomic batch rejection for duplicate ids, missing dependencies, cycles, resource failure, and Session/placement reservation failure
- one Worker Runtime and one Session per Work Item; sharing is rejected
- Desired Runtime Configuration affects only later Runs
- cancellation during pending, preparation, Model stream, Tool execution, delegation wait, Process lifetime, and Publication
- failed dependency blocks descendants while independent siblings continue
- Direct Adapter concurrent reads and globally serialized write/unknown Tool Invocations
- no Direct Adapter deadlock when a parent waits on delegated write children
- shared mutation coordinator across Worker Runtimes
- Process lease persists until quiescence
- worktree sibling isolation, deterministic Publication, conflict preservation, nested Publication, and changed-source detection
- barrier failure versus observation failure isolation
- data-only public snapshots with no executable capabilities
- Work Journal recovery marks uncertain work interrupted and never auto-replays it
- interactive, print, eval, and delegate Tool all cross the same public Seam
- public exports contain no old Runtime factories or compatibility aliases

## Completion criteria

- Repository typecheck, lint, and test suite pass.
- Old public Runtime Interface and its tests are deleted, not wrapped.
- No application caller constructs Agent, Worker Runtime, RuntimeInputQueue, Context Window controller, or Prepared Run capabilities.
- No Workspace mutation coordinator is constructed per Worker Runtime.
- Runtime ids never appear in command targets.
- The capability manifest and relevant docs describe coordinated parallel Work Items rather than merely concurrent Runtime instances.
- `git status` contains only intentional implementation and design changes.
