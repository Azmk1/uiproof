# Repair fixture

The application the Phase 8 repair tests point UIProof at. It is deliberately plain — a
dependency-free Node server that reads `views/` on every request — so a patch applied inside
the isolated sandbox is genuinely what the sandbox server serves.

It ships four independent, deliberate defects:

| Defect | Where | Issue key the engine offers |
| ------ | ----- | --------------------------- |
| Missing accessible name | `#email` in `views/index.html` | `a11y:label@#email` |
| Insufficient contrast | `.note` at `#9a9a9a` on `#f7f7f8` | `a11y:color-contrast@.note` |
| Mobile horizontal overflow | `#maintenance-banner` at `720px` | `responsive:mobile` |
| Visual regression | `views/visual.broken.html` against `visual.good.html` | `visual:desktop` |

## Run it

```bash
node server.mjs                 # http://127.0.0.1:4180
PORT=4199 node server.mjs       # what the repair sandbox uses
```

`scripts/check-build.mjs` parses every view and refuses unbalanced tags, so a patch that breaks
the markup fails the build for real. `scripts/check-tests.mjs` is the "test" command: a small
assertion over the views that a destructive patch can actually break. Neither is a marker grep.

## Use it with UIProof

Start the app and register this directory, then run an audit and a repair:

```bash
# from the UIProof checkout
UIPROOF_PROJECTS_FILE=examples/repair-app/uiproof.config.json pnpm dev
# or, headless:
UIPROOF_PROJECTS_FILE=examples/repair-app/uiproof.config.json \
  pnpm uiproof audit --project repair-app --route support
UIPROOF_PROJECTS_FILE=examples/repair-app/uiproof.config.json \
  pnpm uiproof repair --audit <audit id> --max-attempts 1
```

A repair needs `UIPROOF_AI_API_KEY` (any OpenAI-compatible endpoint). The automated tests do
not use this file: they start a disposable copy of this directory, register it with a
temporary config, and drive the engine against a deterministic model stub, because a test
must not spend a real model's quota or depend on network access.
