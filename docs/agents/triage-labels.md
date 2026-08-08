<!--
Portions derived from mattpocock/skills:
/skills/engineering/setup-matt-pocock-skills/triage-labels.md v1.2.3 @ 6acc160e4e0cd062dbbbd7a1b26ae92855edf07e
Copyright (c) 2026 Matt Pocock
SPDX-License-Identifier: MIT
See THIRD_PARTY_NOTICES.md.
-->

# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles, plus Coda's terminal `resolved` state, to the strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| —                          | `resolved`           | Implemented and verified                 |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
