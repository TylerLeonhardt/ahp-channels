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

## Completed: Reproducible plugin lifecycle

- Content-addressed plugin snapshots outside marketplace checkouts
  ([#1](https://github.com/TylerLeonhardt/ahp-channels/issues/1)).
- Git-tracked snapshots with marketplace revision, plugin version, source
  provenance, and installed-content verification.
- Explicit marketplace updates and plugin upgrades with stable channel pins.
- Rollback and safe pruning of inactive, unreferenced installations.
- Cross-process installation locking and reliable termination of entire plugin
  process trees.
- Official fakechat external-UI coverage across a daemon restart in CI.

## Completed: Actionable channel health diagnostics

- Structured health for host discovery and connection, session and chat
  resolution, plugin integrity and loading, MCP startup and exits, retries,
  and customization-only runtimes.
- Latest bridge-owned root cause, recovery guidance, failure time, and retry
  state preserved atomically across daemon restarts and cleared on recovery.
- Strict daemon protocol and persisted-state validation with secret-safe,
  actionable CLI output.

## Completed: Operational reliability

- Runtime rotation caps daemon and channel-process logs at 1 MiB each while
  retaining the three most recent files for failure context.

## Completed: Stable local Agent Host aliases

- Explicit alias creation, inspection, listing, removal, and persisted-channel
  host switching.
- VS Code local-registry targets that refresh transient endpoint addresses and
  credentials after host restart without treating discovery protocol metadata
  as negotiated compatibility.
- Generic local loopback WebSocket and socket targets with credentials read
  from owner-managed token files on every connection attempt.
- URI-preserving local fallback, daemon restoration, strict ambiguity and
  invalid-configuration errors, and secret-safe diagnostics.

## Next: Host selection and release validation

- Define a standard-backed stable identity and credential resolver before
  adding aliases for remote Agent Hosts.
- Improve host, session, and chat selection without replacing URI-based
  bindings.
- Run a fresh macOS or Linux Telegram setup from the published prerelease
  using plugin-owned configuration.
- Soak fakechat, Telegram, and Discord through daemon restarts and plugin
  upgrades.
- Resolve alpha feedback and document protocol, host, and plugin compatibility
  limits.

## Completed: Tool permission relay

- Native channel permission requests and verdicts with sanitized previews,
  short-lived request IDs, and Agent Host-authoritative decisions.
- Fakechat-based approval and denial coverage, including a pending request
  across daemon restart and stale verdict rejection.

## Completed: Bounded attachment and resource-reference translation

- Preserve generic channel text, metadata, and plugin instructions without
  inventing attachment notification fields.
- Translate MCP text, images, audio, and embedded text/blob resources into
  model-consumable AHP tool content.
- Resolve tool-provided resource links through the originating MCP server's
  `resources/read` API, with byte/count limits, explicit errors, and cancellation.
- Preserve plugin-defined tool schemas for outbound file delivery; do not
  interpret file paths or platform metadata in the bridge.
- Keep reverse plugin resource access read-only and scoped to the plugin root.

Provider/model format support and plugin-local path conventions still apply;
this does not add arbitrary file transfer between host and plugin machines.
See [README.md](./README.md#attachments-and-resources) for supported paths and
limits.

## Later: Marketplace and distribution

- Git subdirectory, URL, npm, and pip marketplace sources.
- Signed or pinned marketplace policy.
- Administrative policy for which marketplaces and plugins may be activated.
- Packaged binaries and service installation.
