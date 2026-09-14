# Roadmap

## Phase 1: Runnable compatibility bridge

- Install relative-path plugins from Claude-style Git marketplaces.
- Discover local VS Code Agent Host endpoints.
- List sessions on a discovered host.
- Run one stdio MCP channel against one existing AHP chat.
- Translate channel notifications and client-owned tool calls.
- Verify against a live local Agent Host.

## Phase 2: Durable channel instances

- Named instances with isolated state directories and secret references.
- Persistent channel-to-session bindings.
- Background supervisor with start, stop, status, and logs.
- Reliable event deduplication and delivery tracking.

## Phase 3: Broader compatibility

- Permission relay with sanitized previews and expiring request IDs.
- Git subdirectory, URL, npm, and pip marketplace sources.
- Virtual plugin projection for channel instructions and management skills.
- Attachment and resource-reference translation.

## Phase 4: Governance and distribution

- Signed or pinned marketplace policy.
- Runtime-enforced channel and permission-relay allowlists.
- OS credential-store integrations.
- Packaged binaries and service installation.
