---
status: accepted
---

# Make Skill safety user-controlled

Workspace Skills Trust is removed. Coda loads discovered project and user Skills through the same bounded Agent
Skills loader and does not show a startup inventory review or require an exact inventory approval before a Skill can
appear in the model catalog or `/skill` selector. This supersedes the Workspace Skills Trust portions of ADR-0036;
the loader's format validation, bounded discovery, collision handling, exact-revision activation, and ordinary
Permission/Skill Approval policy remain in place.

The user decides which Skill to select and is responsible for reviewing its instructions. A Skill remains contextual
guidance and never grants filesystem, process, Tool, or network authority by itself. Removing trust records also keeps
Skill discovery state out of persistent settings and eliminates the `--trust-project-skills` startup path.
