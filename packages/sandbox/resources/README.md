# Linux bubblewrap fallback

Linux builds place the current architecture's trusted system `bwrap` binary here and record its
SHA-256 digest beside it. Runtime resolution prefers a capable root-owned system installation and
uses this copy only after verifying the digest and probing user/PID namespace creation.

Each generated architecture directory also contains `provenance.json` with the exact digest,
reported version, build-input path, license, and upstream release location. Distributors must
follow `BUBBLEWRAP_SOURCE_OFFER.md` and preserve `BUBBLEWRAP_COPYING`.

Generated binaries are intentionally not checked into the source repository. Release artifacts are
built and tested independently on Linux x86_64 and arm64.
