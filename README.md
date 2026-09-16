# ahp-channels

Run Claude Code channel plugins against local Agent Host Protocol servers.

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
node .\dist\cli.js host alias add local --host 0
node .\dist\cli.js session list
node .\dist\cli.js channel create fakechat --plugin fakechat --session <session-uri> --host @local
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

## Select a local Agent Host

AHP defines the protocol after a client transport is open; it does not define
host discovery, a registry, or credential storage. `ahp-channels` supports two
local connection providers:

1. VS Code editor and standalone hosts published in VS Code's owner-only local
   endpoint registry.
2. Other local AHP implementations at an explicitly configured fixed
   loopback WebSocket URL, Unix socket, or Windows named pipe.

Discover VS Code-published endpoints and create an alias from a current
selection:

```powershell
ahp-channels host discover
ahp-channels host alias add work --host 0
ahp-channels host alias list
ahp-channels host alias inspect work
ahp-channels session list --host @work
```

A VS Code alias stores the endpoint registry directory, endpoint kind
(`editor` or `standalone`), and advertised product quality when present. It
does not store the endpoint ID, PID, registry filename, socket or port, or
connection token. Every use rereads the registry, so a restarted host can
publish a new transient endpoint and token under the same alias target.
Advertised protocol versions are diagnostic metadata only; the client always
performs normal AHP negotiation after connecting.

The VS Code registry has no durable per-window host ID. Alias creation and
direct alias resolution therefore require exactly one live endpoint matching
the configured registry scope, kind, and quality. A second indistinguishable
endpoint makes the alias ambiguous instead of selecting one silently. A
dedicated VS Code `--user-data-dir` gives a standalone host the strongest
registry boundary.

Configure a non-VS-Code local host with a stable address:

```powershell
ahp-channels host alias add custom `
  --url ws://127.0.0.1:4317/ `
  --token-file C:\path\to\agent-host.token `
  --token-query-parameter tkn

ahp-channels host alias add socket-host `
  --socket \\.\pipe\agent-host `
  --without-authentication
```

On macOS or Linux, `--socket` accepts an absolute Unix socket path. Relative
socket and token-file paths are made absolute by the CLI. WebSocket aliases
accept only loopback `ws://` or `wss://` URLs. User information, fragments, and
recognizable credential query parameters are rejected; put the token in an
owner-protected file instead. Because AHP does not define authentication,
`--token-file` also requires the host's documented
`--token-query-parameter`; `tkn` is the convention used by VS Code. The token
file is read on every connection attempt and its contents are never persisted
or included in alias inspection. WebSocket subprotocol and header
authentication are not currently supported. Use `--without-authentication`
only when the local host intentionally requires no connection token.

Generic aliases require a fixed URL or socket across host restarts. A generic
host with only a transient address must publish its own stable resolver or
registry before it can be restart-stable; AHP itself does not provide one.
Remote URLs, SSH/tunnel provisioning, and remote credential management are not
supported.

Use aliases anywhere a host selector is accepted:

```powershell
ahp-channels channel create telegram --plugin telegram --session <session-uri> --host @work
ahp-channels channel run telegram --session <session-uri> --host @work
ahp-channels channel select-host telegram --host @custom
```

Legacy endpoint indices and ID prefixes remain supported. Configuration
version 3 is loaded as version 4 with no aliases; its existing channel,
session, chat, and legacy host selectors are unchanged. The next configuration
write persists version 4.

For a persisted channel, an alias is the preferred target. If that target is
temporarily unavailable or fails to connect, the runtime reports the fallback
and tries other discovered local hosts that own the channel's existing session
URI; it still validates the configured chat URI. An ambiguous alias is an
error, not a fallback trigger. The daemon's existing bounded exponential retry
loop rediscovers endpoints and rereads token files after connection loss and
across daemon restarts. Foreground `channel run` reports failure when no
suitable target is available.

Removing an alias referenced by any channel is rejected. Select a different
host first, then remove it:

```powershell
ahp-channels channel select-host telegram --host @custom
ahp-channels host alias remove work
```

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
ahp-channels channel select-host telegram --host @work
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

Daemon and channel-process output is written to `daemon.log`. The active log is
limited to 1 MiB, with the three most recent 1 MiB rotations retained as
`daemon.log.1` through `daemon.log.3`. Rotation occurs while the daemon is
running, and an oversized log from an older installation is reduced to its
newest 1 MiB when the daemon starts. `ahp-channels daemon logs` prints the
active log path; inspect the numbered files for older failure context.
An exclusive, heartbeat-backed file lock prevents competing daemon starts
from rotating each other's logs. Startup errors are returned to the CLI even
when the log cannot be opened. Node warnings, uncaught exceptions, unhandled
rejections, and runtime module-loading failures are also recorded; fatal
errors still terminate the daemon with a non-zero exit code.

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

