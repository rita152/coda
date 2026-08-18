---
status: accepted
---

# Admit MCP Tools only through explicit `$` mentions

Coda keeps Skills in the per-Run catalog so the model can auto-load a matching Skill with the `skill` Tool, and also injects a Skill body when the user writes `$name` or picks it from the Composer palette. MCP Tools are the opposite: they stay out of the Run until the user names them with `$`. Auto-exposing every admitted MCP Tool made the model call connectors the user never asked for; Slash `$`/`/` collision with `/mcp` made the palette unusable. Skills win a unique short name so `$review` stays a Skill when a connector reuses that slug, and `/mcp` remains the management command.
