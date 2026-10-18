# Release checklist

UIProof is a release candidate, not a published package. This page is the procedure that turns a
commit into a tarball someone else can install, and the settings that keep a release from being an
accident.

Publishing — to npm or anywhere else — is a deliberate, human step at the bottom of this page, and
nothing in the repository or in CI performs it.

## The version

`package.json` carries the only version in the project. The CLI reports it (`uiproof --version`), the
dashboard footer shows it, and `e2e/distribution.test.ts` asserts that the version a packed tarball
reports is the version that was packed. `CHANGELOG.md` documents what changed; it is not a second
source of truth for the number.

## What must pass first

Run in this order, on the platform you are releasing from:

| Step | Command | What it proves |
| ---- | ------- | -------------- |
| 1 | `pnpm install --frozen-lockfile` | The lockfile is the resolution; no drift from the committed one. |
| 2 | `pnpm lint` | ESLint, clean. |
| 3 | `pnpm typecheck` | `tsc --noEmit` on the strict config. |
| 4 | `pnpm test` | The unit suite: the engine, the guards, the stores, the parsers, the CLI, the pinned CI environment. |
| 5 | `pnpm build` | The production dashboard builds. |
| 6 | `pnpm test:e2e` | The browser suite, including `e2e/distribution.test.ts` (the real pack → install → drive cycle). Docker and Chromium change what runs here; a skipped container suite is a skipped check, not a pass. |
| 7 | `pnpm benchmark` | The ten-defect corpus. In `deterministic-stub` mode it is a regression check on the repair pipeline; with a key it is the live-model measurement. Commit the resulting `docs/benchmark/latest.json` and `latest.md`. |

`pnpm verify` chains 2–6. Steps 6 and 7 need Chromium (`pnpm setup:browser`); steps 6 and 7 need a
container runtime.

Then check the two things a test cannot:

- `pnpm uiproof --version` prints the version you intend to release.
- `docs/benchmark/latest.md` names the mode, model and runtime you believe it ran under, and its
  caveats are still the caveats you mean.

## Packing, and installing what you packed

```bash
pnpm pack:local --pack-destination /tmp        # runs prepack → dist/cli/uiproof.mjs, then packs
tar -xOf /tmp/uiproof-<version>.tgz package/package.json | head -20
```

The tarball must contain exactly six entries — `package.json`, `README.md`, `CHANGELOG.md`,
`docs/REPAIR-SECURITY.md`, `bin/uiproof.mjs`, `dist/cli/uiproof.mjs` — and the version inside it must
be the version you are releasing. `e2e/distribution.test.ts` asserts both, byte for byte, so it is
usually enough to read that test's result rather than repeat it. When in doubt, install the tarball
into an empty directory outside the checkout and run one capture and one check against an application
in a third directory; that is exactly what the suite does.

`package.json` keeps `"private": true` in the repository. That flag is the guard rail: a stray
`pnpm publish` from a checkout fails instead of releasing.

## Publishing (a human decision, not a step in CI)

Only the package owner does this, from a clean checkout of the commit they intend to release:

1. Decide the version and update `package.json`; add the `CHANGELOG.md` entry for it.
2. Confirm the checks above, including the distribution suite on that exact commit.
3. Remove `"private": true` in the working tree. Do not commit it removed — the guard stays on in the
   repository, and publishing from a modified tree is the point.
4. `pnpm publish --tag next --no-git-checks` (or `--tag latest` when the release candidate is the
   intended default; a pre-release version should not take `latest`).
5. Tag the commit (`git tag v<version>`) and push the tag together with the changelog commit.
6. Restore the working tree (`git checkout -- package.json`) so the guard is back.

If a release has to be withdrawn, deprecate the version rather than deleting it
(`npm deprecate uiproof@<version> "…"`): consumers that pinned it need to see why, not a missing
version. Nothing in this repository deletes or overwrites published artifacts.

## What a release still depends on

- **Playwright's Chromium.** The CLI needs a browser on the machine that runs it. The pin
  (`playwright@1.64.1`), the browser revision and the rendering image used by the CI gate are checked
  by `pnpm test`; a consumer installs Chromium once with `npx playwright install chromium`.
- **A container runtime for repairs.** Capture, compare, audit and the gate work without one; a
  repair refuses to run rather than running generated code unconfined. See
  [REPAIR-SECURITY.md](REPAIR-SECURITY.md).
- **The rendering environment for baselines.** An approved baseline is pixel-exact only for the
  environment that rendered it. The committed example bundle is reproducible inside the pinned image
  the gate runs in; a different image digest or architecture means regenerating it, not reusing it.
