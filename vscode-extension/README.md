# AHP Channels for VS Code

Manage the `ahp-channels` daemon, install channel plugins, create and control
channels, and point channels at existing Agent Host Protocol sessions.

Open **AHP Channels** from the Activity Bar. Right-click a session and choose
**Point Channel Here** to redirect a configured channel to that session.

Use a channel's hover controls or right-click menu to start or stop it.
**Stop Channel** and **Restart Channel** remain available when a running channel
reports an error, including when plugin setup is incomplete. You can also run
**AHP Channels: Stop Channel** from the Command Palette and select the channel.

The extension is bundled with the
[`ahp-channels`](https://www.npmjs.com/package/ahp-channels) npm package.
