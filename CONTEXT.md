# Coda

Coda is a local-first terminal coding agent built first for its creator's daily use, with a path toward public, cross-platform distribution.

## Language

**Coda**:
The product as a whole, including the terminal experience and the supporting packages that make it possible.
_Avoid_: Pi clone, generic agent SDK

**Coding Agent**:
The user-facing collaborator that works with a developer on a local codebase through conversation and tool-mediated actions.
_Avoid_: chatbot, AI wrapper

**Work Graph**:
A durable, Workspace-scoped orchestration of one coding objective into causally related Work Items whose independent items may proceed concurrently.
_Avoid_: Session, transcript, Run group, task list

**Work Item**:
One independently schedulable unit in a Work Graph, owned by exactly one Worker Runtime and settled with one Work Result.
_Avoid_: Run, Turn, subagent, thread

**Work Execution Mode**:
The `read_only` or `write` classification belonging to one Work Item.
_Avoid_: Process Confinement Mode, Approval Policy, sandbox mode

**Delegate**:
The parent-Run Tool through which a Worker Runtime admits child Work Items into the same Work Graph.
_Avoid_: subagent Tool, spawn, nested Agent

**Worker Runtime**:
A private Agent Runtime exclusively owned by one Work Item and attached to that Work Item's Session for its lifetime.
_Avoid_: child Agent, shared Runtime, worker process

**Workspace Ledger**:
The small durable record that transactionally coordinates facts which must be ordered across a Workspace: active Work Graph identities, Session ownership, Publication ordinals, and settled target identities.
_Avoid_: Work Graph history, Session journal, global event log

**Workspace Process Epoch**:
One live Coding Agent process's ownership scope over its active Work Graph stores and process-local coordination. Multiple epochs may share one Workspace without taking ownership of each other's live Work.
_Avoid_: Workspace lock, exclusive process lease, Session

**Work Graph Store**:
The isolated durable history of one Work Graph, composed of atomically appended Work Graph Fact segments and archived after terminal settlement.
_Avoid_: Workspace Ledger, Session journal, monolithic Work Journal

**Work Graph Fact**:
A versioned semantic fact in the closed algebra that defines durable Work Graph state and is interpreted identically during live execution and recovery.
_Avoid_: Worker Fact, Worker Observation, persistence payload

**Work Graph Aggregate**:
The authoritative immutable state obtained by applying a Work Graph's ordered Facts; runtime handles and process-local activity are not part of it.
_Avoid_: Coordinator state, mutable cache, recovery projection

**Worker Fact**:
A bounded semantic fact required to recover Work Item orchestration or to place Worker Control after a durable lifecycle point; it is the only Worker Runtime data nested in a Work Graph Fact.
_Avoid_: Worker Observation, Agent event, Session Record

**Worker Observation**:
A full-fidelity, best-effort projection of live Worker Runtime activity delivered through a bounded asynchronous sequencer and the Coding Agent Observation stream without entering Session or Work Graph persistence barriers.
_Avoid_: Worker Fact, Worker Control, event log

**Work Result**:
The structured settled outcome of one Work Item, including its Run Outcome, evidence, any Workspace Artifact, and whether its terminal boundary is durably confirmed or only process-local and unknown; assistant prose alone is not a Work Result.
_Avoid_: final message, summary, Run, Completion Disposition

**Workspace Placement**:
The resolved Workspace root in which one Work Item executes, together with its relationship to the source Workspace state.
_Avoid_: sandbox, current directory, process cwd

**Workspace Artifact**:
A recoverable, source-anchored representation of Workspace changes produced by one Work Item.
_Avoid_: assistant claim, diff preview, Tool output

**Publication**:
The explicit settlement that applies one or more Workspace Artifacts to their parent Workspace Placement or reports why they were not applied.
_Avoid_: Tool write, implicit merge, successful Run

**Publication Order**:
The immutable Workspace-wide ordinal reserved for one Work Item. It determines target-local Publication order within a Workspace Process Epoch; Publications from different epochs settle through serialized target mutation and artifact conflict detection.
_Avoid_: completion order, Graph-local sibling order, merge timestamp

