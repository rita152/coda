# Coda

Coda is a local-first terminal coding agent built first for its creator's daily use, with a path toward public, cross-platform distribution.

## Language

**Coda**:
The product as a whole, including the terminal experience and the supporting packages that make it possible.
_Avoid_: Pi clone, generic agent SDK

**Coding Agent**:
The user-facing collaborator that works with a developer on a local codebase through conversation and tool-mediated actions.
_Avoid_: chatbot, AI wrapper

**Agent**:
The headless runtime that owns an in-memory transcript, model turns, tool execution, events, cancellation, and steering queues.
_Avoid_: Coding Agent, TUI, session store

**Run**:
One settled Agent operation beginning with accepted input and ending only after its final event observers complete.
_Avoid_: Session, process

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

**Composer Submission**:
A durable fact that the interactive Composer accepted model-directed input, preserving the text as edited independently from when or whether the Agent later consumes it.
_Avoid_: Message, Follow-up lifecycle, Shell command

**Prompt History**:
The current Session's ordered projection of active Composer Submissions, replayed directly into the Editor without creating Timeline UI.
_Avoid_: Session transcript, draft store, User Shell history

**Editor**:
The application-neutral TUI component that owns text-buffer editing, wrapping, cursor placement, paste folding, and editor key behavior without knowledge of Agents or Sessions.
_Avoid_: Composer, prompt card

**Input Queue Controller**:
The Coding Agent module that coordinates Composer acceptance, media preparation, Agent queue mutation, User Shell scheduling, durable Session facts, resume, reclaim, and compensation across one deferred FIFO.
_Avoid_: Agent queue, Chat component, Session reducer

**User Shell**:
An explicit `!command` submitted by the user for local host execution outside model Context, Tool policy, Prompt History, and Session persistence.
_Avoid_: bash Tool, Tool Invocation, Prompt

**Tool Invocation**:
One Agent-owned attempt to validate, authorize, and possibly execute a model-requested Tool call, identified independently from the Provider's tool-call identifier.
_Avoid_: Tool, shell command

**MCP Host**:
The Coding Agent facility that discovers and invokes Tools offered by configured external MCP Servers.
_Avoid_: MCP Server, plugin host, Extension loader

**MCP Server Definition**:
A user- or Workspace-scoped declaration with stable identity, transport, protocol policy, and Tool visibility rules for one external MCP Server.
_Avoid_: connection, Tool Catalog, credential

**MCP Server Trust**:
The decision to admit MCP Server Definitions from one exact Workspace configuration revision; it is independent of Tool execution authority.
_Avoid_: Project Trust, Permission Profile, Tool approval

**MCP Tool Catalog**:
The deterministic, diagnostic-bearing collection of Tools discovered from the currently ready MCP Servers.
_Avoid_: Tool Snapshot, MCP Server Definition, Model Catalog

**MCP Tool Snapshot**:
The immutable model-visible projection of one MCP Tool Catalog frozen for a Run.
_Avoid_: MCP Tool Catalog, live Server state

**MCP Elicitation**:
A Server-identified request for explicit user input while an MCP Tool Invocation is active, answered with accept, decline, or cancel.
_Avoid_: Approval Request, model prompt, OAuth callback

**Attempt**:
One model invocation within a Turn; transient failure may lead to a later Attempt without replaying completed Tool Invocations.
_Avoid_: Retry, Turn, Run

**Session**:
A workspace-scoped, resumable record spanning one or more Runs.
_Avoid_: Run, transcript, process

**Agent Seed**:
Validated, immutable state used to initialize an idle Agent from a Session without exposing persistence records or reducer internals.
_Avoid_: Session log, Agent event

**Session Record**:
An immutable semantic fact appended to a Session's linear history and linked to the immediately preceding Record.
_Avoid_: Agent event, JSON line

**Interrupted Tool Invocation**:
A journaled Tool Invocation whose execution began but whose outcome was not durably recorded, leaving its external side effects unknown.
_Avoid_: failed Tool, pending Tool

