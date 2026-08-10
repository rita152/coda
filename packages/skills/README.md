# `@coda/skills`

Agent Skills-compatible parsing, validation, bounded local discovery, immutable snapshots, and exact-revision
activation for Coda.

This private package is a workspace leaf with no dependency on another `@coda/*` package. Its only format target is
the neutral [Agent Skills specification](https://agentskills.io/specification): an exact `SKILL.md`, the six standard
frontmatter fields, unrestricted Markdown instructions, and optional bundled resources.

## API

Official compatible loading and strict conformance are separate contracts:

```ts
const skills = createSkills({ fileSystem });
const snapshot = await skills.snapshot({ roots, profile: "compatible" });
const activation = await snapshot.activate(candidate.id, { arguments: "review this change" });

const validation = validateAgentSkill({ text, directoryName: "review" });
```

The caller supplies absolute roots, opaque provenance, filesystem access, limits, and a symlink policy. Discovery
retains every same-name Candidate, collapses only identical canonical `SKILL.md` paths, and returns deterministic,
immutable snapshots. Activation rereads the exact canonical file, rejects a changed revision, strips frontmatter, and
returns the Markdown body, canonical base directory, normalized arguments, bounded resource paths, and diagnostics.

The compatible parser performs only recovery recommended by the official client guide, such as a missing-name
fallback and narrow unquoted-colon repair, and always diagnoses it. Non-standard top-level fields are ignored rather
than interpreted. `validateAgentSkill` independently enforces the Agent Skills field, name, directory, type, and
length rules without those repairs; custom properties belong under the standard `metadata` map.

## Bounds and authority

Conservative defaults bound traversal depth, directories, entries, Skills, file/frontmatter bytes, YAML nesting,
resource enumeration, and concurrent filesystem operations. Symlinks are ignored unless a root explicitly chooses
containment or user-managed escape; activation and resource enumeration recheck canonical identity and never follow
resource symlinks.

The package does not choose Coda roots or precedence, trust Workspace content, render prompts, authorize Tools, watch
files, execute scripts, or install remote Skills. It parses experimental `allowed-tools`, but Coda does not treat that
declaration as filesystem, process, Tool, or network authority.
