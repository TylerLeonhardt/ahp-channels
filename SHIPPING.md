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

## 0.1.1 maintenance correction

- Serialize configuration-file reads and atomic replacements to prevent
  Windows `EPERM` failures during status polling and handoff commits.
- Queue same-process file-lock owners directly while retaining cross-process
  filesystem locks and separate configuration transaction ownership.
- Cover held I/O locks, concurrent readers/updates, failed-owner recovery, and
  repeated Windows daemon lifecycle checks.

## 0.1.2 extension and setup reliability

- Allow setup-only channels to move to another validated session before their
  messaging server is configured, without weakening healthy-channel rollback
  or busy-session protection.
- Reject handoffs if the source disconnects during asynchronous validation;
  preserve the committed source for recovery.
- Show setup-only versus connected status, recovery guidance, retry state,
  and failed-handoff details in the extension.
- Fix cold startup of the VSIX's ESM daemon with bundled CommonJS dependencies.
- Preserve Unix-socket and Windows named-pipe targets under VS Code's HTTP
  proxy handling without disabling proxy support.
- Cover real extension-command daemon startup, reuse, shutdown, and startup
  diagnostics, plus transport behavior under the actual VS Code proxy wrapper.
- Include the matching VSIX and `vscode install` / `vscode path` commands in
  the npm release. Marketplace upload remains a separate manual step.

Schema version 2 configuration remains unsupported. Its one-off dogfooding
migration is separate from these runtime fixes.

## 0.1.3 runtime prerequisite diagnostics

- Identify missing MCP executables or interpreters using the actual launch
  result, with install and daemon PATH guidance shared by CLI and extension.
- Distinguish missing or invalid working directories from missing runtimes.
- Preserve setup skills and actionable guidance while retaining native
  environment lookup, permission errors, and retry behavior.
- Cover overridden PATH, relative and absolute commands, installation between
  attempts, and unchanged post-launch failures.
- Document the LF credential-file workaround for affected Telegram and
  Discord versions without rewriting plugin-owned files.

No upstream plugin parser changes, automatic runtime installation, or
configuration migration are included.

## Post-0.1.0 follow-up

- [ ] Longer-running soak tests with fakechat, Telegram, and Discord through
      daemon restarts and plugin upgrades (explicitly deferred, not verified).
