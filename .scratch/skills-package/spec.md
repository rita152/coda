# Agent Skills Loading and Product Integration

Status: Confirmed, revised 2026-08-10

## Objective

Add a private `@coda/skills` package and complete Coda's local Agent Skills lifecycle. The sole portability target is
the neutral [Agent Skills specification](https://agentskills.io/specification) and its official client implementation
guide. Client-specific formats, roots, manifests, and invocation fields are intentionally unsupported.

Remote registries, installation, download, update, dependency resolution, and content signing remain out of scope.

## Authority and baseline

The sources have three distinct roles:

1. The Agent Skills specification defines the portable directory and `SKILL.md` format.
2. The official client guide provides non-normative discovery, compatible parsing, progressive-disclosure, collision,
   and trust guidance.
3. This document defines Coda product policy where the standard intentionally leaves a choice to clients.

The reviewed upstream baseline is `agentskills/agentskills` commit
`69ef37e9424c0a7ea9dd2293b559e43ec8176379`. Codex, Pi, Grok Build, OpenCode, and desktop checkouts are neither
compatibility references nor build/runtime dependencies.

## Standard format contract

A Skill is a directory containing an exact `SKILL.md`. It may contain any other files and directories; `scripts/`,
`references/`, and `assets/` are recommended conventions rather than an exhaustive allowlist.

`SKILL.md` is YAML frontmatter followed by unrestricted Markdown instructions. Coda recognizes exactly these standard
frontmatter fields:

| Field | Requirement |
| --- | --- |
| `name` | Required; 1–64 Unicode lowercase alphanumeric characters and single hyphens; no leading, trailing, or consecutive hyphens; normalized value matches the parent directory |
| `description` | Required, non-empty, at most 1,024 characters; describes what the Skill does and when to use it |
| `license` | Optional string naming a license or bundled license file |
| `compatibility` | Optional non-empty string of at most 500 characters |
| `metadata` | Optional mapping from string keys to string values; the standard extension point |
| `allowed-tools` | Optional space-separated string; experimental |

Unknown top-level fields are not part of the format. Compatible loading ignores them with diagnostics; strict
validation rejects them. Coda does not expose an arbitrary top-level extension bag. In particular, it does not
interpret `disable-model-invocation`, `user-invocable`, `argument-hint`, `model`, `effort`, `when-to-use`, `paths`, or
any companion `agents/openai.yaml` file. A file with that name, if present, is only an ordinary bundled resource.

`allowed-tools` is preserved as experimental metadata. Coda does not interpret it or change Tool behavior from it.

## Package boundary

`@coda/skills` is a leaf package with no dependency on another `@coda/*` package. It owns:

- line-aware, data-only YAML frontmatter parsing;
- an official compatible-loading profile and independent strict validator;
- caller-supplied, bounded local discovery;
- canonical identity, content revision, provenance, and duplicate-path collapse;
- immutable, deterministic snapshots;
- exact-revision activation and bounded resource-path enumeration;
- filesystem, cancellation, symlink-policy, and limit seams;
- stable structured diagnostics for expected malformed input and partial I/O failures.

It does not own:

- default roots, source precedence, Workspace Skills Trust, or settings;
- collision presentation and name resolution;
- model catalog rendering, context budgets, Composer syntax, or the `skill` Tool;
- prompt roles, Session records, watchers, or UI;
- resource execution, remote sources, or installation.

## Public loader contract

```ts
const runtime = createSkills({ fileSystem, limits });
const snapshot = await runtime.snapshot({ roots, profile: "compatible" });
const activation = await snapshot.activate(skillId, { arguments: "review this change" });

const validation = validateAgentSkill({ text, directoryName: "review" });
```

- Roots are absolute paths with opaque caller-owned provenance and an explicit symlink policy.
- Default symlink behavior is `ignore`.
- Every same-name candidate is retained; only an identical canonical `SKILL.md` path is deduplicated.
- Candidate identity is path-based and independent of the declared name.
- Discovery stores catalog metadata and a revision, not eagerly injected instructions or resource contents.
- Activation rereads the canonical file and rejects a changed revision.
- Outputs are immutable and deterministically ordered.
- Invalid API arguments and cancellation throw; expected content/I/O problems become diagnostics.

## Compatible loading and strict validation

The runtime's `compatible` profile follows the official client guide without adopting client-specific formats:

- recognizes exact `SKILL.md` only;
- accepts a UTF-8 BOM with a diagnostic;
- requires line-delimited YAML frontmatter and a mapping value;
- may repair an unquoted colon only in a known standard scalar field, with a diagnostic;
- falls back from a missing `name` to the parent directory, with a diagnostic;
- skips missing/empty descriptions, unparseable YAML, invalid UTF-8, NUL bytes, and over-limit files;
- retains recoverable name, directory, length, type, and unknown-field deviations with diagnostics.

`validateAgentSkill` applies no repair and enforces the complete standard field set, types, lengths, Unicode name
grammar, normalized directory equality, and the absence of unknown top-level fields. A compatibly loaded Candidate
records whether the same source is strictly conformant.

## Product discovery roots and precedence

The Coding Agent supplies exactly two roots, in this order:

1. `<Workspace>/.agents/skills` — project scope;
2. `~/.agents/skills` — global user scope.

Coda does not scan `.coda/skills`, any other agent/client directory, the current directory's ancestors, Git roots,
XDG directories, plugin directories, or configurable extra paths. Missing default roots are normal.

Within either root, bounded deterministic discovery looks for subdirectories containing exact `SKILL.md`, stops
descending once a Skill is found, skips `.git`, `node_modules`, and hidden descendants, and applies canonical-path
deduplication. Project symlinks may be followed only while their canonical targets remain within the Workspace. Global
user symlinks may explicitly target outside the root. Both policies detect cycles and retain all scan bounds.

Project candidates always precede global candidates. The project candidate owns a colliding short name; lower-priority
candidates remain addressable by stable ID and qualified name, and the collision is diagnosed.

## User-controlled Skill loading

Project and global Skills are discovered and exposed through the same bounded loader. Coda does not make a separate
Skill safety decision or require an inventory review page; the user decides which Skill to insert through `/skill`,
and model-requested activation uses the exact ID from the current Run snapshot.

## Progressive disclosure and Run lifecycle

Coda follows the standard's three tiers:

1. Discovery loads `name`, `description`, source, and stable identity into a bounded model catalog.
2. Activation loads the `SKILL.md` Markdown body only when explicitly selected or requested through the `skill` Tool.
3. Bundled resources are listed by relative path and read or executed only when later instructions require them.

Each Run freezes one resolved Skill snapshot. Watcher events mark the next snapshot dirty but never mutate an active
Run. Activation of a changed `SKILL.md` fails as stale instead of silently loading new instructions. Duplicate
activations can be recognized by stable ID/revision in the Run context.

All discovered Agent Skills are available to both explicit user selection and model selection. There is no standard
invocation-visibility field, so Coda does not invent one from vendor metadata.

## Catalog, invocation, and context

Prompt Builder renders only resolved metadata and keeps the model-facing catalog within 2% of a known context window
or 8,000 characters otherwise. The project-first winner receives name and description; same-name alternatives receive
compact qualified entries. Ordering, escaping, truncation, and omission are deterministic.

Activation paths are:

1. A structured Composer Skill reference, resolved before submission as user-selected context.
2. A model-requested `skill` Tool call constrained to exact IDs in the current Run snapshot.

Model activation loads exact-revision instructions through the `skill` Tool. Arguments are product metadata: explicit selections receive the Composer
text after all structured Skill tokens are removed; the Tool accepts an optional argument string. No argument syntax or
text substitution is attributed to the Agent Skills standard.

Activation strips frontmatter and returns the Markdown body, exact revision, canonical base directory, normalized
arguments, bounded relative resource paths, and provenance. The context envelope states that Skill text is guidance,
not authority. Resource reads, scripts, shell commands, and network access remain ordinary Tool operations.

## Product surfaces

- `/skills` shows the two sources, conformance, collisions, diagnostics, and refresh.
- `coda skills validate <path>` runs strict standard validation without a model Session and exits nonzero for invalid or
  unreadable input.
- Slash/Composer entries use the standard `name` and `description`; there are no vendor display labels or argument
  hints.
- Session facts retain structured references and exact activation provenance.

## Limits and security invariants

Conservative hard limits cover traversal depth, directories, entries, Skills, `SKILL.md` and frontmatter bytes, YAML
nesting/aliases/duplicate keys, resource depth/entries, and concurrent filesystem operations. Exhaustion produces an
incomplete diagnostic rather than a complete-looking partial inventory.

Paths are canonicalized before identity and containment decisions. UTF-8 decoding is fatal, NUL is rejected, symlink
loops terminate, and resource enumeration never follows resource symlinks. Activation rechecks file kind, byte size,
canonical identity, and revision.

## Verification

Package tests cover every standard field and constraint, Unicode names, compatible recovery, strict rejection of
unknown fields, malformed YAML, UTF-8/NUL, exact filenames, deterministic bounded traversal, symlink containment and
cycles, canonical duplicates, same-name retention, cancellation, stale activation, resource enumeration, and public
exports.

Coding Agent tests cover the two exact roots, project-first collisions, global availability, catalog budgets, explicit
and model activation, ignored vendor invocation fields, Run immutability, `/skills`, strict CLI validation, and
print/interactive Skill loading.
