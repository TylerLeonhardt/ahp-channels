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

## Completed: Generic session selection and safe channel handoff

- Structured, paginated session and chat discovery across configured local
  Agent Hosts, with explicit empty, partial, and failed outcomes.
- Searchable terminal selection plus noninteractive host/session/chat
  selectors.
- Generic Agent Host client tools for discovery, pending handoff, status, and
  owner-scoped cancellation without plugin-tool autoapproval.
- One daemon-owned host/session/chat commit with destination validation,
  safe-turn boundaries, durable inbound holding, rollback, stale-binding
  rejection, and restart recovery to the committed source.
- Deterministic two-host external-channel E2E with distinct source and
  destination session/chat identities.
- Combined handoff and in-flight MCP resource-materialization coverage with
  byte-exact text/image results and no stale results in the destination chat.

## Completed: VS Code channel management and setup-only handoffs

- Bundled extension and daemon with plugin installation, channel controls,
  session selection, and npm-distributed VSIX installation commands.
- Setup-only handoffs keep plugin skills available on the new session while
  preserving healthy-channel rollback and source ownership checks.
- Actionable extension health with failure, recovery, retry, and handoff
  details rendered as plain text.
- Real bundled-daemon lifecycle tests and local socket regressions under
  VS Code's HTTP proxy wrapper.

## Completed: macOS prerelease onboarding

- Install published `0.1.0-alpha.4` and configure Telegram through the ordinary
  CLI flow with fresh bridge configuration and plugin-owned token setup.
- Verify a real Telegram phone message reaches the bound Copilot conversation,
  a reply returns through the plugin, and CLI status reports a healthy channel.

This reused an existing test bot and allowlist on macOS; it was not a
pristine-machine or new-pairing test.

## Completed: Linux prerelease onboarding

- Published-prerelease Telegram onboarding confirmed by the user on another
  Linux machine. This is user-reported verification, separate from the macOS
  run performed here.

## Next: Post-0.1.0 validation and remote identity

- Define a standard-backed stable identity and credential resolver before
  adding aliases for remote Agent Hosts.
- Soak fakechat, Telegram, and Discord through daemon restarts and plugin
  upgrades. Longer-running soak testing is explicitly deferred follow-up,
  not completed `0.1.0` release evidence.

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
