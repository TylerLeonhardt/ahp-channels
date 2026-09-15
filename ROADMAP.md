# Roadmap

## Product boundary

`ahp-channels` is a thin compatibility bridge between Open Plugin channel
infrastructure and Agent Host Protocol sessions.

The bridge owns:

- marketplace resolution and reproducible plugin installation;
- AHP client customizations and read-only plugin resource serving;
- the selected channel MCP process and its client-owned tools;
- channel notification, tool-call, and permission-relay translation;
- host discovery, session/chat bindings, daemon lifecycle, and delivery
  journals.

The plugin owns:

- setup and access skills;
- credentials, state files, and dependency installation;
- sender pairing, allowlists, and platform permissions;
- channel-specific configuration and external-service behavior.

Core bridge code must not switch on plugin names or interpret plugin-owned
files.

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

## Completed: Alpha reliability gates

- Normal editor endpoints over Windows named pipes and Unix sockets.
- Client-contributed Open Plugin customizations.
- Read-only reverse AHP resource serving for contributed plugins.
- Named bridge instances with isolated delivery journals.
- Durable event IDs, pending replay, and bounded deduplication history.
- Plugin-owned setup, credentials, state, and access management.

## Next: Reproducible plugin lifecycle

- Install selected plugins into immutable, versioned directories instead of
  executing them from marketplace checkouts
  ([#1](https://github.com/TylerLeonhardt/ahp-channels/issues/1)).
- Record marketplace revision, plugin version, and source provenance.
- Make plugin upgrades explicit and atomic.
- Support rollback and remove unreferenced installations safely.

## Next: Operational reliability

- Rotate and bound daemon logs.
- Report actionable health for host discovery, plugin loading, MCP startup,
  retries, and customization-only runtimes.
- Add stable aliases for explicitly selected remote Agent Hosts.
- Improve host, session, and chat selection without replacing URI-based
  bindings.

## Later: Protocol coverage

- Permission relay with sanitized previews and expiring request IDs.
- Attachment and resource-reference translation.

## Later: Marketplace and distribution

- Git subdirectory, URL, npm, and pip marketplace sources.
- Signed or pinned marketplace policy.
- Runtime-enforced channel and permission-relay allowlists.
- Packaged binaries and service installation.
