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
node .\dist\cli.js channel run telegram --session <session-uri>
```

The CLI stores configuration under `~/.ahp-channels` by default. Override this
with `AHP_CHANNELS_HOME`.

Telegram currently requires Bun, matching the upstream plugin. Phase 1 connects
to discoverable TCP Agent Host endpoints; local socket transports are on the
roadmap.

## Status

The first milestone targets one installed stdio MCP channel, one local AHP host,
and one existing AHP chat. See [ROADMAP.md](./ROADMAP.md).

## Development

```powershell
npm test
npm run typecheck
npm run build
npm run e2e:local
```