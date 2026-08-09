# Add Media Assets, attachments, and previews

Type: task
Status: resolved
Blocked by: 03, 04

Build MediaLibrary ingestion/storage/renditions, composer attachment chips, Model capability gating, Tool Result media warnings, Kitty preview surface, metadata and system-viewer fallback, resource limits, and cleanup.

## Acceptance

- Admission rejects unsupported, oversized, malformed, or decompression-bomb inputs before unsafe allocation.
- Original, preview, and Model renditions obey the spec and preserve stable filename metadata.
- Kitty preview upload and deletion are scoped to one terminal Session.
- Unsupported terminals and multiplexers never receive graphics escapes.
- Staged and unreferenced media cleanup preserves every committed Session reference.

## Comments

## Answer

Implemented bounded magic-sniffed Media ingestion, original/preview/Model renditions, attachment chips, capability gating, Kitty terminal previews, metadata/system-viewer fallback, content-addressed Session storage, and reference-safe cleanup.
