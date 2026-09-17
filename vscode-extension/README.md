# AHP Channels

**Your agent conversations, connected to your chat apps.**

Connect Claude Code channel plugins, including Discord and Telegram, to an
existing [Agent Host Protocol](https://www.npmjs.com/package/@microsoft/agent-host-protocol)
conversation. Install plugins, manage the background daemon, and choose where
messages go without leaving VS Code.

**The runtime and daemon are bundled. No separate `ahp-channels` CLI installation
is required.**

<p align="center">
  <img src="./media/screenshot.png" alt="AHP Channels in VS Code, showing a running daemon, connected Discord and Telegram channels, installed plugins, and available agent sessions." width="520">
</p>

## One view for your channels

Open **AHP Channels** in the Activity Bar.

| Section | What you can do |
| --- | --- |
| **Daemon** | Start, stop, or restart the background daemon and open its log. |
| **Channels** | Create named channels, check their status, and control or redirect them. |
| **Plugins** | See installed plugins and their versions, and install more from a marketplace. |
| **Sessions** | Browse conversations from discovered local Agent Hosts and pick a destination. |

Actions are available through hover buttons, right-click menus, and the Command
Palette. Search for **AHP Channels** to see the commands.

## Before you start

- **A running local Agent Host and an existing agent conversation.** Use a VS Code
  build that exposes Agent Host endpoints, with your agent provider configured.
  An ordinary editor window alone does not guarantee a host is available.
- **Git** on your PATH for installing marketplace plugins.
- **Your plugin's runtime and account requirements.** The official Discord and
  Telegram plugins currently require [Bun](https://bun.sh/docs/installation).

The extension manages the channel daemon, not the Agent Host itself. It does not
create conversations or sign you in to an agent provider.

## Connect your first channel

1. Open **AHP Channels** from the Activity Bar.
2. Choose **Install Plugin...** and enter a plugin specification:
   - Discord: `discord@claude-plugins-official`
   - Telegram: `telegram@claude-plugins-official`
3. Choose **Create Channel...**, select the installed plugin and receiving
   session, and give the channel a name. The daemon starts automatically.
4. Open **that same agent conversation** and complete the plugin's setup:
   - Discord: `/discord:configure`, then `/discord:access`
   - Telegram: `/telegram:configure`, then `/telegram:access`
5. Follow the plugin's pairing instructions, send a message from your chat app,
   and verify that the agent replies there.

The setup and access commands are **agent skills, not shell commands**. Keep bot
tokens private, follow the plugin's credential-storage guidance, and approve
only the senders you want to reach your agent.

## Point a channel at another conversation

In the AHP Channels view, right-click a row under **Sessions**, choose
**Point Channel Here...**, and select the channel to move.

You can also right-click a channel and choose **Select Session...**. The chosen
session receives subsequent messages; it does not have to be the conversation
currently focused in the editor.

## Controls and troubleshooting

**Stop Channel** disables the channel and its automatic retries.
**Restart Channel** retries it immediately when the conversation is idle.
Both remain available for an enabled channel reporting an error.
Stopping the daemon stops all its channels; closing the view does not stop it.

### No sessions are listed

Make sure a supported local Agent Host is running and has an existing
conversation, then choose **Refresh**. Check the **AHP Channels** output channel
for connection or discovery errors.

### A channel reports an error during setup

A plugin may need credentials before its messaging server can start. Its setup
skills can still be available in the selected session. Finish setup there; the
daemon retries after the setup turn completes.

Use **Open Daemon Log** for the plugin's diagnostic, such as a missing bot token
or Bun installation. A generic `MCP error -32000: Connection closed` is not the
underlying cause.

### A setup skill is missing

Make sure you are in the channel's selected conversation. If an unconfigured
channel cannot switch sessions because its messaging server will not start,
**Stop Channel**, select the new session, then **Start Channel**.

## Settings and the CLI

| Setting | Description |
| --- | --- |
| `ahpChannels.home` | Override the bridge's state directory. Leave empty to use `AHP_CHANNELS_HOME`, or `~/.ahp-channels` when it is unset. |

The extension and the optional [CLI](../README.md) share their daemon,
configuration, and installed plugins when they use the same state directory.
Plugin credentials and access policies remain plugin-managed. Use only one
running bridge per bot account.

---

[Documentation](../README.md) |
[Source code](https://github.com/TylerLeonhardt/ahp-channels) |
[Report an issue](https://github.com/TylerLeonhardt/ahp-channels/issues)
