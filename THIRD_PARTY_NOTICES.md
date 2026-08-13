# Third-Party Notices

## Pi

Coda may include material selectively derived from the Pi AI and TUI packages, and studies the Pi Agent package as a behavioral reference. The local source at `/Users/zp/Desktop/pi/packages` is frozen for compatibility analysis and design research at commit `958c13f25080b59d4b736193f972a8502a7a2f8b`.

Pi is distributed under the following license:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## mattpocock/skills

Coda's local agent workflow documentation includes material derived from `mattpocock/skills` version `v1.2.3`, commit `6acc160e4e0cd062dbbbd7a1b26ae92855edf07e`.

`mattpocock/skills` is distributed under the following license:

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenAI Codex

Coda's CLI runtime-activity shimmer is a behavioral reimplementation of the public Codex status shimmer at commit `8f4a2c99dd56e136894c2ef2221bd7f24f760dd7`; Coda retains its own activity model, renderer, terminal palette, and reduced-motion behavior.

## Native patch Tool design study

Coda's strict native patch parser, batch preflight, per-file commit reporting, and final changed-path supplementation were independently implemented after an architectural and behavioral study of OpenAI Codex at commit `902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe`, OpenCode at commit `cc4b45612974f735ddec46009ede07729511fba4`, and Grok Build at commit `e5fd4816d43260c15ba785f103990c1ed6cea230` (`SOURCE_REV=ea094a8c369475f97c85540d01730baec0dce5d6`). No upstream source was copied, mechanically translated, or linked at build or runtime. The marker vocabulary is intentionally compatible with the public Codex-style patch format, while parsing, exact-match semantics, mutation facts, and atomic writer composition are Coda-owned.

OpenAI Codex and Grok Build are distributed under Apache License 2.0. OpenCode is distributed under the MIT License. The studied sources are available from their official repositories at <https://github.com/openai/codex>, <https://github.com/anomalyco/opencode>, and <https://github.com/xai-org/grok-build>.