**Agent**:
The serial kernel that owns one in-memory transcript, model turns, Tool execution, events, cancellation, and steering queues.
_Avoid_: Agent Runtime, Coding Agent, TUI, Session store

**Agent Runtime**:
The private per-Work-Item composition of an Agent with Model and authentication selection, Run preparation, Tools, Skills and MCP snapshots, Session persistence, Context Window recovery, events, and lifecycle cleanup.
_Avoid_: public Coding Agent Interface, Agent, CLI application, TUI controller

**Prepared Run**:
The immutable execution capability frozen exactly once before a Run starts, including its Run Capability Lease and failed-Attempt recovery state.
_Avoid_: desired configuration, Run Runtime Slot, live catalog

**Run Capability Lease**:
The executable Model driver, Tools, deterministic prompt contributions, and exact catalog revisions retained for one Run until that Run disposes them.
_Avoid_: capability snapshot, live registry, generic plugin container

**Desired Runtime Configuration**:
The mutable selection intended for the next Run of one Worker Runtime; changes never alter its active Prepared Run. A child Work Item inherits omitted fields from its parent, and inherits the parent Model when a requested Model cannot be resolved.
_Avoid_: Prepared Run, global selected Model

**Run**:
One settled Agent operation beginning with accepted input and ending after its serial lifecycle and fatal Session barriers; presentation observations are outside that boundary.
_Avoid_: Session, process

**Run Outcome**:
The Agent lifecycle settlement of one Run: `success`, `error`, or `aborted`.
_Avoid_: Completion Disposition, Work Result, verified

**Run Budget**:
An immutable per-Run set of execution limits whose accounting includes every Attempt and Tool Invocation, including discarded retries.
_Avoid_: timeout, quota, Session limit, Run Control

**Run Control**:
An optional two-phase wall-clock envelope on one Run, independent of Run Budget, consisting of a work window, a finalization grace, and an optional stationary-Turn trigger.
_Avoid_: Run Budget, timeout, quota

**Turn**:
One assistant response together with the complete batch of Tool Invocations requested by that response.
_Avoid_: Run, Message

**Steering**:
Input queued for the current Run and injected at its next safe model-call boundary without interrupting active Tool Invocations.
_Avoid_: Follow-up, interrupt

**Follow-up**:
Input queued to begin a new Run after the current Run settles.
_Avoid_: Steering, retry

**Paused Follow-up**:
A durable Follow-up that remains queued after restore, abort, interruption, or an earlier Run failure and requires an explicit resume before it can start.
_Avoid_: draft, failed Run, Steering

**Recoverable Follow-up**:
The Session projection used to present and reclaim a Paused or failed Follow-up together with its original content and Attachments.
_Avoid_: Agent Seed, retry, transcript Message

**Composer**:
The Coding Agent's bottom-docked input experience that combines the generic Editor with Attachments, queue commands, Reasoning-level styling, and submission policy.
_Avoid_: Editor, Prompt Builder, User Message

**Slash Command**:
A registered `/name` Composer invocation, distinct from ordinary Prompt text and from `$` Skill or MCP Mentions.
_Avoid_: Skill Mention, MCP Mention

**Composer Submission**:
A durable fact that the interactive Composer accepted model-directed input, preserving the text as edited independently from when or whether the Agent later consumes it.
_Avoid_: Message, Follow-up lifecycle, Shell command

**Prompt History**:
The current Session's ordered projection of active Composer Submissions, replayed directly into the Editor without creating Timeline UI.
_Avoid_: Session transcript, draft store, User Shell history

**Editor**:
The application-neutral TUI component that owns text-buffer editing, wrapping, cursor placement, paste folding, and editor key behavior without knowledge of Agents or Sessions.
_Avoid_: Composer, prompt card

**Work Item Input**:
A serializable public command that delivers Prompt, Steering, or Follow-up content and opaque resource references to one Work Item without exposing its Worker Runtime or resource transactions.
_Avoid_: Runtime input queue, Composer Submission, cross-Work-Item message

**Worker Control**:
An ordered, failure-isolated control projection that may submit a Work Item Input before later Agent progression, used for causal policies such as bounded completion repair after the lifecycle Fact is durable.
_Avoid_: Observation, persistence barrier, direct Agent access

