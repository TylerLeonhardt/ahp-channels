# Publishing

`ahp-channels` uses the same tag-driven npm release model as
[`TylerLeonhardt/ahpx`](https://github.com/TylerLeonhardt/ahpx).

Pushing `vX.Y.Z` runs [publish.yml](./.github/workflows/publish.yml). The
workflow publishes the version already committed in `package.json`; it never
bumps versions itself.

## Bootstrap the package once

The package must exist on npm before its trusted publisher can be configured.
From a trusted machine:

```powershell
npm adduser
cd C:\path\to\ahp-channels
npm run check
npm run test:package
npm publish --tag next --provenance=false
```

The local bootstrap disables provenance because it does not run in an OIDC
environment. All later workflow publishes use trusted publishing and generate
provenance automatically.

Then open npmjs.com → `ahp-channels` → Settings → Trusted Publisher and set:

- Provider: GitHub Actions
- Owner: `TylerLeonhardt`
- Repository: `ahp-channels`
- Workflow: `publish.yml`
- Environment: leave blank

After confirming one OIDC release, set Publishing access to **Require 2FA and
disallow tokens**.

## Cut subsequent releases

```powershell
# Choose the intended version explicitly.
npm version prerelease --preid alpha --no-git-tag-version
# Or: npm version patch|minor|major --no-git-tag-version

$version = node -p "require('./package.json').version"
git add package.json package-lock.json src/version.ts
git commit -m "Bump version to $version"
git push origin main
git tag -a "v$version" -m "v$version"
git push origin "v$version"
```

The `npm version` lifecycle synchronizes `src/version.ts`, and the build fails
if it does not match `package.json`. The package smoke test verifies the CLI and
tarball versions; the publish workflow separately verifies the git tag.

Prerelease versions publish under npm's `next` tag. Stable versions publish
under `latest`.

Watch the release:

```powershell
gh run watch
npm view ahp-channels dist-tags --json
```

## Pipeline guarantees

The workflow:

1. Rejects a tag that differs from `package.json`.
2. Runs type checking, unit tests, and the build.
3. Installs and exercises the packed npm artifact.
4. Rejects versions already present on npm.
5. Publishes through npm OIDC trusted publishing.
6. Creates a matching GitHub Release.
