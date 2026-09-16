# Shipping checklist

## Published prereleases

- [x] Claude-style MCP channel compatibility.
- [x] TCP, Windows named-pipe, and Unix-socket Agent Host connections.
- [x] Named instances with daemon start, stop, restart, status, and switch.
- [x] Durable event replay and deduplication.
- [x] Windows, macOS, and Linux CI.
- [x] Installed-package smoke test.
- [x] Live direct bridge and two-session daemon switch tests.
- [x] Confirm the `ahp-channels` npm package name is available.
- [x] Choose and add the repository license (MIT).
- [x] Add the tag-driven OIDC publish workflow and release documentation.
- [x] Bootstrap `0.1.0-alpha.1` under the npm `next` tag.
- [x] Verify npm's required first-version `latest` behavior.
- [x] Configure npm trusted publishing for `TylerLeonhardt/ahp-channels`.
- [x] Publish `0.1.0-alpha.2` through OIDC with SLSA provenance.
- [x] Verify the public registry install, daemon, signatures, and attestations.
- [x] Verify live Telegram and Discord channels on macOS against a local build.

## `0.1.0`

- [x] Contribute installed Open Plugins and their skills through AHP.
- [x] Serve contributed plugins through read-only AHP resource requests.
- [x] Keep setup skills available when the channel MCP server cannot start.
- [x] Remove bridge-owned plugin secret, state, and access management.
- [x] Install plugins into immutable, versioned directories
      ([#1](https://github.com/TylerLeonhardt/ahp-channels/issues/1)).
- [x] Verify installed content and record source and Git provenance.
- [x] Pin channels across explicit upgrade, rollback, and prune operations.
- [x] Exercise the official fakechat plugin through its external UI across a
      daemon restart in CI.
- [ ] Run a fresh-machine Telegram setup from the published prerelease using
      plugin-owned configuration.
- [ ] Soak the alpha with fakechat, Telegram, and Discord.
- [x] Add actionable channel health diagnostics.
- [x] Add log rotation.
- [ ] Document credential injection and restart requirements for plugins that
      accept credentials only through their environment.
- [ ] Resolve alpha feedback and document host, protocol, and plugin
      compatibility limits.
- [ ] Publish `0.1.0` through OIDC and verify its registry provenance.
