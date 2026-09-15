# Roadmap

## Completed: Runnable compatibility bridge

- Install relative-path plugins from Claude-style Git marketplaces.
- Discover local VS Code Agent Host endpoints.
- List sessions on a discovered host.
- Run one stdio MCP channel against one existing AHP chat.
- Translate channel notifications and client-owned tool calls.
- Verify against a live local Agent Host.

## Completed: Durable channel control

- Named instances with persistent channel-to-session bindings.
- Authenticated background daemon with start, stop, status, switch, and logs.
- Desired-state restoration and bounded exponential restart retries.
- Busy-session switch protection and failed-switch rollback.
- Atomic cross-process configuration updates.

## Next: Setup and delivery reliability

- Named instances with isolated state directories and secret references.
- Deterministic event IDs, deduplication, and delivery tracking.
- First-class configure and access commands for known channel plugins.
- Log rotation and richer health diagnostics.

## Later: Broader compatibility

- Permission relay with sanitized previews and expiring request IDs.
- Git subdirectory, URL, npm, and pip marketplace sources.
- Virtual plugin projection for channel instructions and management skills.
- Attachment and resource-reference translation.

## Later: Governance and distribution

- Signed or pinned marketplace policy.
- Runtime-enforced channel and permission-relay allowlists.
- OS credential-store integrations.
- Packaged binaries and service installation.