**Timeline**:
The ordered interactive presentation of committed Messages, Thinking Blocks, Tool Invocations, and process-local User Shell activity, including transient active state.
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

**Policy Gate**:
The Coding Agent seam that resolves the authority for a model-requested Tool Invocation and, when policy permits, routes an Approval Request before execution.
It never mediates a User Shell command, whose leading `!` is the user's direct authorization.
_Avoid_: Sandbox, Agent hook, User Shell confirmation

**Permission Profile**:
The effective filesystem and network authority assigned to model-requested work. Coda's built-in Permission Profiles are Read Only, Workspace, and Full Access.
_Avoid_: trust level, Approval Policy, Sandbox mode

**Session Permission Selection**:
A Session-owned choice of one built-in Permission Profile, distinct from the resolved authority frozen for a Run and from every grant or approval.
_Avoid_: Permission audit, Session Approval, restored grant

**Approval Policy**:
The rule that decides when model-requested authority must be reviewed. The four policies are Unless Trusted, On Request, Granular, and Never.
_Avoid_: Permission Profile, trust level, prompt mode

**Approval Request**:
A request to grant a precisely described command, filesystem, or network authority that the current Policy Decision does not already allow.
_Avoid_: confirmation dialog, Sandbox escape, Path Grant

**Additional Permission**:
A model-declared, narrowly scoped extension to the current Permission Profile for one Tool Invocation.
_Avoid_: Full Access, Path Grant, implicit retry

**Session Approval**:
A process-local approval remembered until the current Coda process exits. A command Session Approval uses a displayed, validated token prefix bound to its effective Sandbox context and executable identity; reuse suppresses only the matching prompt and never changes execution authority.
_Avoid_: persistent rule, Run grant, trust

**Command Rule**:
A persistent ordered-prefix decision used to allow, prompt for, or forbid matching model-requested commands.
_Avoid_: shell alias, Session Approval, network rule

**Network Rule**:
A persistent host decision used by managed network access to allow, prompt for, or forbid matching destinations.
_Avoid_: firewall rule, Command Rule, Session Approval

**Sandbox**:
The operating-system-enforced execution environment that limits model-requested processes to their effective Permission Profile and Additional Permissions.
_Avoid_: Policy Gate, command classifier, User Shell

**Workspace**:
The canonical filesystem root that scopes a Coding Agent's Session, project context, and default Tool authority.
_Avoid_: current directory, repository

**Project Trust**:
The known or unknown decision to load a specific version of Workspace instructions into model Context. Its status participates in default Permission Profile selection but is never itself execution authority.
_Avoid_: Permission Profile, Additional Permission, Approval Policy

**Skill**:
A portable instruction bundle rooted at an Agent Skills-compatible `SKILL.md`, with optional files that remain inert until explicitly read or invoked through ordinary Tools.
_Avoid_: command, plugin, permission

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
The bounded model-visible projection of one Skill Snapshot containing invocation identity and discovery metadata but not Skill bodies.
_Avoid_: Model Catalog, Skill Inventory

**Skill Activation**:
The exact-revision Skill body, base directory, arguments, and bounded resource references loaded through an explicit user reference or an authorized model Tool Invocation.
_Avoid_: script execution, Skill Catalog, permission grant

**Prompt Builder**:
The versioned Coding Agent component that deterministically assembles one Run's system prompt from application policy, runtime capabilities, Workspace facts, and trusted project instructions.
_Avoid_: Provider prompt, Agent global prompt

**Policy Decision**:
An explicit outcome that allows, rejects, or aborts model-requested work, optionally remembering or persisting the precisely displayed authority.
_Avoid_: trust, Permission Profile, Sandbox

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
The Coding Agent entry point that requests Compaction at a safe model-call point when the active Context Window reaches its configured threshold or no longer fits the selected Model.
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
