# Approving and updating a baseline

An approved baseline is the reference a gate judges every future pull request against. Whoever
can change it decides what counts as a regression — so changing it is a separate, manual,
reviewed act, and the gate itself is not allowed anywhere near it.

Everything below applies to the example this repository ships ([examples/example-app](../
examples/example-app)) and to any application you point the same scripts at.

## What each workflow may do

Three workflows, deliberately split so that none of them can do another's job:

| Workflow | Trigger | May capture or approve? | What it does instead |
| -------- | ------- | ----------------------- | -------------------- |
| [`.github/workflows/visual-regression.yml`](../.github/workflows/visual-regression.yml) | `pull_request`, `push` to `main` | **No.** No `capture`, no `--approve`, no step that reaches for either. | Extracts the approved bundle from the base branch, loads it, compares the proposed code against it, and lets the comparison's exit code decide the job. |
| [`.github/workflows/visual-regression-demo.yml`](../.github/workflows/visual-regression-demo.yml) | `push` to `main`, manual | Yes — on purpose | The walkthrough: pass → deliberate regression → restore, plus a missing baseline, a tampered image and an unreachable application, asserting each documented exit code. It is a demonstration and an integration test, **not** a gate. |
| [`.github/workflows/baseline-update.yml`](../.github/workflows/baseline-update.yml) | `workflow_dispatch` only | Yes — this is the approval | Generates the baseline in the pinned image, exports the bundle, uploads it as an artifact and writes its provenance. It **commits nothing**. |

All three call the same scripts in [`scripts/ci/`](../scripts/ci), which are also runnable on your
own machine inside the pinned container:

```bash
bash scripts/ci/in-container.sh generate-baseline.sh --out /out/bundle --artifacts /out/reports
bash scripts/ci/in-container.sh run-gate.sh         --bundle /out/bundle
bash scripts/ci/in-container.sh walkthrough.sh      --bundle /out/bundle --trusted-ref HEAD
```

## The pinned rendering environment

A baseline is a screenshot. A screenshot depends on the machine that took it — the browser
build, the fonts, the rasteriser, the colour profile — so a comparison between images from two
different environments reports differences nobody made. Both the gate and the generator
therefore run in one container image, and the image is part of the approval rather than an
implementation detail.

### What is pinned

- **The browser build** — `playwright` is an exact dependency in `package.json` (no caret), the
  image tag carries that same version (`v1.64.1-noble`), and the generator records the Chromium
  revision the image ships (1248).
- **The image contents** — by tag *and* digest:
  `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a…`. Fonts, fontconfig, libc and the
  browser all come from these bytes; a tag alone could be re-pushed under us.
- **What the image does not decide**, the engine pins per capture: locale `en-US`, timezone
  `UTC`, light colour scheme, reduced motion, service workers blocked, the viewport preset's size
  and `deviceScaleFactor`, `--force-color-profile=srgb`, `--font-render-hinting=none`, hidden
  scrollbars, and fonts plus image decoding awaited before the shot.
- **The application's own bytes** — `.gitattributes` checks the rendered example application out
  with LF on every platform, so the baseline does not depend on who cloned the repository.
  (Measured: an LF checkout and a CRLF checkout of the same commit rendered the *same* 70,020
  bytes — HTML normalises line endings before layout — so this pin removes a question rather than
  fixing a bug.)

[`src/lib/ci/pinned-environment.test.ts`](../src/lib/ci/pinned-environment.test.ts) fails
`pnpm test` when any of these drift apart: if Playwright moves and the image tag, the digest or
the recorded Chromium revision do not move with it, the suite says so.

### What is and is not pinned

