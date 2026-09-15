# ahp-channels

Run Claude Code channel plugins against any Agent Host Protocol server.

`ahp-channels` is an experimental compatibility adapter. It launches a
Claude-style MCP channel plugin, forwards inbound channel notifications to an
AHP chat, and exposes the plugin's MCP tools as AHP client tools.

## Quick start

```powershell
npm install
npm run build

node .\dist\cli.js plugin install telegram@claude-plugins-official
node .\dist\cli.js host discover
node .\dist\cli.js session list
node .\dist\cli.js channel create telegram --plugin telegram --session <session-uri>
node .\dist\cli.js channel secret set telegram TELEGRAM_BOT_TOKEN
node .\dist\cli.js channel start telegram
```

The CLI stores configuration under `~/.ahp-channels` by default. Override this
with `AHP_CHANNELS_HOME`.

Telegram and Discord currently require Bun, matching the upstream plugins. The adapter
supports standalone TCP hosts and normal editor Agent Hosts over Windows named
pipes or Unix domain sockets.

DM a Telegram or Discord bot once it starts, then approve and lock down the
sender locally:

```powershell
ahp-channels channel access status telegram
ahp-channels channel access pair telegram <code>
ahp-channels channel access policy telegram allowlist
```

Replace `telegram` with the configured Discord channel name when managing a
Discord bot.

Access updates briefly suspend a running Telegram or Discord channel so they cannot race the
plugin's own state writes. If the channel is processing a turn, retry the
command from a terminal after the turn finishes. A waiter started as a tool
call in that same turn cannot make progress because the tool call keeps the
turn active.

Secrets are stored in Windows Credential Manager, macOS Keychain, or a
persistent Linux Secret Service. Named instances receive isolated plugin state
under `~/.ahp-channels/instances/<name>`, including explicit state-directory
wiring for the official Discord, iMessage, and Telegram plugins.

## Status

The compatibility bridge and durable daemon control milestones are complete.
See [ROADMAP.md](./ROADMAP.md) for the remaining setup, reliability, and
distribution work.

## Manage a channel

```powershell
ahp-channels channel status telegram
ahp-channels channel switch telegram --session <new-session-uri>
ahp-channels channel stop telegram
ahp-channels channel start telegram
ahp-channels channel delete telegram
```

The daemon starts on demand, remembers desired running channels, and restarts
them after a daemon or channel-process restart. A switch is rejected while the
channel is processing a turn, so an in-flight reply is never silently orphaned.
Inbound events with stable platform IDs are journaled before AHP dispatch and
deduplicated across process restarts.

Deleting a channel also removes its keyring entries and isolated state,
including allowlists, downloaded attachments, and pending event data.

```powershell
ahp-channels daemon status
ahp-channels daemon logs
ahp-channels daemon stop
ahp-channels daemon start
```

Control traffic uses a per-install random token over a local named pipe on
Windows or a mode-`0600` Unix socket. Configuration writes are atomic and use a
heartbeat-backed cross-process lock.

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
```

See [SHIPPING.md](./SHIPPING.md) for the npm prerelease gates and
[PUBLISHING.md](./PUBLISHING.md) for the tag-driven release process.