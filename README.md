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
node .\dist\cli.js channel create telegram --plugin telegram --session <session-uri> --start
```

The CLI stores configuration under `~/.ahp-channels` by default. Override this
with `AHP_CHANNELS_HOME`.

Telegram currently requires Bun, matching the upstream plugin. The adapter
currently connects to discoverable TCP Agent Host endpoints; local socket
transports are on the roadmap.

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
npm run e2e:local
npm run e2e:daemon
```