### Approve tools from a channel

Tools contributed by a channel, such as its `reply` tool, are automatically
approved for that channel's client. Trust requires both the exact client
identity and a tool name in its published tool list; a host tool or another
client's tool named `reply` is not trusted by name alone. Execution still waits
for the Agent Host to accept the approval. This works even without native
permission support and does not enable session-wide "allow all" permissions.
Only run channel plugins whose contributed tools you trust.
Pending calls for tools the channel no longer advertises are denied explicitly;
already-running unavailable calls report a failure instead of leaving the turn
waiting. Cancellation stops pending argument reads and prevents a new channel
tool invocation afterward. It cannot undo effects of a tool that already began.

Channel plugins that advertise `claude/channel/permission: {}` can relay tool
approval requests for other tools in their bound AHP chat. Missing or `false`
capabilities leave those approvals in the Agent Host UI. The bridge uses the native
[`permission_request` / `permission` notifications](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts),
not plugin-specific reply tools or model-parsed chat commands.

When another tool needs confirmation, the plugin receives its name, a sanitized
description and argument preview, and a short request ID. Use the plugin's
approval controls, such as Telegram's Allow/Deny buttons or `yes abcde` /
`no abcde` replies. A verdict applies only to that pending call; it never
selects a session-wide trust option. Execution still waits for an accepted
Agent Host confirmation. The Agent Host dialog remains available, and a
decision there invalidates the channel request.

Previews visibly neutralize control characters and disguise-prone Unicode,
mask recognizable credential tokens, and mark omitted content while retaining
both ends of long values. They are bounded previews, not exhaustive secret
detection or full diffs. Review the complete input in the Agent Host UI if the
preview is insufficient to make a safe decision.

Requests expire after five minutes. Duplicate, unknown, superseded, and
expired verdicts do not approve tools or become agent messages. Stopping a
channel invalidates its requests; restarting reconstructs pending tool
confirmations from the host snapshot and issues fresh requests. Referenced
arguments are read for the preview and re-read before approval; changed
content requires another decision. Inputs that cannot be read or exceed
1 MiB are not offered for remote approval, and the reason is logged.

**Trust boundary:** the channel plugin owns sender authentication, pairing,
allowlists, and prompt delivery. Native verdicts contain a request ID and
decision, not a sender identity; the bridge cannot independently enforce
same-sender approval. Enable permission-capable channels only when you trust
the plugin and its authorized users to approve tool use in the bound chat,
including turns started from the editor.

Tool-use and mid-execution re-confirmations are supported. Project trust,
MCP authentication/consent, result-review confirmations, and arbitrary user
questions remain in the Agent Host UI.
Re-confirmation previews include the current permission request, with the
original tool intention shown only as additional context.

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
npm run e2e:permissions
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

The deterministic host also requires confirmation for the contributed `reply`
tool. The bridge must automatically approve it before execution; the E2E
harnesses observe the flow without injecting approval decisions.

The test installs the real `fakechat@claude-plugins-official` plugin through the
built CLI, creates a temporary AHP session and named channel, and exchanges an
exact message and reply through fakechat's browser-facing WebSocket. It then
restarts the isolated daemon and repeats the round trip. The test chooses an
available loopback port instead of assuming fakechat's default, requires no
credentials or external messaging service, and removes its temporary
`AHP_CHANNELS_HOME`, plugin home, Bun cache, channel, daemon, and AHP session on
both success and failure.

### Permission relay E2E

`npm run e2e:permissions` uses the same harness and a test-only native-permission
extension around the unmodified official fakechat server. Official fakechat
does not currently advertise the permission capability, so this is explicitly
an extended fixture, separate from the normal official-fakechat smoke test.
The real fakechat web UI, reply tools, Bun process, daemon, and AHP protocol are
still exercised. CI runs both modes.

```powershell
$env:AHP_CHANNELS_E2E_USE_FIXTURE_HOST = '1'
npm run e2e:permissions
```

The deterministic host requests permission for an actual marker-file write
inside isolated test state. The test answers through fakechat's browser-facing
WebSocket, checks the bridge-authored AHP verdict, and verifies that allowing
writes the file while denying does not. It also restarts the daemon with a
pending request and verifies that a stale allow reply cannot override a fresh
denial. The approval observer does not dispatch confirmations.

For browser-driven testing, add `-- --interactive`. The harness prints its UI
URL, message to send, and expected verdict for each case. The fixture-only
`/permissions` command displays outstanding cards after the browser reconnects;
it models the message history a real chat platform keeps.

See [SHIPPING.md](./SHIPPING.md) for the npm prerelease gates and
[PUBLISHING.md](./PUBLISHING.md) for the tag-driven release process.
