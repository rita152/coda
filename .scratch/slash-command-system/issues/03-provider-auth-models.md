# Add Provider, Auth, and Model flows

Type: task
Status: resolved
Blocked by: 01, 02

Implement the global Provider Manager, secure API-key flows, protocol-defined discovery, truthful unknown Model metadata, Catalog persistence, and the `/auth` and `/model` drawers.

## Acceptance

- Built-in and Custom Providers expose the confirmed actions and statuses.
- Custom Protocol is selected from the three confirmed values.
- Discovery failure preserves a `needs attention` Provider without registering runnable Models.
- Unknown metadata remains unknown while the Model stays selectable through explicit Compatibility Mode.
- Session Model selection never changes the global default.

## Answer

Implemented the global Provider Manager, secure credential operations, the three constrained protocols, model discovery and stale-state handling, truthful unknown Catalog metadata, explicit conservative Compatibility Mode constraints, and the nested `/auth` and `/model` flows.
