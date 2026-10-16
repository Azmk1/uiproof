# UIProof

**Automated frontend quality platform.** UIProof renders a screen, compares it against a known-good
baseline, and tells you exactly which pixels moved — with the measured share of the viewport that
changed, the highlighted difference image, and the artifacts stored on disk.

Phase 1 delivered the engine and the console. Phase 2 made it a real regression tool: you **approve
a capture as the baseline**, every later run is diffed against that stored reference, and drift is
classified as pass or regression against your tolerance — with the baseline version that was used
recorded in the report. Later phases add accessibility and design-consistency checks, GitHub
integration, and AI-assisted repair proposals — none of that is wired up yet.

---

## What works today

- **A real comparison engine.** Headless Chromium captures both sides of a target at identical
  viewport settings; [pixelmatch](https://github.com/mapbox/pixelmatch) compares the PNGs and paints
  a highlighted difference image. Nothing is mocked: every number on screen comes from counted
  pixels.
- **Approved baselines, versioned on disk.** Approving a run copies its capture into an immutable
  `bl-<uuid>.png` and records where it came from. Approvals are explicit, never automatic, never an
  overwrite: replacing a baseline adds a version, and restoring an older one is a single action.
- **Real drift detection.** Baseline mode captures the page again, loads the approved reference and
  diffs the two, so a change in the code shows up as a measured percentage against the *approved*
  screen rather than against a second fixture.
- **A developer console** at `/` to pick a comparison mode, a target, a viewport and a tolerance, run
  the pipeline, inspect baseline / current / difference screenshots, see the approved baseline and
  its version history, watch a comparison timeline, and reload any earlier run.
- **Two local demo fixtures** with deliberate, documented visual differences — plus a `/demo/reverted`
  state that stands in for "the fix", so a regression can be produced and then undone without editing
  source. The engine is testable the moment the app boots.
- **Local persistence.** Screenshots and the JSON report are written to `.uiproof/data`, so a page
  refresh — or a server restart — keeps the last run, the approved baseline and the version history
  on screen.
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
2. Keep the default target **Invoice summary card**, the **Desktop** viewport and the **Fixture pair**
   mode. Press **Run comparison** (about 1–3 s: two captures plus the pixel diff) and inspect
   **Baseline**, **Current** and **Difference**. The diff is the highlighted image.
3. Press **Approve this run as the baseline** and confirm. The run's capture becomes
   `bl-<uuid>.png` — immutable and versioned — and the panel shows it, its source run and its route.
4. Switch **Comparison mode** to **Approved baseline** and run again: the page is captured fresh and
   diffed against what you approved, so it **passes with exactly 0 changed pixels**.
5. Switch **Page state** to **Reverted page** and run once more: **3.8412 %** of the viewport changed →
   **regression**. This is real drift: the approved reference is untouched, only the page moved.
6. Switch back to **Shipped page** and run — it passes again, from the same approved version.
7. Reload the page. The run history, the approved baseline, its two versions and the comparison
   timeline all come back from disk.

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

`/demo/reverted` renders the *same* component with the baseline variant, so it is pixel-identical to
`/demo/baseline`. That is deliberate: it is what a revert looks like to the engine, and it gives the
browser suite a page change it can apply and undo without touching the working tree.

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
│   │   ├── current/page.tsx
│   │   └── reverted/page.tsx          # the same screen with the changes undone
│   ├── api/                           # the HTTP surface (see below)
│   └── not-found.tsx
├── components/
│   ├── ui/                            # shadcn/ui primitives (button, card, tabs, badge, …)
│   ├── console/                       # dashboard: controls, modes, verdict, viewer, baseline, timeline
│   ├── demo/                          # fixture app frame + invoice screen
│   └── layout/                        # brand mark, header, footer
└── lib/
    ├── compare/                       # ← the engine (no React, no DOM)
    │   ├── types.ts                   # shared domain types (modes, baselines, reports)
    │   ├── metrics.ts                 # pure metric maths, verdicts, validation, formatting
    │   ├── targets.ts                 # viewport presets + trusted-route allow-list + targets
    │   ├── run-options.ts             # pure parsing/validation of one run request
    │   ├── baseline-paths.ts          # pure baseline file naming + traversal guards
    │   ├── baselines.ts               # approved-baseline store: approve, activate, read
    │   ├── diff.ts                    # pure: decode PNG → normalise → pixelmatch → diff PNG
    │   ├── browser.ts                 # Chromium singleton with idle shutdown
    │   ├── capture.ts                 # deterministic Playwright capture
    │   ├── storage-paths.ts           # pure path rules + traversal guards
    │   ├── storage.ts                 # filesystem persistence of artifacts and reports
    │   ├── engine.ts                  # orchestrates one run (fixture or baseline mode)
    │   └── errors.ts                  # typed errors → HTTP status mapping
    ├── http/                          # request trust, capture origin, local-only write guard
    ├── api-client.ts                  # typed fetch client used by the console
    └── format-time.ts
```

```
e2e/                                   # browser suite (real Chromium, real server)
├── support/e2e-server.ts              # boots `next start` on a scratch port + data dir
├── support/setup.ts                   # Vitest global setup / teardown
├── support/helpers.ts                 # assertions, API readers, mode/variant selection
├── dashboard-smoke.test.ts            # console flow, measured verdict, persistence after reload
├── accessibility.test.ts              # the Phase 1 audit regressions, pinned
└── baseline-lifecycle.test.ts         # approve → pass → regress → recover → restore → reload
.github/workflows/ci.yml               # install · lint · typecheck · test · build · e2e
```

### Pipeline

```
POST /api/compare
      │
      ├─ validate target id ──► targets.ts       (allow-list, not user input)
      ├─ validate viewport  ──► targets.ts
      ├─ validate tolerance ──► metrics.ts
      └─ resolve mode + page state ──► run-options.ts, targets.ts
      │
      │  mode = fixture                  mode = baseline
      │  ─────────────                  ───────────────
      ├─ capture /demo/baseline         ├─ load approved version ──► baselines.ts
      └─ capture the page state         └─ capture the page state
                 │                              │
                 └──────────────┬───────────────┘
                                │
                 ├─ decode + dimension match ──► diff.ts
                 ├─ pixelmatch ────────────────► changed pixels + diff PNG
                 └─ verdict ───────────────────► metrics.ts (tolerance decides pass/regression)
                                │
                                └─ write 3 PNGs + report.json (with the baseline
                                   version that was used) ──► storage.ts (.uiproof/data)
```

Approval is a separate, explicit step that never happens as part of a run:

```
POST /api/baselines            POST /api/baselines/:target/:viewport/activate
   │                                │
   └─ copy the run's current.png    └─ point the manifest at an existing version
      to bl-<uuid>.png, append a        (restore an older reference; every image stays)
      version to manifest.json,
      set it active — atomically
```

**Separation of concerns.** The comparison layer is plain TypeScript with no React and no browser:
`diff.ts` and `metrics.ts` are pure, which is why they are unit-testable with synthetic PNG buffers.
The UI only ever talks to the HTTP API through `lib/api-client.ts`. Views never compute metrics, and
the engine never renders.

### HTTP API

| Method | Route                                            | Purpose                                                                   |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET`  | `/api/catalog`                                   | Allow-listed targets, modes, page states, viewports, engine defaults       |
| `POST` | `/api/compare`                                   | Run one comparison (`{ targetId, viewportId?, mode?, variantId?, maxDiffPercent? }`) |
| `GET`  | `/api/reports?limit=n`                           | Newest-first run history                                                   |
| `GET`  | `/api/reports/:id`                               | One stored report                                                          |
| `GET`  | `/api/artifacts/:reportId/:file`                 | A stored PNG (`baseline.png`, `current.png`, `diff.png`)                   |
| `GET`  | `/api/baselines/:target/:viewport`               | The approved baseline and its version history (`{ "baseline": null }` when none) |
| `POST` | `/api/baselines`                                 | **Approve** a stored run as the baseline (`{ targetId, viewportId, sourceReportId, note? }`) |
| `POST` | `/api/baselines/:target/:viewport/activate`      | **Replace / restore**: make an existing version the active reference        |
| `GET`  | `/api/baselines/:target/:viewport/:version.png`  | An approved baseline image (immutable, long-cached)                        |

Errors use a stable shape and status: `{ "error": { "code", "message" } }` — `400` invalid input or
unsafe path, `403` cross-site request or non-local write, `404` unknown run or unknown baseline
version, `502` capture failure, `503` Chromium unavailable.

All three state-changing writes (`POST`) are **local-only**: they require a loopback host, no
cross-site `Sec-Fetch-Site`, and an `Origin` that matches `Host`. Reads are unrestricted.

Example without the UI:

```bash
curl -s -X POST http://localhost:3000/api/compare \
  -H 'Content-Type: application/json' \
  -d '{"targetId":"invoice-summary","viewportId":"desktop","mode":"fixture"}' | head -40

# approve the run it returned as the baseline, then compare against it
curl -s -X POST http://localhost:3000/api/baselines \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"targetId":"invoice-summary","viewportId":"desktop","sourceReportId":"run-…"}'
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
   Baseline images are stricter still: the file segment must be exactly `bl-<uuid>.png`, so
   `/api/baselines/…/current.png` or a traversal segment is a `400`, not a read.
5. **The origin is never user-supplied.** It comes from the incoming request or `UIPROOF_BASE_URL`.
6. **Approval cannot be adopted across targets.** A run may only become the baseline for the target
   *and* viewport it was captured at; a Desktop run offered as the Mobile reference is a `400`.
7. **State-changing calls are local-only.** `/api/baselines` and `/activate` refuse non-loopback
   hosts and foreign origins, so a deployed copy of the console cannot be approved against by
   strangers. This is the "local prototype" boundary, not an auth system.

---

## Baselines and drift detection

A baseline is an **approved capture**, not a second fixture. Approving run `R` for
`(target, viewport)` copies `R`'s `current.png` byte-for-byte into an immutable version file and
appends a version to that pair's manifest:

```
.uiproof/data/
├── reports/run-<uuid>/            baseline.png · current.png · diff.png · report.json
└── baselines/<target>/<viewport>/
    ├── manifest.json              the version list + which one is active
    └── versions/bl-<uuid>.png     one immutable approved image per version
```

Properties, all of them verified rather than intended:

- **Approval is explicit.** It only happens through `POST /api/baselines`. A regression never
  approves itself, and a failed comparison leaves the manifest untouched.
- **Nothing is overwritten.** Approving again appends a version; the older image stays on disk and
  stays served. Restoring it is one `activate` call and it keeps its original `approvedAt`.
- **Each version records its provenance:** id, `approvedAt`, `sourceReportId`, the route it captured
  (`capturedRoute`), image size and bytes, and an optional note.
- **Metadata updates are atomic.** The manifest is written to a temporary file in the same directory
  and renamed over the target, so a crash mid-write cannot leave half a JSON document. Approvals
  serialise in-process per target/viewport, and every write re-reads the manifest afterwards and
  retries on top of the newer one if another process won the race.
- **A report says which reference it used.** Baseline-mode reports carry
  `baseline: { versionId, approvedAt, sourceReportId, capturedRoute, width, height, imageUrl }`,
  which is what makes a regression attributable to a specific approved image.
- **Separate per target and viewport.** Desktop and Mobile approvals are independent records.
- **Only a whole, matching image can be adopted.** The stored `current.png` must decode before it is
  adopted, and a manifest whose rows disagree with its own directory is reported as unreadable rather
  than trusted.
- **No baseline is a normal state.** `GET /api/baselines/:target/:viewport` answers
  `{ "baseline": null }` with `200`; the console renders "nothing approved yet" and disables baseline
  mode instead of failing.

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
| `pnpm test`          | Vitest unit suite (engine, paths, guards)           |
| `pnpm test:watch`    | Vitest in watch mode                                |
| `pnpm test:e2e`      | Browser suite against a real production server      |
| `pnpm verify`        | lint → typecheck → test → build → test:e2e          |
| `pnpm setup:browser` | Install the Chromium build Playwright drives        |

`pnpm test:e2e` needs `pnpm build` to have run first: it starts `next start` on a scratch port with a
throwaway `UIPROOF_DATA_DIR`, so it never touches your own runs and baselines. `pnpm verify` chains
everything in that order; the same sequence runs in CI on every push and pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)) — install with `--frozen-lockfile`, lint,
typecheck, unit tests, production build, Chromium install, browser suite.

---

## Testing

`pnpm test` runs **84 unit tests** across 9 files, all covering the engine, the guards and the
baseline store rather than the UI shell:

| File                            | Coverage                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `lib/compare/diff.test.ts`      | PNG decoding, dimension padding, exact changed-pixel counts, diff-image output, decode failures         |
| `lib/compare/metrics.test.ts`   | Change-percentage maths, divide-by-zero guards, verdict boundaries, tolerance validation, byte formats  |
| `lib/compare/targets.test.ts`   | Route allow-list (absolute / protocol-relative / traversal / query / case), capture-URL builder, modes, page states, catalogue invariants |
| `lib/compare/run-options.test.ts` | Mode/variant/tolerance parsing, unknown-mode rejection, defaults                                     |
| `lib/compare/storage-paths.test.ts` | Report-id and file-name validation, traversal refusal through both path segments                    |
| `lib/compare/baseline-paths.test.ts` | Version-id and image-name patterns, traversal refusal, URL building                                 |
| `lib/compare/baselines.test.ts` | Approve → version → activate against a real temp directory: append-only versions, ownership refusal on a foreign run, atomic manifest, corrupt-manifest handling, restore keeping `approvedAt`, orphan cleanup |
| `lib/http/trusted-request.test.ts`  | Same-origin rules, cross-site and opaque-origin rejection, loopback-only write guard               |
| `lib/format-time.test.ts`       | Relative time, UTC clock, duration formatting                                                          |

`diff.test.ts` is the important one: it builds synthetic PNGs in memory and asserts **exact** pixel
counts (e.g. a 10 × 10 block changed on a 100 × 100 white canvas is exactly 100 pixels and 1 %).
`baselines.test.ts` is the second: it writes real files into a temporary data directory and checks the
lifecycle semantics — nothing overwritten, nothing adopted across target/viewport, and a restore that
keeps the original approval timestamp.

### Browser suite

`pnpm test:e2e` runs **22 tests** across 3 files in real Chromium, against a real `next start` server
on a throwaway data directory ([e2e/](e2e)):

| File | Coverage |
| ---- | -------- |
| `dashboard-smoke.test.ts` | Console renders with no console errors · the mode invariant (baseline mode is gated on an approved baseline actually existing) · a fixture run produces a measured verdict whose stored report agrees with the panel, with three real PNGs served · the reverted page state reports 0 px, not a false positive · the report survives a reload · the capture guard still closes |
| `accessibility.test.ts` | The Phase 1 audit regressions, pinned as measurements rather than claims: flex prose in reading order, every control ≥ 24 px, the slider hairline inside a 24 px hit area, zoom buttons at full size, WCAG AA contrast in both colour schemes, no overflow at 390 px, a focus ring on every keyboard stop, and the timeline reachable by keyboard with a ring on the focused bar |
| `baseline-lifecycle.test.ts` | The seven-step lifecycle below, driven through the UI wherever the UI has an action for it |

The lifecycle, in the order the suite checks it:

1. No baseline exists — the panel says so and the API answers `null`.
2. A run is captured and approved **through the UI**, including the confirmation step; the approved
   image is then fetched as a real PNG.
3. Baseline mode against the unchanged page **passes with exactly 0 changed pixels** and records the
   version it used.
4. The page state changes; the next run **regresses**.
5. The original page state comes back; the run **passes again** from the same version.
6. A new version is approved (the older image is still on disk) and the first version is **restored**
   explicitly through the UI.
7. The application is reloaded: baseline, both versions, run history and the timeline all persist.

The suite does not fabricate results: every comparison launches Chromium and diffs a 1280 × 800
viewport, and every assertion reads either the running UI or the stored artifact it produced. It is
also order-independent — the three files may run in any order, because the smoke suite asserts the
*invariant* ("baseline mode is enabled exactly when a baseline is stored") rather than assuming a
clean store. Verified with `--sequence.shuffle.files --sequence.seed=7`.

### Verified end to end

Checked against a running server, not just in tests:

- **Real run (dev, desktop):** 39,334 / 1,024,000 pixels changed → 3.8412 % → `regression`.
  The first run of a server session takes ≈ 2.9 s because it launches Chromium; warm runs are ~1 s
  (measured on a fresh clone: capture 565 ms, comparison 207 ms).
- **Diff image consistency:** the generated `diff.png` contains **exactly 39,334 pixels** of the diff
  colour (`rgb(220, 38, 38)`) — the metric and the picture agree — plus exactly 5,105 anti-aliased
  pixels in the AA colour (`rgb(250, 204, 21)`) that pixelmatch excluded. Verified by decoding the PNG
  independently of the metrics code.
- **Control target:** 0 changed pixels, verdict `pass`.
- **Determinism:** a repeat run produced identical counts.
- **Drift detection (Phase 2):** an approved baseline was compared against three later captures —
  unchanged **0 / 1,024,000 px (pass)**, changed **39,334 / 1,024,000 px = 3.8412 % (regression)**,
  restored **0 px (pass)** — and every report named the baseline version it used. The approved image
  is byte-identical to the run it came from (`md5 688e1831…` on both sides), and after a second
  version was approved the first was restored with `versions = 2, active = v1, revision = 3`. A
  baseline-mode run on the production server took 526–740 ms end to end the same session (capture
  328–462 ms, comparison 188–338 ms) — one capture instead of the fixture mode's two.
- **Local-only writes:** approving from a foreign `Origin` → `403`; approving with a non-loopback
  `Host` → `403`; approving a Desktop run as the Mobile baseline → `400`; unknown version → `400`;
  traversal or non-baseline baseline image name → `400`.
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
- **A baseline is approved by hand.** There is no "approve automatically on `main`", no scheduled
  refresh and no threshold that promotes a run: a regression never approves itself, by design.
- **Viewport captures only.** Screenshots are viewport-sized, so differences below the fold are not
  compared. If two captures do differ in height, the smaller one is padded on white and the report
  flags `dimensionsChanged` — that is a fallback, not full-page comparison.
- **Whole-viewport tolerance.** The tolerance is a single percentage for the whole image; there are
  no per-region masks or ignore selectors yet.
- **No auth, no multi-tenancy, no queue.** Concurrent runs share one Chromium and are not queued.
  Baseline writes are therefore guarded by local-only rules plus the concurrency handling described
  above, not by identities or roles.
- **Concurrency is handled, not coordinated.** Approvals cannot lose data, but the console has no
  live-updating view of a baseline that another process changed underneath it; reload to see it.
- **Chromium must be installed.** Without `pnpm setup:browser` the engine returns `503` with that
  instruction rather than failing obscurely. The browser suite skips nothing — it fails loudly if
  Chromium is missing.
- **A run is still tied to one viewport.** Approving a baseline captures one preset; there is no
  multi-viewport baseline or "approve all viewports" action yet.
- **The browser suite is smoke-level.** It covers the console flow, the audit regressions and the
  baseline lifecycle. It does not diff artefacts per pixel, and it runs against a throwaway data
  directory rather than a long-lived history.
- **No visual diffing of the console itself.** Nothing screenshots the dashboard UI, so a styling
  regression in the console would not be caught by the tool that is meant to catch styling
  regressions.

---

## Next milestone

**Phase 3 — make the reference trustworthy and the gate useful.**

1. **Ignore regions.** Selector- or rectangle-based masks, recorded in the report, so a volatile
   area can be excluded visibly instead of by lowering the global tolerance.
2. **Tie runs to code.** A run against a real project's page is worth much more if the report carries
   the git SHA (and dirty state) it was captured at, so a regression names the change that caused it.
3. **Multi-viewport approvals.** One approval covering desktop/tablet/mobile, with per-viewport pass
   or fail in a single report.
4. **A CLI and an exit code.** `uiproof compare --fail-on regression` so the browser suite can be the
   quality gate in someone else's CI, not just in this repository's.
5. **Then accessibility scanning** (axe-core plus the measurements this repository already makes), and
   only afterwards GitHub integration and AI repair proposals.

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
