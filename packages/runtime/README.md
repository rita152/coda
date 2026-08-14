# `@coda/runtime`

Reusable, instance-local, headless Agent Runtime for Coda. The Module composes a
private serial Agent kernel behind atomic per-Run preparation, durable Session
events, input commands, Context Window recovery, Skills/MCP snapshots, event
routing, and lifecycle cleanup. Its public Interface exposes factories and
runtime commands without exposing the Agent or internal controllers, and its
Implementation never imports terminal or CLI modules.
