# ahp-channels

Run Claude Code channel plugins against local Agent Host Protocol servers.

`ahp-channels` connects messaging plugins to an existing agent conversation.
It runs the plugin's MCP server, forwards inbound messages to an AHP chat,
exposes the plugin's tools, and contributes its setup skills and other Open
Plugin customizations to that conversation. The Agent Host supplies the agent
provider and its permission controls; the plugin owns credentials, pairing,
and platform-specific behavior.

The **0.1** release series includes:

- Named channels managed by a background daemon.
- Local host aliases and discovery of existing sessions and chats.
- Searchable terminal selection and agent-requested handoffs.
- Durable inbound delivery journals, restart recovery, and health diagnostics.
- Plugin-defined reply tools, bounded attachment/resource translation, and
  native permission relay for plugins that support it.

[Quick start](#quick-start) · [Host connections](#select-a-local-agent-host) ·
[Channel controls](#manage-a-channel) · [Upgrading](#upgrade-the-bridge) ·
[Compatibility](#compatibility-and-limits) · [Development](#development)

## Five-minute project tour

Open [the HTML presentation](./slides/index.html) in a browser for three
diagram-first slides: Claude Channels, multi-client AHP extensibility, and
npm/Marketplace distribution. It is self-contained and works offline.
Use the arrow keys to navigate, **N** for speaker notes, and **F** for
fullscreen. Browser printing exports all three slides.

## Requirements

- **Node.js 22 or newer** and npm.
- **Git** for plugin marketplace installation.
- A running **local Agent Host** with a configured agent provider and an
  existing conversation. VS Code builds that expose Agent Host endpoints are
  supported; opening an ordinary editor window alone does not guarantee an
  endpoint is available.
- The selected plugin's runtime and account requirements. The official
  Telegram, Discord, and fakechat plugins currently require
  [Bun](https://bun.sh/docs/installation).

The bridge does not install or authenticate the agent provider, start an
Agent Host, or create agent conversations. Configure those through the host's
own UI or documented tools first.

## Quick start

These commands use the published package, not a source checkout. The
single-line commands work in macOS/Linux shells and PowerShell.

### 1. Install the CLI and a channel plugin

```sh
npm install -g ahp-channels
ahp-channels --version
ahp-channels plugin install telegram@claude-plugins-official
```

Telegram is an example, not a special mode in the bridge. Choose another
compatible plugin to use a different channel.

### 2. Choose the receiving agent conversation

```sh
ahp-channels host discover
ahp-channels host alias add local --host 0
ahp-channels session list --host "@local"
```

Use the index of the intended host from `host discover`; `0` above selects the
first entry. If no hosts are found, enable/start a supported host before
continuing. See [Host connections](#select-a-local-agent-host) for explicit
loopback WebSocket or socket targets.

A **session is an agent conversation**, not the terminal in which you run the
CLI. Choose the conversation that should receive Telegram messages and copy
its exact `resource` URI from `session list`. The bridge does not assume that
the conversation currently open in VS Code is the one you want.

### 3. Create and start the named channel

Replace `PASTE_SESSION_URI` below with that exact URI:

```sh
ahp-channels channel create telegram --plugin telegram --session "PASTE_SESSION_URI" --host "@local"
ahp-channels channel start telegram
ahp-channels channel status telegram
```

The first start may report **`error (degraded)`** if the plugin still needs
credentials or setup. In this mode, its setup skills remain contributed to
the selected conversation, but the channel cannot receive messages yet.

### 4. Complete the plugin's setup in that conversation

Open the **same agent conversation selected in step 2**. Invoke the plugin's
setup skill there, such as `/telegram:configure`, or ask the agent to run the
Telegram setup skill and follow its instructions. Review pairing and access
policy using the plugin's access skill, such as `/telegram:access`.

These are **agent skills, not shell commands or `ahp-channels` subcommands**.
Keep bot tokens private and follow the plugin's credential-storage guidance.
The bridge does not configure tokens or approve external senders for you.

After the setup turn finishes, the daemon automatically retries the plugin.
To request a retry from the terminal once the conversation is idle:

```sh
ahp-channels channel restart telegram
ahp-channels channel status telegram
```

`Channel ... is processing a turn` means the restart was refused to protect
active work; finish the turn and retry. For credentials supplied through
environment variables, see [Plugin environment and restarts](#plugin-environment-and-restarts).

### 5. Send a message and verify the reply

Once status reports **`running (healthy)`**, send a message through Telegram
and verify that the agent replies through the plugin. A new sender may first
need to complete the plugin's pairing process.

If startup only shows `MCP error -32000: Connection closed`, locate the log:

```sh
ahp-channels daemon logs
```

This prints the log file path; inspect it for the plugin's actual diagnostic,
such as a missing token or runtime. Use the plugin's own setup documentation
to resolve it rather than editing bridge internals.

To redirect the channel later, without creating another conversation:

```sh
ahp-channels channel select telegram
```

The picker requires an interactive terminal. For scripts, use
[`channel handoff`](#discover-and-select-existing-sessions) with explicit
host/session/chat selectors.

### Configuration and process ownership

The CLI stores configuration under `~/.ahp-channels` by default. Override this
with `AHP_CHANNELS_HOME`, and use the same value for every command that manages
that installation. Use a persistent location for a channel you intend to keep.

Installed marketplace plugins are copied into content-addressed directories
under `~/.ahp-channels/plugins/<marketplace>/<plugin>/<sha256>`. Marketplace
checkouts remain source catalogs; channel processes and contributed
customizations use the installed copy. Existing `node_modules` and `.git`
directories are not copied.

Changing `AHP_CHANNELS_HOME` isolates bridge configuration, **not plugin-owned
credentials or accounts**. Do not start a second poller for the same bot or
channel identity. Stop the old bridge first, and follow the plugin's own
multi-instance guidance if you need separate bots.

## VS Code extension

The npm package includes a VS Code extension for managing the daemon, installing
plugins, creating and controlling channels, and selecting their AHP sessions.
Install the bundled extension with:

```powershell
ahp-channels vscode install
```

Open the AHP Channels view from the Activity Bar. Session rows support
**Point Channel Here** from their context menu, and channel rows support
**Select Session**. Start or stop channels using their hover controls or
right-click menu; Stop and Restart remain available for channels reporting
errors. All actions are also available from the Command Palette.
Use `ahpChannels.home` in VS Code settings when the
extension should use a state directory other than `~/.ahp-channels`.

See the [extension guide](./vscode-extension/README.md) for setup, controls, and
troubleshooting.

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
ahp-channels session list --host "@work"
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
ahp-channels channel create telegram --plugin telegram --session "PASTE_SESSION_URI" --host "@work"
ahp-channels channel run telegram --session "PASTE_SESSION_URI" --host "@work"
ahp-channels channel select-host telegram --host "@custom"
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
ahp-channels channel select-host telegram --host "@custom"
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

### Plugin environment and restarts

For plugins configured through environment variables, follow the plugin's own
setup instructions and set those variables before launching the bridge.
Foreground `channel run` inherits the launching terminal's environment.
Daemon-managed channels inherit the environment captured when their daemon
started. In both modes, the MCP server's declared `env` values override
inherited values.

Changing variables in a terminal does not update an already-running daemon.
`daemon start` reuses an existing daemon, and `channel restart` still uses that
daemon's environment. To apply changed inherited variables, stop and start the
daemon from the updated terminal:

```powershell
ahp-channels daemon stop
ahp-channels daemon start
```

Stopping the daemon interrupts all channels it manages, so wait until they
are idle before stopping it. Enabled channels are restored on startup. For
foreground execution, stop and rerun `channel run` from the updated terminal.

Plugin-owned credential files and live-reload behavior remain the plugin's
responsibility; follow its documentation. The bridge does not interpret those
files or manage plugin authentication.

## Attachments and resources

The [channel contract](https://code.claude.com/docs/en/channels-reference)
defines inbound notifications as `content: string` plus optional string
`meta`. It does not define attachment fields or an outbound `send_attachment`
operation. The bridge preserves the notification text, valid metadata
attributes, and plugin instructions; it never interprets metadata as a
filesystem grant or automatically opens a path or URL from a message.

Plugins can instruct the agent to use their discovered MCP tools to retrieve
an upload. Tool results are translated as follows:

| MCP content | AHP delivery |
| --- | --- |
| `text` | Text, unchanged. |
| `image` / `audio` | Embedded base64 bytes with a validated, normalized MIME type. |
| Embedded text resource | Resource identity/MIME description followed by its text. |
| Embedded blob resource | Embedded bytes; an absent MIME type becomes `application/octet-stream`. Declared text, JSON, and XML blobs are decoded using their charset (UTF-8 by default), with decoding errors reported explicitly. |
| `resource_link` | Resource identity, name/title, description, MIME, and size when provided, followed by content fetched through the **originating MCP server's** standard `resources/read` API. |

Links are materialized before completing the AHP client tool call. Current
Copilot Agent Hosts consume text and embedded bytes from client-tool results,
not lazy AHP `Resource` result blocks. This also lets a plugin-owned reference
work without a shared filesystem. The bridge does not fetch HTTP URLs itself,
open `file:` links itself, enumerate MCP resources, or recursively follow
content. A server must support `resources/read` for its returned links.
Missing, denied, empty, malformed, oversized, or timed-out resource reads
produce an explicit failed tool result, not a successful URI-only fallback.
Other successfully translated content and the plugin's tool-error text remain
visible. Structured output is preserved within the same content budget.

Materialized tool content (decoded bytes, retained MIME metadata, text including
resource descriptions, and structured output) is limited to **8 MiB per call**,
with at most **16 resource links** and a **10-second total resource-read deadline**.
Size hints are checked before reading, and actual content is checked
regardless of the hint. Base64 and MIME/charset validation rejects corrupt
content. The stdio wire buffer allows JSON/base64 expansion, bounded at
48 MiB + 64 KiB. Diagnostics have separate bounds: **1 KiB per entry**,
**16 KiB of diagnostic content per call**, and a **16 KiB error summary**.
Truncated error details and omitted diagnostics are explicitly marked; rejected data is not echoed
back without bounds. A plugin's admitted error text remains in the content
even when its error summary is shortened.
These limits are not plugin configuration or test overrides.

Files going back to a human use the plugin's ordinary discovered tools and
their complete, plugin-defined schemas. There is no special bridge reply/file
schema. The existing **1 MiB tool-argument limit** applies to both inline and
referenced arguments, independently of a plugin's own file-upload limits.
If a plugin accepts absolute file paths, those files must exist on the
**plugin machine**. Likewise, plugins that describe incoming uploads only as
local paths need host access to that filesystem, or a plugin tool that returns
the content. The bridge neither copies arbitrary host files nor expands its
read-only, plugin-root-scoped reverse resource handlers to cover uploads.

Rendering or understanding a particular image, audio, or document format is
provider/model-dependent. MCP display annotations, icons, and opaque `_meta`
are not interpreted as file access or new AHP attachment fields.

## Compatibility and limits

| Area | 0.1 scope |
| --- | --- |
| Platforms | Windows, macOS, and Linux CLI/package CI. Published-prerelease Telegram onboarding verified on macOS and user-confirmed on Linux. |
| Agent Hosts | Local VS Code registry endpoints and explicitly configured loopback WebSocket/socket hosts. AHP 0.9 hosts are tested; the client negotiates protocol compatibility. |
| Channel plugins | Stdio MCP servers declaring `claude/channel`. Plugins supply their own runtime, credentials, schemas, and access controls. |
| Sessions | Select existing session/chat URIs. No session creation, history migration, or implicit cancellation/movement of agent work. |
| Permissions | Exact-client, advertised-plugin-tool approval; management tools use host-authoritative permission policy. Only trusted plugins and authorized senders should be enabled. |
| Attachments | Bounded MCP content/resource materialization. File-path conventions require the appropriate shared filesystem; rendering and media understanding depend on the provider. |
| Editor integration | The authenticated daemon contract can serve a future extension. No VS Code extension or private editor-chat integration is included. |
| Remote hosts | Remote URLs, SSH/tunnel provisioning, and remote credential/identity management are not supported. |

A `0.1` package release is not a guarantee that every host/provider/plugin
combination has been tested. Automated coverage includes the official fakechat
smoke test and separate permission, attachment, and handoff fixtures. Longer
multi-plugin soak testing is an explicitly deferred follow-up, not completed
release evidence. See [SHIPPING.md](./SHIPPING.md) and [ROADMAP.md](./ROADMAP.md).

## Manage a channel

```powershell
ahp-channels channel status telegram
ahp-channels channel upgrade telegram
ahp-channels channel switch telegram --session "NEW_SESSION_URI"
ahp-channels channel select-host telegram --host "@work"
ahp-channels channel handoff telegram --host "@work" --session "NEW_SESSION_URI" --chat "NEW_CHAT_URI"
ahp-channels channel select telegram
ahp-channels channel stop telegram
ahp-channels channel start telegram
ahp-channels channel delete telegram
```

### Discover and select existing sessions

`session list` reads paginated AHP session catalogs. Without `--host`, it
queries configured local host aliases; when no aliases exist, it retains the
legacy automatic local-host behavior. Use `--host` for one explicit selector,
`--limit` and the printed `--cursor` for pagination, and `--json` for the
structured result:

```powershell
ahp-channels session list --limit 25
ahp-channels session list --host "@work" --json
ahp-channels session list --cursor "RETURNED_CURSOR"
```

Catalog entries include the exact session URI and only the title, provider,
activity/status, project, and working-directory information supplied by AHP.
Choices retain their configured preferred host and report the actual connected
host separately. Duplicate titles remain distinct by host and URI. An empty
catalog is reported differently from failed discovery; partial multi-host
results include explicit per-host warnings.

For a daemon-managed named channel, `channel select <name>` opens a searchable
terminal picker. Enter `/text` to filter by title, provider, URI, host,
activity, or workspace; choose a displayed number; select an exact chat or the
session default; or enter `q` to cancel without changing the binding. The
picker runs only when both stdin and stdout are terminals. Scripts and other
noninteractive callers must use the explicit operation, which never prompts:

```powershell
ahp-channels channel handoff telegram `
  --host "@work" `
  --session "DESTINATION_SESSION_URI" `
  --chat "DESTINATION_CHAT_URI"
```

Omit `--chat` to preserve the destination session's default-chat semantics.
Omit `--host` to preserve the channel's current preferred host. The handoff
validates the destination host, exact existing session, and optional chat
before stopping the source. Host, session, and chat are committed as one
binding; the implementation never chains the older `switch` and `select-host`
commands through an invalid intermediate combination. A failed destination
start restores the previous persisted binding and runtime.

When the daemon is stopped, terminal binding changes use the same recovery-aware
binding service as daemon startup and handoff commits. An interrupted request is
reconciled before a later explicit selection is saved, and stale operations
cannot overwrite an intervening binding change. Offline selection does not
start the daemon or a plugin process.

Selection redirects future channel traffic. It does not create sessions,
migrate or clone history, move agent work, or implicitly cancel a turn.
Remote-host identity and credential management remain unsupported.

### Ask the bound agent to redirect its channel

Daemon-managed bridges contribute generic management tools alongside plugin
tools:

- `ahp_channels_list_sessions`
- `ahp_channels_list_chats`
- `ahp_channels_handoff`
- `ahp_channels_handoff_status`
- `ahp_channels_cancel_handoff`

An agent can discover exact existing session/chat URIs and request a handoff
in natural language. These are bridge management tools, not plugin tools.
They do not receive the plugin-tool automatic approval. The Agent Host must
authorize them through its normal tool permission policy; platform sender or
admin metadata is not treated as authorization. A plugin tool with a
management-tool name is rejected as an explicit collision.

An agent-requested handoff returns `success: true` only after the daemon has
validated and durably accepted a **pending** request. It does not claim the
binding has already changed. The source bridge then:

1. durably holds newly arriving external messages in its delivery journal;
2. allows the source turn and any in-flight ordinary channel tools to finish;
3. applies the host, session, and optional chat together at that safe boundary;
4. replays held messages to the destination, or back to the restored source
   after cancellation or rollback.

Preparing a destination does not publish its tools, approve tool requests, or
execute restored calls. Those side effects wait until the destination binding
is durably committed; normal management errors are returned as failed tool
results rather than stopping the source bridge.

The first accepted request owns the pending slot. Conflicting handoffs are
rejected, and only that source binding can cancel it before commit. A stale
tool call from a replaced runtime cannot mutate the channel. If the daemon
restarts first, it fails the pending request, restores the last committed
source binding, and replays held messages there. `channel status` and
`ahp_channels_handoff_status` report `pending`, `applied`, `failed`, or
`cancelled` with the request ID and any sanitized failure.

The same typed catalog and handoff contracts back the terminal and agent
adapters. A future editor extension can use the authenticated daemon client
contract and supply only editor UI plus a client adapter; it does not need to
import terminal code, parse stdout, run another plugin process, duplicate the
configuration store, or reimplement handoff policy. No VS Code extension or
private editor integration is included today.

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
Journal reads and updates share a cross-process lock to avoid read/replace
races on Windows.

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
Windows or a mode-`0600` Unix socket. Token creation is locked and atomic so
concurrent startup probes cannot observe a partially written token.
Configuration reads and atomic file replacements share an I/O lock, separate
from the heartbeat-backed transaction lock. Local contenders queue without
timer-based lock retries; other processes still use the filesystem lock.
This prevents Windows status reads from colliding with a handoff's atomic
configuration replacement.

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
waiting. Cancellation stops pending argument reads and propagates to MCP tool
calls and resource reads, preventing subsequent resource reads or new channel
tool invocations. It cannot undo effects of a tool that already began.

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

## Upgrade the bridge

Version `0.1.1` fixes a Windows configuration-file sharing race that could cause
`EPERM` and a handoff rollback during concurrent status polling. Use `0.1.1`
or newer for that correction; the published `0.1.0` artifact is unchanged.

Wait until the channels are idle, then stop the daemon **with the currently
installed CLI before upgrading**:

```sh
ahp-channels daemon stop
npm install -g ahp-channels@latest
ahp-channels --version
ahp-channels daemon start
ahp-channels channel list
```

This restarts the process with the installed version rather than leaving an
older daemon running behind a newer CLI. Stopping the daemon affects every
channel in that bridge home. Enabled channels are restored on startup; plugin
installation pins and plugin-owned credentials are not upgraded by this step.

If a command reports `Invalid input: expected ... at version`, the CLI and
daemon use different control protocols. Stop the daemon using the older CLI
or build that launched it, then start the new version. Do not start another
bridge against the same bot as a workaround.

Back up bridge configuration before upgrading an early alpha. Version 0.1.0
reads configuration versions 3 and 4 and writes version 4. Earlier
configuration formats are not automatically migrated; use a separate
persistent bridge home to reinstall plugins and recreate the desired bindings
through the CLI after stopping the old bridge. Plugin-owned state remains
separate.

Stable releases are published under npm's `latest` tag. Prereleases use
`next`; that tag may still point to an older alpha after a stable release, so
use the default install or `@latest` for stable updates.

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
ahp-channels channel run telegram --session "PASTE_SESSION_URI"
```

Foreground channels remain owned by that terminal process. They do not publish
agent management tools and cannot be silently converted into daemon-managed
instances; stop the foreground process and create a named channel when durable
terminal or agent handoff control is required.

## Development

For a source checkout:

```sh
git clone https://github.com/TylerLeonhardt/ahp-channels.git
cd ahp-channels
npm ci
npm run check
```

Additional validation commands:

```powershell
npm test
npm run typecheck
npm run build
npm run test:package
npm run e2e:local
npm run e2e:daemon
npm run e2e:fakechat
npm run e2e:handoff
npm run e2e:permissions
npm run e2e:attachments
```

### Cross-host handoff E2E

`npm run e2e:handoff` starts two isolated deterministic Agent Hosts with
different existing session and chat URIs plus a disposable MCP channel
process. An external WebSocket message reaches the source session, the fixture
agent calls the bridge handoff tool and receives a pending result, the source
reply finishes through the plugin, and the daemon safely moves the binding.
A second external message then reaches the destination session and its reply
returns through the restarted plugin. Assertions use distinct markers and
verify preferred host, actual host, session, and chat identities.

`npm run e2e:handoff -- --resources` runs the same handoff while a real MCP
`resources/read` request is held open in the isolated fixture. The source agent
receives the pending handoff result before that read is released; the source
plugin remains running, materialized text and PNG bytes reach only the source
chat, and the source reply completes before the binding changes. Both handoff
variants run in CI alongside the unmodified official fakechat smoke and the
existing permission and attachment fixtures.

This is deterministic fixture evidence, not a real-model or browser run. The
harness uses isolated daemon, host, plugin, and external-channel state and
removes all of it on success or failure.

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

The daemon home uses a short OS-temporary path so Unix socket addresses do not
depend on checkout depth. The agent receives a separate temporary working
directory containing the plugin's upload state; permission-test targets remain
outside that working directory.

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

### Attachment and resource-reference E2E

`npm run e2e:attachments` uses a clearly labeled attachment fixture around the
unmodified official fakechat server. It is separate from both the default
official-fakechat smoke test and the native-permission fixture.

The attachment fixture exposes uploaded files through opaque MCP resource
references and discovered tools, without forwarding a local file path that a
model could read instead. Its outbound tool uses a resource identifier rather
than assuming a universal `files` argument. The fixture delegates actual
upload, response, and downloadable-file delivery to official fakechat.

The harness checks text and PNG contents at the AHP tool boundary and compares
returned downloads with the uploaded bytes. The deterministic-host run also
verifies read-only, scoped reverse resource access and a separate
shared-filesystem upload/read/reply case. CI uses that deterministic host;
this checks protocol and byte fidelity, **not model vision**. Selecting a real
host exercises its actual agent/provider for referenced uploads, including
image-content assertions, without requiring a host file-read permission.

```powershell
$env:AHP_CHANNELS_E2E_USE_FIXTURE_HOST = '1'
npm run e2e:attachments
```

Without `--interactive`, the runner uses fakechat's browser-facing HTTP and
WebSocket APIs. This is automated protocol E2E, not browser UI automation.
For a real browser-driven run, remove the fixture-host setting, select the
intended host using `AHP_CHANNELS_E2E_HOST`, and add `-- --interactive`. The
runner prints the UI URL, disposable files, and prompts, then observes the
browser-originated turns and plugin responses rather than injecting AHP
turns or permission verdicts. A browser must be able to reach that UI and
upload the disposable files.

## Releases and license

Releases are built and published by
[GitHub Actions](./.github/workflows/publish.yml) using npm trusted publishing
and provenance, not by a local `npm publish`. See
[PUBLISHING.md](./PUBLISHING.md) for the protected-branch, tag-driven process
and [SHIPPING.md](./SHIPPING.md) for release validation.

Licensed under [MIT](./LICENSE). Report bugs at
[GitHub Issues](https://github.com/TylerLeonhardt/ahp-channels/issues).
