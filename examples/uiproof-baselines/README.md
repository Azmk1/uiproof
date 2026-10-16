# Example portable baseline bundle

This directory is a **portable approved baseline**: the canonical, committable form of an
approval, and the reference the pull-request gate compares against. It is not runtime state —
there are no run reports in here, only approvals. If it changes, what counts as a visual
regression changes with it, which is why changing it is a reviewed operation
([docs/BASELINE-UPDATES.md](../../docs/BASELINE-UPDATES.md)) and why
[CODEOWNERS](../../.github/CODEOWNERS) routes it to its owner.

```text
examples/uiproof-baselines/
├── uiproof-baselines.json                                          scopes, versions, SHA-256
└── scopes/projects/example-app/home/desktop/versions/
    └── bl-c6198d4d-aaab-49e2-b321-c7e78964dc19.png                 the approved screenshot
```

| Field | Value |
| ----- | ----- |
| Scope | `project:example-app/home` |
| Viewport | `desktop` (1280 × 800, `deviceScaleFactor` 1) |
| Route captured | `/` of [examples/example-app](../example-app) |
| Version | `bl-c6198d4d-aaab-49e2-b321-c7e78964dc19` (active) |
| Integrity | `sha256:28399ef6…c530e1`, 70,020 bytes, 1280 × 800 — verified before every import |
| Rendered by | `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf` |
| Browser | Playwright 1.64.1, Chromium build 1248, Node 24.21.0 |
| Fonts | the image's fontconfig; `system-ui` resolves to *WenQuanYi Zen Hei* |

## How it was produced

Not by hand, and never by the gate. `scripts/ci/generate-baseline.sh` starts the example
application, captures `/`, approves the capture as the active baseline, exports this bundle and
writes a provenance record — inside the pinned image above, which is the same image the gate
runs in:

```bash
# the documented path: the "Approved baseline update" workflow (workflow_dispatch), or the
# same thing on your own machine:
bash scripts/ci/in-container.sh generate-baseline.sh --out /out/bundle --artifacts /out/reports
```

The provenance of the committed bundle — image digest, Chromium revision, fontconfig's
`system-ui`, the commit, the image SHA-256 — is printed by that run and written to
`reports/provenance.txt` next to it, so a reviewer sees the environment and the bytes rather
than a promise.

**The image is the environment.** A screenshot only matches another screenshot taken by the
same Chromium build with the same fonts, so `visual-regression.yml` (the gate),
`visual-regression-demo.yml` (the walkthrough) and `baseline-update.yml` all run in the image
recorded above, and the engine pins what the environment alone does not: locale `en-US`,
timezone `UTC`, light colour scheme, reduced motion, the viewport preset's size and device
scale factor, service workers blocked, colour profile `srgb`, no font hinting, hidden
scrollbars, and fonts and images awaited before the shot.

**Reproducibility, measured rather than asserted.** Four separate runs of
`generate-baseline.sh` in that image — three on the machine that developed this, one of them from a
checkout with CRLF line endings, and once on a `ubuntu-latest` runner through the
[update workflow](../../.github/workflows/baseline-update.yml)
([run 38845231360](https://github.com/Azmk1/uiproof/actions/runs/38845231360)) — all produced
**byte-identical** screenshots:
`sha256:28399ef61ab1a1e8fe14d462cf6f42fc01d4657214b87009c67a04ac1cc530e1`, 70,020 bytes,
1280 × 800. That includes the CI-side check that matters most: a runner regenerating this bundle
today gets exactly these bytes back. What it does *not* cover is honest to say out loud: a different
font set, a different Chromium build, a different libc, another architecture or a page with live data
can each move pixels, so a changed image digest means "regenerate the baseline", not "the baseline is
wrong" (see [docs/BASELINE-UPDATES.md](../../docs/BASELINE-UPDATES.md#what-is-and-is-not-pinned)).

## How a gate uses it

`scripts/ci/trusted-baseline.sh` extracts this directory from a **commit** — `git archive`, not
the working tree — and [.github/workflows/visual-regression.yml](../../.github/workflows/visual-regression.yml)
extracts it from the pull request's base branch. The check then loads it with

```bash
uiproof baselines import --from <extracted bundle> --activate
uiproof check --project example-app --route home
```

Nothing in that path captures or approves anything: the images in a bundle were approved when
the bundle was produced, and `--activate` only selects the version the bundle already records
as active. A pull request that rewrites this directory changes nothing about its own verdict —
the gate reads the base commit, and the walkthrough proves it by doing exactly that.

## Updating it

Run the update workflow (or `in-container.sh generate-baseline.sh`), review the artifact, and
commit the bundle in its own pull request. Exporting never overwrites an approved image: a
version id that already exists with *different* bytes is a conflict, and an import that finds
identical bytes is a no-op. Full procedure, including the manual branch-protection settings that
make the gate blocking rather than decorative, in
[docs/BASELINE-UPDATES.md](../../docs/BASELINE-UPDATES.md).