Measured, not asserted: **four separate runs** of `generate-baseline.sh` in this image — three on
the development machine (one of them from a checkout with CRLF line endings) and one on a
`ubuntu-latest` runner dispatched through the update workflow — produced byte-identical
screenshots: `sha256:28399ef61ab1a1e8fe14d462cf6f42fc01d4657214b87009c67a04ac1cc530e1`, 70,020
bytes, 1280 × 800. The runner's copy is
[run 38845231360](https://github.com/Azmk1/uiproof/actions/runs/38845231360), whose artifact also
records the image digest, Chromium revision 1248 and `fc-match system-ui` for the environment that
produced it. What that does *not* promise:

- **another architecture.** The image is multi-platform; the digest above is the index, so an
  arm64 runner gets arm64 Chromium. Rasters from two architectures are not guaranteed to match.
- **another image.** A different digest, a different Playwright release or a system browser with
  its own font set is a different environment. Regenerate the baseline there; do not relax the
  tolerance to hide it.
- **a changed page.** Live data, a remote font or an animation makes a capture non-deterministic
  no matter how pinned the browser is. The engine raises the tolerance or the page fixes itself;
  neither is served by a fake number.
- **the same image forever.** The digest is a deliberate value in this repository: it changes only
  when somebody changes it, and that change is a baseline update like any other.

### The provenance record

`generate-baseline.sh` prints and writes (`<artifacts>/provenance.txt`) the things a reviewer needs
to judge an approval without trusting a summary: the image reference and digest, Chromium
revision, Playwright and Node versions, what `system-ui` resolves to in that image
(`WenQuanYi Zen Hei` here — the reason a Windows-rendered baseline could never match a Linux
runner), the commit the application came from and whether its source was dirty, the scope, the
approved version id, the run that produced it, and the SHA-256 and byte count of both the bundle
manifest and the approved image.

## Generating an update

1. **Dispatch the workflow.** Actions → *Approved baseline update* → *Run workflow*, optionally
   with a note and a viewport. (It has no push or pull-request trigger: no pull request can reach
   it.) The machine equivalent is `in-container.sh generate-baseline.sh` above.
2. **Review the artifact.** Download `approved-baseline`. Read `provenance.txt`, look at the
   screenshot, and look at what would change in the repository: one new image and a manifest —
   nothing else, because reports stay in the store and never enter a bundle.
3. **Commit it in its own pull request.** The run has not touched the repository. The bundle's
   [CODEOWNERS](../.github/CODEOWNERS) entry asks for the owner's review, so "the gate changed
   its mind" is always a reviewable commit rather than a side effect.
4. **The next gate run uses it.** From that commit on, every pull request is measured against the
   new reference.

### Replacing an existing bundle, and the bootstrap case

An export refuses to overwrite an approved image: a version id that already exists with
*different* bytes is a conflict (`portable_bundle_invalid`, exit `2`). That is deliberate — it is
what stops an export from silently rewriting history.

To replace a bundle you therefore either delete the old images first (a visible, reviewable
`git rm`, which is exactly what the container-rendered bundle in this repository did when it
replaced the Windows-rendered one) or export into a fresh directory and move it into place. When
a repository has no bundle at all yet, the first `generate-baseline.sh` run creates one.

## What the gate does with a bundle

`scripts/ci/trusted-baseline.sh` extracts the bundle from a **commit** with `git archive`, and the
gate aims that at the pull request's base branch (`github.event.pull_request.base.ref`) — for a
push, at the branch the push landed on. It then verifies every image against the SHA-256 and byte
count the manifest records, reports how the working tree's copy differs, and passes the extracted
directory to `run-gate.sh`, which:

1. rebuilds the store from that bundle and activates the version the bundle already records
   (`--activate` selects an existing approval; it approves nothing),
2. refuses to continue if the store's active version is not the bundle's,
3. starts the application under test, waits for its health endpoint, and checks,
4. fails the job if the active version at check time is not the trusted one,
5. uploads reports, screenshots, the diff and a `gate-summary.json` whether it passed or failed.

Nothing in that path writes to the repository, and nothing approves anything.

## Repository settings a workflow cannot set

GitHub does not let a workflow protect itself, so these are manual, and without them the gate is a
signal rather than a gate:

- **Branch protection on the base branch → require status checks:** add `gate · trusted baseline`
  (the job name). A red gate then blocks the merge.
- **Require review from code owners** (and *dismiss stale approvals*): this is what makes the
  `examples/uiproof-baselines/` entry in CODEOWNERS effective for baseline updates.
- **Require branches to be up to date before merging:** otherwise a pull request can be checked
  against an older base commit than the one it merges into.
- **Restrict who can push to the base branch.** A baseline update must arrive as a pull request;
  direct pushes to `main` skip the review the whole procedure exists for.

Fork pull requests need no extra configuration: the gate reads no secrets and asks only for
`contents: read`, which is what GitHub gives a fork's workflow anyway.

## Failure modes

| Exit | Meaning | What to do |
| ---- | ------- | ---------- |
| `0` | The proposed code matches the approved baseline. | Nothing. |
| `1` | A real visual difference above the tolerance. | Review the uploaded `baseline.png`, `current.png` and `diff.png`. Either fix the UI, or — deliberately — run the update workflow and commit a new baseline. |
| `2` `baseline_not_found` | The trusted bundle has no approval for this scope. | Check the project/route/viewport names, or approve one with the update workflow. |
| `2` `baseline_integrity_failed` | An image in the bundle is not the image its manifest records. | Re-export the bundle. Never hand-edit an image or a hash. |
| `2` `portable_bundle_invalid` | The bundle or a path in it is malformed, or an export would overwrite a differing image. | Re-export into a fresh directory; replace the bundle deliberately. |
| `2` `project_unreachable` | The application under test is not answering. | Fix the start command, the port or the health endpoint. |
| `2` `browser_unavailable` | Chromium is missing. | Use the pinned image, or `pnpm exec playwright install chromium`. |
| `2` anything else | The check could not answer. | Read the message: it names the file, the origin or the setting that stopped it. |

Two situations deserve a note because they look like failures and are not:

- **The base branch moved after the pull request was opened.** If `main`'s baseline was updated,
  an older pull request is now compared against the newer reference and may fail. Rebase: that is
  the honest outcome, not a bug.
- **The image digest changed.** New Chromium, new fonts. Regenerate the baseline in the new image
  rather than adjusting tolerance.

## Untrusted pull requests

- `permissions: contents: read` and no repository secret referenced anywhere in the gate job.
- The application under test is started with `env -i` (`scripts/ci/lib.sh`): it inherits a PATH, a
  HOME and its own port, never the workflow's environment.
- The gate never commits, never approves, and never runs on `pull_request_target`.
- The capture surface is unchanged from the CLI: loopback origins and registered routes only.

## Verified

On GitHub Actions, `ubuntu-latest`, everything inside the pinned container:

| What | Evidence |
| ---- | -------- |
| Gate passes on `main`, exit `0`, `changed: 0%`, reference `bl-c6198d4d…` | [run 38844220690](https://github.com/Azmk1/uiproof/actions/runs/38844220690) (`df1312a`) |
| Walkthrough: `0` unchanged, `1` changed, `0` restored, `2` missing baseline, `2` tampered image, `2` unreachable app — 17/17 assertions | [run 38844220574](https://github.com/Azmk1/uiproof/actions/runs/38844220574) |
| Project CI (lint · typecheck · 188 unit tests · build · 46 browser tests) | [run 38844220557](https://github.com/Azmk1/uiproof/actions/runs/38844220557) |
| A real UI change fails the gate with exit `1` (0.4404 % of the viewport, 4,510 px) | [PR #1, run 38844548795](https://github.com/Azmk1/uiproof/actions/runs/38844548795) |
| The same pull request shipping a bundle that *matches* its own change still fails: the log warns the working-tree bundle differs and reports `exit 1` against `bl-c6198d4d…` | [PR #1, run 38844710523](https://github.com/Azmk1/uiproof/actions/runs/38844710523) |
| With the UI reverted, the same pull request passes while still carrying its own bundle | [PR #1, run 38844749739](https://github.com/Azmk1/uiproof/actions/runs/38844877047) |
| Reproducible generation: four runs on two machines, one image hash (`28399ef6…c530e1`, 70,020 bytes) | [bundle README](../examples/uiproof-baselines/README.md) |
| The update workflow runs end to end on a runner, uploads the bundle and touches nothing: the regenerated PNG is byte-identical to the committed one | [run 38845231360](https://github.com/Azmk1/uiproof/actions/runs/38845231360) |
| Tampered image: `baseline_integrity_failed` naming both hashes | walkthrough scenario 6, run 38844220574 |

Locally, in the same image: the pull request's own bundle was loaded and compared against the pull
request's own UI — `PASS 0% of the viewport changed (0 of 1,024,000 px)`, exit `0`. The approval
was legitimate and pixel-exact; the gate rejected the change anyway, because its reference comes
from the base branch.

## Cost

One gate run is roughly two minutes of `ubuntu-latest` inside a ~3.6 GB image: install, extract
the bundle, start the application, one capture, one comparison. The update workflow costs the
same. Neither needs a paid service, a hosted backend or a model.
