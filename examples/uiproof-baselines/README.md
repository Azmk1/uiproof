# Example portable baseline bundle

This directory is a **portable approved baseline** — the committable form of the approval a
developer gives in the console or with `uiproof capture --approve`. It is here so the CI
example (and anyone reading the repository) has a real bundle to load:

```bash
pnpm uiproof baselines import --from examples/uiproof-baselines --activate \
  --config examples/ci/uiproof.config.json
```

```text
examples/uiproof-baselines/
├── uiproof-baselines.json                                        every scope, version and SHA-256
└── scopes/projects/example-app/home/desktop/versions/
    └── bl-18d99168-047b-4730-9fee-9a28f0f80639.png               the approved screenshot
```

## What it holds

| Field                 | Value                                          |
| --------------------- | ---------------------------------------------- |
| Scope                 | `project:example-app/home`                     |
| Viewport              | `desktop` (1280×800)                           |
| Route captured        | `/` of `examples/example-app`                  |
| Approved              | 2026-10-16, from run `run-5787566d-…` (Phase 4) |
| Integrity             | SHA-256 + byte count + dimensions in the manifest |

There are no run reports in here: a bundle carries *approvals*, never comparison results.
Reports stay in the store (`<cwd>/.uiproof/data/reports/<run id>`).

## How it was produced

```bash
HOST=127.0.0.1 PORT=4173 node examples/example-app/server.mjs &
pnpm uiproof capture --project example-app --route home --approve --config examples/ci/uiproof.config.json
pnpm uiproof baselines export --project example-app --route home --out examples/uiproof-baselines \
  --config examples/ci/uiproof.config.json
```

Importing is verified twice over: `parsePortableBundle` proves the manifest is internally
consistent and every file sits where a version of that scope must sit, and the store checks
each PNG against the recorded SHA-256, byte count and dimensions before writing it. A
version that already exists with the same image is a no-op; with a *different* image it is a
conflict, because approved versions are immutable. Nothing here is activated unless
`--activate` asks for it.

## One honest caveat: rendering environments

A baseline is a screenshot, and screenshots depend on the machine that rendered them — its
Chromium build, its fonts, its rasteriser. This bundle was approved on **Windows**, where the
example application's `system-ui` font stack resolves to Segoe UI; a Linux runner resolves it
to a different font, so a pixel-for-pixel comparison against *this* image is expected to
differ there.

That is why [the example workflow](../../.github/workflows/visual-regression.yml) uses this
bundle to prove the portable path (a clean runner can load it and read a real verdict), and
approves its own baseline for the gate it enforces. If you want one image to gate several
machines, generate it in the environment that gates — the same container image, ideally — and
commit that artifact instead. `pnpm uiproof baselines export` after a CI capture is how you
produce it.
