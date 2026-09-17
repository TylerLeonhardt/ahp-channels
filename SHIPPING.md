# Shipping checklist

## 0.1.0 release decision

Release after the automated quality, package, and cross-platform/E2E gates
pass. The maintainer explicitly deferred longer-running multi-plugin soak
testing to post-release follow-up; it is not claimed as completed by the
shorter automated or onboarding checks.

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
- [x] Publish `0.1.0-alpha.3` and `0.1.0-alpha.4` through GitHub Actions trusted
      publishing, with verified registry artifacts and provenance.
- [x] Verify the public registry install, daemon, signatures, and attestations.
- [x] Verify live Telegram and Discord channels on macOS against a local build.

## `0.1.0`

- [x] Contribute installed Open Plugins and their skills through AHP.
- [x] Serve contributed plugins through read-only AHP resource requests.
- [x] Translate bounded MCP rich content and resource links through standard
      MCP resource reads without widening plugin filesystem access.
- [x] Keep setup skills available when the channel MCP server cannot start.
- [x] Remove bridge-owned plugin secret, state, and access management.
- [x] Install plugins into immutable, versioned directories
      ([#1](https://github.com/TylerLeonhardt/ahp-channels/issues/1)).
- [x] Verify installed content and record source and Git provenance.
- [x] Pin channels across explicit upgrade, rollback, and prune operations.
- [x] Exercise the official fakechat plugin through its external UI across a
      daemon restart in CI.
- [x] Verify published `0.1.0-alpha.4` Telegram onboarding on macOS with fresh
      bridge configuration and plugin-owned token setup, including a real
      phone message/reply. Existing test bot and allowlist reused.
- [x] Verify published-prerelease Telegram onboarding on Linux; the user
      confirmed success on another machine.
- [x] Provide npm-first, cross-platform README setup instructions, explicit
      conversation selection and plugin setup, compatibility limits, and
      safe bridge upgrade guidance.
- [x] Add actionable channel health diagnostics.
- [x] Add log rotation.
- [x] Relay tool confirmations through permission-capable channels and verify
      approval and denial with fakechat.
- [x] Document plugin process environments and restart requirements for
      environment-only configuration.
- [x] Add paginated local-host session/chat selection and one safe
      host/session/chat handoff shared by terminal and agent controls.
- [x] Verify a pending agent-requested handoff across two isolated hosts,
      including source and destination external-channel replies.
- [x] Publish `0.1.0` through OIDC and verify its registry provenance.

Published as npm `latest` by
[GitHub Actions](https://github.com/TylerLeonhardt/ahp-channels/actions/runs/35183972812)
with a [stable GitHub release](https://github.com/TylerLeonhardt/ahp-channels/releases/tag/v0.1.0).
A clean install of the registry package passed CLI smoke checks; registry
signatures and SLSA provenance were verified against the release tag, merged
source commit, and publishing workflow.

## Post-0.1.0 follow-up

- [ ] Longer-running soak tests with fakechat, Telegram, and Discord through
      daemon restarts and plugin upgrades (explicitly deferred, not verified).
