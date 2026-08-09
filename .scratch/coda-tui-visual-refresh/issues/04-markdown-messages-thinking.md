# Render Markdown Messages and Thinking Blocks

Type: task
Status: resolved
Blocked by: 03

Add the generic CommonMark/GFM MarkdownRenderer, literal User cards, unlabeled Assistant Markdown, visible muted Thinking Blocks, safe links, responsive code and tables, and streaming-phase behavior.

## Acceptance

- CommonMark/GFM fixtures render within width without embedded newlines or terminal-control injection.
- Incomplete streaming constructs never throw and settle to the complete rendering.
- Text, Thinking, and Tool blocks retain Provider order.
- NO_COLOR distinguishes Thinking without SGR.
- Committed block caches and the 10,000-line stress case satisfy the structural performance contract.

## Comments

## Answer

Implemented sanitized CommonMark/GFM rendering, literal User cards, unlabeled Assistant content, muted Thinking Blocks, safe links, responsive code/tables, committed-document caching, and visible-row-only 10,000-line viewport verification.
