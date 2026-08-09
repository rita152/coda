# Third-party notices

## OpenAI Codex

The Permission Profile and approval behavior of this package was independently designed from the public OpenAI Codex implementation at commit `f93109615ff27ab58007601434b27c940d5500c7` (OpenAI Codex, Copyright 2025 OpenAI). Coda does not mechanically translate or link Codex source. Codex is licensed under Apache License 2.0; a copy is included at `resources/CODEX_LICENSE` and the studied source is available at <https://github.com/openai/codex>.

## bubblewrap

Linux build artifacts may contain an unmodified `bwrap` executable copied from the trusted system build input recorded in `resources/linux-<arch>/provenance.json`. bubblewrap is Copyright its contributors and is distributed under the GNU Library General Public License version 2. A complete license copy is included at `resources/BUBBLEWRAP_COPYING`; upstream source releases are available at <https://github.com/containers/bubblewrap/releases>.

The provenance document records the exact packaged binary digest, reported version, and system build-input path. A distributor must also provide the complete corresponding source for that system binary, including distribution patches when applicable, or preserve the written offer in `resources/BUBBLEWRAP_SOURCE_OFFER.md`. The upstream tag alone must not be represented as corresponding source when the system package contains downstream changes.