**Interactive Input Adapter**:
The Coding Agent UI adapter that owns local Composer/User Shell ordering, translates model-directed input into Work Item commands, and projects isolated observations into presentation state. Child Worker Observations reach the focused parent Session's Timeline, Transcript View, Activity, Command Permission, and MCP Elicitation without being replayed as the parent Run.
_Avoid_: Work Coordinator, Worker Runtime, Composer

**User Shell**:
An explicit `!command` submitted by the user for local host execution outside model Context, Prompt History, and Session persistence.
_Avoid_: bash Tool, Tool Invocation, Prompt

**Process Session**:
A bounded, non-interactive background process owned by its creating Session and addressed through opaque process-local identity while that Session remains open.
_Avoid_: User Shell, terminal Session, restorable job

**Tool Invocation**:
One Agent-owned attempt to validate and execute a model-requested Tool call, identified independently from the Provider's tool-call identifier.
_Avoid_: Tool, shell command

**Tool Observation**:
The authoritative structured account of a Tool operation's status, completeness, safe facts, and any continuation reference, distinct from both its output data and how execution settled.
_Avoid_: Tool output, details, isError

**Tool Settlement**:
The executor boundary outcome stating whether a Tool returned, threw, or was aborted, independent of whether the returned operation itself succeeded or failed.
_Avoid_: Tool Observation, exit status, Tool result

**Lifecycle Hook**:
A user-configured reaction at a named Coding Agent lifecycle boundary that may contribute context, guard an operation, or request continued work according to that boundary's contract. Codex `SubagentStart` and `SubagentStop` names mark child Work Item running and terminal boundaries; they are not a separate subagent entity.
_Avoid_: Tool, plugin, event listener, subagent

**Hook Handler Trust**:
The decision to execute one exact Lifecycle Hook handler revision (exact-handler trust); changing the handler invalidates the decision without disabling unrelated handlers.
_Avoid_: Project Trust, MCP Server Trust

**Command Permission**:
The decision to allow, deny, or ask before one Tool Invocation executes, independent of Hook Handler Trust and of whether the later process is confined.
_Avoid_: approval, shell permission, Project Trust

**Approval Policy**:
The Command Permission rule that chooses when a Tool Invocation may ask: untrusted, on-request, or never.
_Avoid_: permission enabled flag, permission mode, YOLO as the name of this rule

**Process Confinement**:
OS-level restriction of one spawned Shell process tree's filesystem and network access, applied only to descendant processes.
_Avoid_: sandbox when referring to Workspace Placement or worktrees
_Avoid_: Project Trust, configuration-file trust, shell permission

**Process Confinement Mode**:
The Process Confinement rule that chooses writable scope: read-only, workspace-write, or danger-full-access.
_Avoid_: sandbox mode when referring to Workspace Placement; permission profile

**MCP Host**:
The Coding Agent facility that discovers and invokes Tools offered by configured external MCP Servers.
_Avoid_: MCP Server, plugin host, Extension loader

**MCP Server Definition**:
A user- or Workspace-scoped declaration with stable identity, transport, protocol policy, and Tool visibility rules for one external MCP Server.
_Avoid_: connection, Tool Catalog, credential

**MCP Server Trust**:
The decision to admit MCP Server Definitions from one exact Workspace configuration revision; it is independent of later Tool calls.
_Avoid_: Project Trust, MCP Tool Snapshot

**MCP Tool Catalog**:
The deterministic, diagnostic-bearing collection of Tools discovered from the currently ready MCP Servers.
_Avoid_: Tool Snapshot, MCP Server Definition, Model Catalog

**MCP Tool Snapshot**:
The immutable model-visible projection of one MCP Tool Catalog frozen for a Run.
_Avoid_: MCP Tool Catalog, live Server state

**MCP Mention**:
An explicit `$name` token that admits one MCP Tool or every Tool from one MCP Server into this Run's MCP Tool Snapshot. A short name shared with a Skill resolves to the Skill.
_Avoid_: auto-exposed MCP Tool, Slash MCP, plugin invocation

