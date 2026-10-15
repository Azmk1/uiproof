# UIProof

**Automated frontend quality platform.** UIProof renders a screen, compares it against a known-good
baseline, and tells you exactly which pixels moved — with the measured share of the viewport that
changed, the highlighted difference image, and the artifacts stored on disk.

Phase 1 is the foundation and the first fully working workflow: a local visual regression engine
plus the developer console that drives it. Later phases add accessibility and design-consistency
checks, GitHub integration, and AI-assisted repair proposals — none of that is wired up yet.

---

## What works today

- **A real comparison engine.** Headless Chromium captures both sides of a target at identical
  viewport settings; [pixelmatch](https://github.com/mapbox/pixelmatch) compares the PNGs and paints
  a highlighted difference image. Nothing is mocked: every number on screen comes from counted
  pixels.
- **A developer console** at `/` to pick a target, a viewport and a tolerance, run the pipeline,
  inspect baseline / current / difference screenshots, and reload any earlier run.
- **Two local demo fixtures** with deliberate, documented visual differences, so the engine is
  testable the moment the app boots.
- **Local persistence.** Screenshots and the JSON report are written to `.uiproof/data`, so a page
  refresh — or a server restart — keeps the last run on screen.
- **A deliberately closed capture surface.** The engine only ever navigates to routes under `/demo`
  on its own origin. There is no way to point it at an arbitrary URL.

---

## Quick start

Requirements: **Node.js 20.19+** (24.x used here), **pnpm 10+**.

```bash
git clone https://github.com/Azmk1/uiproof.git
cd uiproof
pnpm install
pnpm setup:browser   # downloads the Chromium build Playwright drives (one-off, ~120 MB)
pnpm dev             # http://localhost:3000
```

Then walk the flow:

1. Open <http://localhost:3000>.
2. Keep the default target **Invoice summary card** and the **Desktop** viewport.
3. Press **Run comparison** (about 1–3 s: two captures plus the pixel diff).
4. Inspect **Baseline**, **Current** and **Difference**. The diff is the highlighted image.
5. Reload the page — the console reloads the newest stored run from disk.

Expected result on the shipping fixtures: a **regression** of roughly **3.8 %** of a 1280 × 800
viewport at desktop, or about **8.9 %** at the mobile preset. The **Control · same page twice**
target must always report exactly **0 %**.

### Demo fixtures

Both pages render the same React component (`InvoiceSurface`) with a different variant, so the only
pixel differences between them are deliberate:

| Route             | Role       | Deliberate differences                                                                                       |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `/demo/baseline`  | Reference  | —                                                                                                             |
| `/demo/current`   | Regressed  | “Docs” removed from the nav · heading weight/tracking changed · total $1,240.00 → $1,204.00 · primary action recoloured and reworded · “Save 10%” ribbon added |

The third target, **Control · same page twice**, captures `/demo/baseline` twice. It exists to prove
the engine produces zero changed pixels — and therefore no false positives — when nothing changed.

---

## Architecture

```
src/
├── app/
│   ├── layout.tsx                     # html/body, Geist fonts, design tokens
│   ├── globals.css                    # the design system: tokens, base styles, helpers
│   ├── (console)/                     # console chrome (header/footer)
│   │   ├── layout.tsx
│   │   ├── page.tsx                   # the dashboard at /
│   │   └── demo/page.tsx              # fixture index at /demo
│   ├── (fixtures)/demo/               # the screens under test (no console chrome)
│   │   ├── baseline/page.tsx
│   │   └── current/page.tsx
│   ├── api/                           # the HTTP surface (see below)
│   └── not-found.tsx
├── components/
│   ├── ui/                            # shadcn/ui primitives (button, card, tabs, badge, …)
│   ├── console/                       # dashboard composition: controls, verdict, viewer, history
│   ├── demo/                          # fixture app frame + invoice screen
│   └── layout/                       # brand mark, header, footer
└── lib/
    ├── compare/                       # ← the engine (no React, no DOM)
    │   ├── types.ts                   # shared domain types
    │   ├── metrics.ts                 # pure metric maths, verdicts, validation, formatting
    │   ├── targets.ts                 # viewport presets + trusted-route allow-list + targets
    │   ├── diff.ts                    # pure: decode PNG → normalise → pixelmatch → diff PNG
    │   ├── browser.ts                 # Chromium singleton with idle shutdown
    │   ├── capture.ts                 # deterministic Playwright capture
    │   ├── storage-paths.ts           # pure path rules + traversal guards
    │   ├── storage.ts                 # filesystem persistence of artifacts and reports
    │   ├── engine.ts                  # orchestrates one run
    │   └── errors.ts                  # typed errors → HTTP status mapping
    ├── http/                          # request trust + capture origin resolution
    ├── api-client.ts                  # typed fetch client used by the console
    └── format-time.ts
```

### Pipeline

```
POST /api/compare
      │
      ├─ validate target id ──► targets.ts     (allow-list, not user input)
      ├─ validate viewport  ──► targets.ts
      ├─ validate tolerance ──► metrics.ts
      │
      ├─ capture /demo/baseline ┐
      │                         ├─ capture.ts (one shared Chromium, viewport-sized PNG)
      └─ capture /demo/current  ┘
                 │
                 ├─ decode + dimension match ──► diff.ts
                 ├─ pixelmatch ────────────────► changed pixels + diff PNG
                 └─ verdict ───────────────────► metrics.ts
                 │
                 └─ write 3 PNGs + report.json ──► storage.ts (.uiproof/data)
```

**Separation of concerns.** The comparison layer is plain TypeScript with no React and no browser:
`diff.ts` and `metrics.ts` are pure, which is why they are unit-testable with synthetic PNG buffers.
The UI only ever talks to the HTTP API through `lib/api-client.ts`. Views never compute metrics, and
the engine never renders.

### HTTP API

| Method | Route                              | Purpose                                                            |
| ------ | ---------------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/api/catalog`                     | Allow-listed targets, viewport presets, engine defaults            |
| `POST` | `/api/compare`                     | Run one comparison (`{ targetId, viewportId?, maxDiffPercent? }`)  |
| `GET`  | `/api/reports?limit=n`             | Newest-first run history                                           |
| `GET`  | `/api/reports/:id`                 | One stored report                                                  |
| `GET`  | `/api/artifacts/:reportId/:file`   | A stored PNG (`baseline.png`, `current.png`, `diff.png`)           |

Errors use a stable shape and status: `{ "error": { "code", "message" } }` — `400` invalid input or
unsafe path, `403` cross-site request, `404` unknown run, `502` capture failure, `503` Chromium
unavailable.

Example without the UI:

```bash
curl -s -X POST http://localhost:3000/api/compare \
  -H 'Content-Type: application/json' \
  -d '{"targetId":"invoice-summary","viewportId":"desktop","maxDiffPercent":0.1}' | head -40
```

---

## Safety model

UIProof drives a real browser, so the capture surface is intentionally closed:

1. **Targets are ids, never URLs.** The client sends `targetId`; the server resolves it against
   `COMPARISON_TARGETS`. `{"targetId":"https://evil.example"}` is rejected with `400`.
2. **Routes are allow-listed twice.** `isAllowedDemoRoute` accepts only `/demo/...` paths with safe
   segments — no schemes, protocol-relative URLs, traversal, query strings, fragments or spaces. It
   runs both on the catalogue definition and again when building the capture URL, and the resolved
   URL is asserted to still be on the UIProof origin.
3. **Cross-site calls are refused.** `POST /api/compare` rejects `Sec-Fetch-Site: cross-site` and any
   `Origin` that does not match the `Host`, with `403`.
4. **Artifact paths cannot escape.** Report ids and file names must match strict patterns before the
   filesystem is touched, and every resolved path is asserted to sit inside the data directory.
5. **The origin is never user-supplied.** It comes from the incoming request or `UIPROOF_BASE_URL`.

---

## Determinism

A comparison is only meaningful if an unchanged page produces a byte-identical capture. Captures pin
the conditions that otherwise drift:

- one shared Chromium (`--force-color-profile=srgb`, `--font-render-hinting=none`, `--hide-scrollbars`);
- a fixed viewport, `deviceScaleFactor`, locale, timezone (`UTC`) and **light** colour scheme;
- `prefers-reduced-motion` emulation plus `animations: 'disabled'` and hidden carets;
- document fonts and image decoding awaited before the shot.

Verified at one revision: **five consecutive runs** of the same target all reported **exactly** the
same count (39,334 pixels / 3.8412 %), and the control target reported 0 three times out of three.
The engine is only as stable as the page, though, and it is honest about that: after the palette fix
described below, one run reported 39,333 instead of 39,334 — a single pixel, because the fixtures'
own text colours had changed. That is the tool correctly noticing a real change, not noise to be
papered over. If a page genuinely cannot be stabilised (live animations, remote fonts, time-dependent
content), raise the tolerance or exclude the region deliberately — never fake the number.

---

## Configuration

| Variable            | Default                  | Purpose                                                      |
| ------------------- | ------------------------ | ------------------------------------------------------------ |
| `UIPROOF_DATA_DIR`  | `<project>/.uiproof/data`| Where reports and screenshots are stored                     |
| `UIPROOF_BASE_URL`  | the incoming request's origin | Origin used to reach the fixtures while capturing        |

---

## Commands

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `pnpm dev`           | Dev server on <http://localhost:3000>               |
| `pnpm build`         | Production build                                    |
| `pnpm start`         | Serve the production build on port 3000             |
| `pnpm lint`          | ESLint (Next core-web-vitals + TypeScript rules)    |
| `pnpm typecheck`     | `tsc --noEmit` on the strict config                 |
| `pnpm test`          | Vitest unit suite                                   |
| `pnpm test:watch`    | Vitest in watch mode                                |
| `pnpm setup:browser` | Install the Chromium build Playwright drives        |

---

## Testing

`pnpm test` runs **44 unit tests** across 6 files, all covering the engine rather than the UI shell:

| File                            | Coverage                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `lib/compare/diff.test.ts`      | PNG decoding, dimension padding, exact changed-pixel counts, diff-image output, decode failures         |
| `lib/compare/metrics.test.ts`   | Change-percentage maths, divide-by-zero guards, verdict boundaries, tolerance validation, byte formats  |
| `lib/compare/targets.test.ts`   | Route allow-list (absolute / protocol-relative / traversal / query / case), capture-URL builder, catalogue invariants |
| `lib/compare/storage-paths.test.ts` | Report-id and file-name validation, traversal refusal through both path segments                    |
| `lib/http/trusted-request.test.ts`  | Same-origin rules, cross-site and opaque-origin rejection                                          |
| `lib/format-time.test.ts`       | Relative time, UTC clock, duration formatting                                                          |

`diff.test.ts` is the important one: it builds synthetic PNGs in memory and asserts **exact** pixel
counts (e.g. a 10 × 10 block changed on a 100 × 100 white canvas is exactly 100 pixels and 1 %).

### Verified end to end

Checked against a running server, not just in tests:

- **Real run (dev, desktop):** 39,334 / 1,024,000 pixels changed → 3.8412 % → `regression`.
  The first run of a server session takes ≈ 2.9 s because it launches Chromium; warm runs are ~1 s
  (measured on a fresh clone: capture 565 ms, comparison 207 ms).
- **Diff image consistency:** the generated `diff.png` contains exactly 39,333 pixels of the diff
  colour — the metric and the picture agree — plus 5,101 anti-aliased pixels that pixelmatch
  excluded.
- **Control target:** 0 changed pixels, verdict `pass`.
- **Determinism:** a repeat run produced identical counts.
- **Persistence:** `GET /api/reports` lists runs newest-first; `GET /api/reports/:id` reloads one;
  each run directory holds `baseline.png`, `current.png`, `diff.png` and `report.json`.
- **Production build:** `pnpm build && pnpm start` served a live run (mobile preset, 8.871 %) and the
  history grew afterwards, proving the reports route is dynamic rather than frozen at build time.
- **Safety:** traversal paths → `400`, cross-site and foreign-origin `POST`s → `403`, unknown target
  / viewport / tolerance / malformed JSON → `400`, unknown run → `404`.
- **Accessibility:** every text/background token pair in the palette was measured against WCAG
  contrast — all pass AA in both light and dark mode (body text 16:1, primary button 4.9:1,
  semantic badges 4.6–4.9:1, status swatches ≥ 5:1). Two light-mode pairs failed the first audit
  (amber 2.65:1, faint labels 3.93:1) and were corrected.
- **Stability:** five repeat runs at one revision → identical changed-pixel counts; the control
  target → 0 changed pixels, verdict `pass`, three times.

---

## Known limitations

- **Local only, single process.** Artifacts live on the local filesystem; a read-only or ephemeral
  filesystem (most serverless hosts) will break persistence. `storage.ts` is the single seam to swap
  in object storage.
- **No baselines history.** "Baseline" is the paired fixture route, not an approved snapshot from a
  previous run. Approving and versioning baselines is Phase 2 work.
- **Viewport captures only.** Screenshots are viewport-sized, so differences below the fold are not
  compared. If two captures do differ in height, the smaller one is padded on white and the report
  flags `dimensionsChanged` — that is a fallback, not full-page comparison.
- **Whole-viewport tolerance.** The tolerance is a single percentage for the whole image; there are
  no per-region masks or ignore selectors yet.
- **No auth, no multi-tenancy, no queue.** Concurrent runs share one Chromium and are not queued.
- **Chromium must be installed.** Without `pnpm setup:browser` the engine returns `503` with that
  instruction rather than failing obscurely.
- **Test coverage stops at the engine.** Components are exercised through the manual flow and the
  type checker; there is no component-test or browser-test harness yet.

---

## Next milestone

**Baseline approval and drift tracking (Phase 2, first slice).**

1. Promote any run's `current.png` to the target's approved baseline, stored and versioned on disk.
2. Compare against that stored baseline by default, so a real repo gets drift detection rather than
   fixture-to-fixture comparison.
3. Add ignore regions (selector or normalised rectangle) so volatile areas can be excluded honestly
   and visibly, instead of by lowering the global tolerance.
4. Record the git commit SHA with each run to tie a regression to the change that introduced it.
5. Then accessibility scanning, and only afterwards GitHub + AI repair proposals.

---

## Decisions worth knowing

- **Next.js App Router + route groups** keep the console chrome and the fixture screens apart without
  duplicating layouts.
- **Playwright over Puppeteer** for a pinned, dependency-managed Chromium and first-class screenshot
  options (`animations: 'disabled'`, `caret: 'hide'`).
- **A shared Chromium with an idle timeout** so a run costs a page context (~0.8–3 s end to end)
  instead of a browser launch, without leaving orphaned processes behind.
- **Route handlers stay thin.** Validation, capture, diffing, verdict and persistence live in
  `lib/compare` where they can be tested and reused by a future CLI or worker.
- **The palette is CSS custom properties**, so light/dark support needed no theme switcher and no
  client-side flash.
