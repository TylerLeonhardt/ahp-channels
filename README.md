# ahp-channels

Run Claude Code channel plugins against any Agent Host Protocol server.

`ahp-channels` is an experimental compatibility adapter. It launches a
Claude-style MCP channel plugin, forwards inbound channel notifications to an
AHP chat, exposes the plugin's MCP tools as AHP client tools, and contributes
the installed Open Plugin to the AHP session so the host can discover its
skills and other customizations.

## Quick start

```powershell
npm install
npm run build

node .\dist\cli.js plugin install fakechat@claude-plugins-official
node .\dist\cli.js host discover
node .\dist\cli.js session list
node .\dist\cli.js channel create fakechat --plugin fakechat --session <session-uri>
node .\dist\cli.js channel start fakechat
```

The CLI stores configuration under `~/.ahp-channels` by default. Override this
with `AHP_CHANNELS_HOME`.

Installed marketplace plugins are copied into content-addressed directories
under `~/.ahp-channels/plugins/<marketplace>/<plugin>/<sha256>`. Marketplace
checkouts remain source catalogs; channel processes and contributed
customizations use the installed copy. Existing `node_modules` and `.git`
directories are not copied.

The official preview plugins currently require Bun. The adapter
supports standalone TCP hosts and normal editor Agent Hosts over Windows named
pipes or Unix domain sockets.

## Ownership boundary

`ahp-channels` owns the compatibility boundary:

- installing and resolving Open Plugins;
- serving contributed plugin files through read-only AHP resource requests;
- publishing plugin customizations and client-owned MCP tools;
- starting the selected channel MCP server;
- routing events and tool calls between MCP and AHP;
- daemon lifecycle, session bindings, and durable event delivery.

The selected channel MCP server is disabled inside the contributed plugin
because the client already runs and proxies it. Other plugin children remain
available to the Agent Host.

The plugin owns its behavior and data:

- setup and access skills;
- credentials and state files;
- sender pairing, allowlists, and platform permissions;
- dependency installation and external-service behavior.

Follow each plugin's own setup instructions. `ahp-channels` does not interpret
plugin state, store plugin credentials, or implement platform-specific access
commands. Once a channel is running, its contributed skills appear in the
target AHP session under the plugin's namespace.

If the plugin's MCP server cannot start before setup, the channel reports the
startup error but keeps its plugin customizations active. Run the contributed
setup skill in the target session. The daemon retries automatically after the
setup turn finishes and activates the channel server when it becomes runnable.

## Status

The compatibility bridge and durable daemon control milestones are complete.
Channel status includes structured operational health diagnostics. See
[ROADMAP.md](./ROADMAP.md) for the remaining setup, reliability, and
distribution work.

## Manage a channel

```powershell
ahp-channels channel status telegram
ahp-channels channel upgrade telegram
ahp-channels channel switch telegram --session <new-session-uri>
ahp-channels channel stop telegram
ahp-channels channel start telegram
ahp-channels channel delete telegram
```

`channel status <name>` reports both the runtime state and bridge-owned health:

```text
telegram: error (degraded) @ 0123456789ab → ahp-session:/work (ahp-chat:/main)
Mode: customizations available; channel MCP server unavailable
Failure stage: mcp-startup
Error: MCP channel startup: required plugin setup is incomplete
Failed at: 2026-09-15T22:30:00.000Z
Recovery: Run the plugin setup skill in the target session, then wait for retry or restart the channel.
Retry: attempt 2 (scheduled)
Next retry: 2026-09-15T22:30:04.000Z
```

Failure stages identify the bridge operation that failed: Agent Host discovery
or connection, session/chat resolution, plugin installation integrity or
loading, MCP startup or unexpected exit, and retry scheduling or exhaustion.
Stages are assigned at operation boundaries, not inferred from plugin error
text. The original one-line error summary is retained with common credential
values redacted.

Use `--json` for the type-stable `health` object. Healthy running channels
report `health.state: "healthy"` without a failure. Intentionally stopped
channels report `health.state: "stopped"`. An MCP startup failure reports
`"degraded"` when plugin customizations and setup skills remain available;
failures without a usable runtime report `"unhealthy"`.

The daemon atomically stores only the latest actionable failure and retry
metadata under the channel's bridge-owned instance directory. Runtime facts
are derived when status is read. A successful recovery removes the active
failure, while invalid persisted health data prevents daemon startup with an
explicit path-specific error.

The daemon starts on demand, remembers desired running channels, and restarts
them after a daemon or channel-process restart. A switch is rejected while the
channel is processing a turn, so an in-flight reply is never silently orphaned.
Inbound events with stable platform IDs are journaled before AHP dispatch and
deduplicated across process restarts.

Each named channel pins the plugin installation that was active when the
channel was created. A later plugin upgrade does not affect that channel until
`channel upgrade` is run.

Deleting a channel removes its AHP binding and bridge-owned delivery journal.
It does not delete state or credentials owned by the plugin.

```powershell
ahp-channels daemon status
ahp-channels daemon logs
ahp-channels daemon stop
ahp-channels daemon start
```

Control traffic uses a per-install random token over a local named pipe on
Windows or a mode-`0600` Unix socket. Configuration writes are atomic and use a
heartbeat-backed cross-process lock.

## Manage plugin versions

```powershell
ahp-channels marketplace update claude-plugins-official
ahp-channels plugin upgrade telegram
ahp-channels plugin versions telegram
ahp-channels plugin rollback telegram <installation-id>
ahp-channels channel upgrade telegram
ahp-channels plugin prune telegram
```

`marketplace update` changes only the source catalog. `plugin upgrade` updates
the marketplace, installs its current plugin content into a new
content-addressed directory when needed, and makes that installation the
default for new channels. Existing channels remain pinned.

`plugin rollback` selects an already installed version as the default. Run
`channel upgrade` on each channel that should adopt it. `plugin prune` retains
the active version and every channel-pinned version, then removes only
unreferenced installation directories.

An absolute or `.`-relative plugin path remains available for local
development. Path-based plugins bypass the installation registry and cannot be
upgraded, rolled back, or pruned by these commands.

For one-off foreground use, `channel run` remains available:

```powershell
ahp-channels channel run telegram --session <session-uri>
```

## Development

```powershell
npm test
npm run typecheck
npm run build
npm run test:package
npm run e2e:local
npm run e2e:daemon
npm run e2e:fakechat
```

### Official fakechat E2E

`npm run e2e:fakechat` requires Bun and Git/network access to
`anthropics/claude-plugins-official`. By default it also requires a running
local Agent Host with an available agent provider; set `AHP_CHANNELS_E2E_HOST`
to a discovered host index or ID prefix to choose a specific host.

CI sets `AHP_CHANNELS_E2E_USE_FIXTURE_HOST=1` to start an isolated,
deterministic AHP host. That host drives the same session, reverse resource,
customization, and client-tool protocol used by a full agent provider, but
needs no model credentials. The default local mode remains available for
validating against a real installed Agent Host.

The test installs the real `fakechat@claude-plugins-official` plugin through the
built CLI, creates a temporary AHP session and named channel, and exchanges an
exact message and reply through fakechat's browser-facing WebSocket. It then
restarts the isolated daemon and repeats the round trip. The test chooses an
available loopback port instead of assuming fakechat's default, requires no
credentials or external messaging service, and removes its temporary
`AHP_CHANNELS_HOME`, plugin home, Bun cache, channel, daemon, and AHP session on
both success and failure.

See [SHIPPING.md](./SHIPPING.md) for the npm prerelease gates and
[PUBLISHING.md](./PUBLISHING.md) for the tag-driven release process.