**MCP Elicitation**:
A Server-identified request for explicit user input while an MCP Tool Invocation is active, answered with accept, decline, or cancel.
_Avoid_: model prompt, OAuth callback

**Attempt**:
One model invocation within a Turn; transient failure may lead to a later Attempt without replaying completed Tool Invocations.
_Avoid_: Retry, Turn, Run

**Session**:
A workspace-scoped, resumable append-only record spanning one or more Runs. Its foundation port and application journal are two depths of the same object; lease ownership is external to it.
_Avoid_: Run, transcript, process

**Session Title**:
A short, durable, model-generated label for one Session, used by Session pickers instead of the first Prompt. It is not a Compaction summary and is not the Session identity.
_Avoid_: first Prompt, thread name, preview, summary

**Agent Seed**:
Validated, immutable state used to initialize an idle Agent from a Session without exposing persistence records or reducer internals.
_Avoid_: Session log, Agent event

**Session Record**:
One member of the closed, versioned semantic fact algebra appended to a Session's linear history and linked to the immediately preceding Record.
_Avoid_: Agent event, JSON line

**Run Evidence**:
A bounded, sanitized projection of one settled Run's lifecycle and authoritative Tool Observations, suitable for presentation and evaluation without treating assistant claims as proof.
_Avoid_: transcript summary, log, benchmark score

**Completion Disposition**:
The versioned print/JSON verdict of one settled Run (`verified`, `partial`, `blocked`, or `unverified`), independent of Run Outcome.
_Avoid_: Run Outcome, Work Result, assistant "done" claim

**Interrupted Tool Invocation**:
A journaled Tool Invocation whose execution began but whose outcome was not durably recorded, leaving its external side effects unknown.
_Avoid_: failed Tool, pending Tool

**Timeline**:
The ordered interactive presentation of committed Messages, Thinking Blocks, Tool Invocations, and process-local User Shell activity, including transient active state. Under an in-progress parent `delegate`, it also projects each child Work Item's objective, executionMode, live state, current Tool, and terminal Work Result, attributed to that child's identity.
_Avoid_: Session, transcript, event log

**Transcript View**:
The full-detail projection of a Timeline, including complete model-visible Tool results that the compact Timeline previews or truncates.
_Avoid_: Session history, raw Provider log

**Thinking Block**:
Assistant content explicitly identified by the Provider as model reasoning, distinct from the requested Reasoning selection and from final Assistant text.
_Avoid_: reasoning level, hidden state

**Media Asset**:
A validated, content-addressed image owned by a Session and referenced by User or Tool Result content without embedding its bytes in the Session journal.
_Avoid_: attachment file, base64 payload

**Attachment**:
A staged Media Asset selected for the next User Message; it becomes Session-owned only when that Message commits.
_Avoid_: prompt token, inline image

**Workspace**:
The canonical filesystem root that scopes a Coding Agent's Session, project context, and relative Tool paths.
_Avoid_: current directory, repository

**Project Trust**:
The known or unknown decision to load a specific version of Workspace instructions into model Context; it never changes how Tools execute.
_Avoid_: MCP Server Trust, Tool Invocation

**Skill**:
A portable instruction bundle rooted at an Agent Skills-compatible `SKILL.md`, with optional files that remain inert until explicitly read or invoked through ordinary Tools.
_Avoid_: command, plugin, Tool

**Skill Candidate**:
One discovered version of a Skill with canonical identity, content revision, and source provenance, before precedence and model visibility are applied.
_Avoid_: loaded Skill, catalog entry

**Skill Inventory**:
The deterministic collection of discovered Skill Candidates and diagnostics produced by one refresh.
_Avoid_: Skill Catalog, Skill Snapshot

**Skill Snapshot**:
The immutable set of resolved Skill Candidates and name resolutions frozen for one Run.
_Avoid_: Skill Inventory, watcher cache

**Skill Catalog**:
The bounded model-visible projection of one Skill Snapshot: Skills that allow implicit invocation, listed with name, description, and a `SKILL.md` locator, without Skill bodies. Slash-only Skills stay in the Composer `$` palette and can be `$`-injected.
_Avoid_: Model Catalog, Skill Inventory

