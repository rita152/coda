---
status: accepted
---

# Preserve selected type closures while gating capabilities

`@coda/ai` preserves the complete transitive type closure of its selected Pi-compatible core, including dormant OAuth, deferred, catalog-store, and other-known-Api shapes, while separately publishing a strict runtime capability matrix. Intended subpaths are enumerated explicitly instead of exposed through wildcards, so type compatibility does not silently become a promise to implement or export every Pi feature.
