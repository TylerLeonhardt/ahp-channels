# Publishing

`ahp-channels` uses the same tag-driven npm release model as
[`TylerLeonhardt/ahpx`](https://github.com/TylerLeonhardt/ahpx).

Pushing `vX.Y.Z` runs [publish.yml](./.github/workflows/publish.yml). All npm
releases are published by GitHub Actions with trusted publishing and
provenance. **Do not run `npm publish` locally.** Local validation may build,
pack, and install the package, but publication belongs to the workflow.

The workflow publishes the version already committed in `package.json`; it
never bumps versions itself and rejects release commits that are not on
`main`.

The `prepack` lifecycle also builds
`vscode-extension/ahp-channels-vscode-<version>.vsix` and includes it in the
npm tarball. `npm version` keeps the extension manifest version synchronized
with the package version.

## Trusted publishing configuration

The package is already bootstrapped on npm. Its trusted publisher is configured
under npmjs.com → `ahp-channels` → Settings → Trusted Publisher:

- Provider: GitHub Actions
- Owner: `TylerLeonhardt`
- Repository: `ahp-channels`
- Workflow: `publish.yml`
- Environment: leave blank

Keep publishing access set to **Require 2FA and disallow tokens**. The workflow
uses `id-token: write` for OIDC; no long-lived npm publishing token is required.

Provenance requires the GitHub source repository to be public. A private source
repository authenticates through OIDC but npm rejects the provenance bundle
with HTTP 422.

## Prepare a release PR

Start from a clean, current `main` checkout. For the `0.1.0` release:

```powershell
git switch main
git pull --ff-only

git switch -c release/v0.1.0
npm version 0.1.0 --no-git-tag-version
npm run check
npm run test:package

$version = node -p "require('./package.json').version"
git add package.json package-lock.json src/version.ts
git commit -m "Bump version to $version"
git push -u origin HEAD
gh pr create --base main --title "release: prepare v$version" --body "Prepare v$version for npm publication."
```

Review and include any release documentation or workflow changes in the PR as
well. For a later release, choose the intended version and branch explicitly;
use `npm version prerelease --preid alpha --no-git-tag-version` for another
alpha or an explicit stable version to leave the prerelease line.

`main` requires passing Ubuntu, macOS, Windows, and E2E checks. Merge the
release PR after those checks pass; do not bypass branch protection or publish
an unmerged release commit.

## Trigger GitHub Actions publication

Create the release tag from the verified merged release commit. Check the
version and commit before tagging, especially if `main` moved after the PR
merged:

```powershell
git switch main
git pull --ff-only
$version = node -p "require('./package.json').version"
git tag -a "v$version" -m "v$version"
git push origin "v$version"
```

The `npm version` lifecycle synchronizes `src/version.ts`, and the build fails
if it does not match `package.json`. The package smoke test verifies the CLI and
tarball versions; the publish workflow separately verifies the git tag.

Prerelease versions publish under npm's `next` tag. Stable versions publish
under `latest` and create a non-prerelease GitHub Release marked latest.
Publishing a stable version does not move `next`; consumers should install
`ahp-channels` or `ahp-channels@latest` for stable updates.

Historically, npm assigned the first alpha to `latest` because it was the first
publication. The first stable release replaces that tag normally.

Watch the **Publish to npm** workflow, not just the CI run on `main`:

```powershell
gh run list --workflow publish.yml
gh run watch "PUBLISH_RUN_ID" --exit-status
npm view ahp-channels dist-tags --json
gh release view "v$version"
```

The npm registry may take a few minutes to expose a successfully published
version. Verify the version-specific metadata, `dist.attestations`, and a
clean install before declaring release verification complete. Do not republish
the same version to work around propagation delay.

If publishing fails, inspect the workflow logs. Do not fall back to local
publication, move a published tag, or overwrite an npm version. If npm accepted
the package but a later step failed, establish that outcome before deciding
which recovery step to rerun.

## Pipeline guarantees

The workflow:

1. Rejects a tag whose commit has not reached `main`.
2. Rejects a tag that differs from `package.json`.
3. Runs type checking, unit tests, and the build.
4. Installs and exercises the packed npm artifact.
5. Verifies the bundled VS Code extension is addressable through
   `ahp-channels vscode path`.
6. Rejects versions already present on npm.
7. Publishes through npm OIDC trusted publishing.
8. Creates a matching GitHub Release with the appropriate prerelease/latest flag.