**Skill Activation**:
The exact-revision Skill body, base directory, arguments, and bounded resource references loaded through an explicit user reference or model Tool Invocation.
_Avoid_: script execution, Skill Catalog, Tool execution

**Skill Mention**:
An explicit `$name` token that selects a Skill for this Run's user-selected context.
_Avoid_: Slash Skill, auto-loaded Skill body, @skill

**Prompt Builder**:
The versioned private Worker Runtime component that deterministically assembles one Run's System Prompt from Run Capability contributions, Workspace facts, and trusted project instructions.
_Avoid_: Provider prompt, Agent global prompt

**Capability Manifest**:
The generated, versioned inventory that combines hand-reviewed product capability classifications with executable runtime facts and verification sources.
_Avoid_: roadmap, package export list, hand-written status page

**Context Overflow**:
A model request that cannot fit within the selected Model's usable context window after accounting for Messages, Tools, and reserved output.
_Avoid_: compaction, truncation

**Context Window**:
The model-visible conversation projection carried across model invocations, distinct from the complete Session history and from the one-invocation Context assembled from it.
_Avoid_: Session, transcript, Context

**Compaction**:
A loss-aware transition that creates a new Context Window from a structured summary and an exact recent Message tail without rewriting the Session's durable history.
_Avoid_: truncation, pruning, new Session

**Auto-Compaction**:
The private Worker Runtime behavior that requests Compaction at a safe model-call point when the active Context Window reaches its configured threshold or no longer fits the selected Model.
_Avoid_: automatic truncation, background summary, retry

**Compaction Checkpoint**:
The durable Session fact that identifies a Context Window and deterministically describes its replacement Message history and the Session history it covers.
_Avoid_: summary, Session snapshot, backup

### Model access

**Api**:
A wire protocol used to exchange model requests and responses. A Provider may support more than one Api.
_Avoid_: Provider, model service

**Provider**:
A model-service integration identified by its authentication methods, model catalog, and streaming behavior.
_Avoid_: Api, Model

**Model**:
A serializable description of a model offered by a Provider through an Api, including its identity, capabilities, and limits.
_Avoid_: Provider, runtime adapter

**Models**:
The runtime registry that binds Providers, credentials, model catalogs, and request dispatch.
_Avoid_: model list, catalog

**Model Catalog**:
The collection of serializable Model descriptions offered by a Provider at a recorded point in time.
_Avoid_: Models, runtime registry

**Model Metadata**:
A source-labelled Model fact such as context limit, output limit, input modality, reasoning support, status, or tiered price, resolved field by field without fabricating Provider claims.
_Avoid_: runtime default, Provider response, settings blob

**Api Adapter**:
The runtime implementation that translates a provider-neutral invocation to one Api and normalizes its response into an Event Stream.
_Avoid_: Provider, SDK

**Credential**:
Provider-scoped secret material used to authenticate model requests.
_Avoid_: API key when referring to credentials generally

**Credential Store**:
The caller-supplied source of persisted Credentials; it does not prescribe where or how secrets are stored.
_Avoid_: auth file, keychain

### Model interaction

**Context**:
The complete provider-neutral input to one model invocation: a system prompt, Messages, and available Tools.
_Avoid_: Session, transcript

**Message**:
A provider-neutral conversation item attributed to a user, an assistant, or a tool result.
_Avoid_: Event

**Tool**:
A model-visible declaration of an operation and its input schema, without the behavior that executes the operation.
_Avoid_: tool implementation, command

**Usage**:
The normalized accounting of model input, output, cache, and reasoning consumption for a response.
_Avoid_: cost

**Assistant Message Event**:
An incremental observation that builds an assistant Message and ends in exactly one successful or failed terminal outcome.
_Avoid_: Message, callback

**Event Stream**:
The ordered sequence of Assistant Message Events produced by one model invocation.
_Avoid_: transcript, event bus

**Diagnostic**:
Structured, persistence-safe metadata attached to a failed assistant Message to preserve error classification and context without changing the terminal event shape.
_Avoid_: log line, thrown error
