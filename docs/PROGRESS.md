# UIProof — progress log

**North star:** an automated frontend quality platform that detects visual regressions,
accessibility problems and design inconsistencies — see `docs/GOAL.md`.

**Current milestone:** Phase 2 — approved baselines, drift detection and automated quality gates.
**Status:** complete, verified, committed.

Phase 1 = 8 / 8 criteria (100 %) · Phase 2 = **10 / 10 criteria (100 %)**.

---

## Phase 1 — foundation and the first working workflow

Delivered at `f47ff3e` (audited revision). Evidence for it is kept below, unchanged, because the
Phase 2 numbers build on it.

Progress = verified acceptance criteria / total = **8 / 8 (100 %)**.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | User can trigger a demo comparison from the dashboard | **Verified** | Clicked **Run comparison** in the browser: `POST /api/compare → 200`, verdict rendered as `regression · 3.841%` |
| 2 | Two captures of a page with deliberate visual differences | **Verified** | Live DOM comparison of `/demo/baseline` vs `/demo/current` confirms all five listed differences; diff image contains 39,334 highlighted pixels |
| 3 | Engine compares with pixelmatch and produces a highlighted diff image | **Verified** | `diff.png` holds exactly 39,334 diff-colour pixels = reported `changedPixels`; 5,105 anti-aliased pixels excluded |
| 4 | Baseline, current and difference inspectable with a change percentage | **Verified** | Console tabs load all three PNGs (`200`, natural size 1280×800); 3.8412 % = 39,334 / 1,024,000 |
| 5 | Results persist locally across a page refresh | **Verified** | Each run writes 3 PNGs + `report.json` to `.uiproof/data`; after reload the console restored the newest stored run via `/api/reports/:id` |
| 6 | Capture restricted to trusted local demo routes | **Verified** | `{"targetId":"https://evil.example"}` → `400`; `/etc/passwd`, `//host`, `/demo/../secrets` rejected; cross-site/foreign-origin POST → `403`; traversal on artifacts → `400` |
| 7 | Tests, README and UI/engine separation | **Verified** | 44 Vitest tests across 6 engine files; README documents setup, architecture, API, limitations; comparison layer is React-free plain TypeScript |
| 8 | Lint, typecheck and tests pass on the final code | **Verified** | `pnpm lint` clean, `pnpm typecheck` clean, `pnpm test` 44/44, `pnpm build` succeeds |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M1 — repository foundation | Next.js 16.4.1 (App Router, Turbopack) + React 19 + Tailwind v4 + TypeScript strict, Vitest 5 with a `@/*` alias, pnpm 10, pinned dev/start ports |
| M2 — design system and console shell | Token-driven palette adapting to the OS colour scheme, shadcn/ui primitives, Geist fonts, skip link, focus rings, `prefers-reduced-motion` handling |
| M3 — comparison engine | `lib/compare`: route allow-list, shared Chromium with idle shutdown, deterministic capture, pure decode/normalise/pixelmatch diff, verdict maths, filesystem persistence, thin API routes |
| M4 — dashboard and fixtures | Console with target/viewport/tolerance controls, verdict panel, tabbed screenshot inspector, run history; two fixtures sharing one component |
| M5 — verification | Unit suite, dev-mode end-to-end run, security probes, determinism re-run, production build, WCAG contrast audit |
| M6 — pre-Phase-2 delivery audit | Pushed to GitHub, re-audited against the published commits; three genuine UI defects found and fixed (flex prose order, slider target/thumb, zoom-button target size) |

### Phase 1 verification evidence

```
pnpm test        44 tests / 6 files passed
pnpm lint        clean (0 errors, 0 warnings)
pnpm typecheck   clean
pnpm build       ✓ compiled, ƒ dynamic: /api/compare, /api/reports, /api/reports/[id], /api/artifacts/…
```

| Check | Result |
|-------|--------|
| Desktop run (dev) | `regression`, 39,334 / 1,024,000 px changed = **3.8412 %**, total 2.86 s (capture 1.75 s, diff 292 ms) |
| Mobile run (prod build) | `regression`, **8.871 %** at 390 × 844, total 763 ms |
| Control target | **0** changed pixels, verdict `pass`, 3/3 runs — no false positives |
| Stability | 5 repeat runs at the final revision: identical 39,334 px (spread 0) |
| Diff-image integrity | Diff PNG contains exactly 39,334 diff-colour pixels (metric and image agree) |
| Contrast audit | All token pairs pass WCAG AA in light and dark (body 16:1, primary button 4.9:1, badges 4.6–4.9:1) |

---

## Phase 2 — approved baselines, drift detection and automated quality gates

**Goal:** turn a fixture-to-fixture demo into a genuine local visual regression tool: approve a
known-good screenshot, diff every later capture against it, and gate the work automatically.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | A capture can be explicitly approved as the reference | **Verified** | **Approve this run as the baseline** → confirmation → `POST /api/baselines` → `bl-9bf77b5e…`; the approved file is byte-identical to the run's `current.png` (md5 `688e1831…` both sides) |
| 2 | Baselines are separate per target and viewport, stored locally | **Verified** | `baselines/<target>/<viewport>/manifest.json` + `versions/bl-<uuid>.png`; a Desktop run offered as the Mobile baseline → `400` |
| 3 | Versioned history with timestamps and source report ids | **Verified** | Two versions after two approvals: `bl-9bf77b5e… @/demo/current ← run-e931d9ae…` and `bl-be0cbc62… @/demo/reverted ← run-00507907…`, each with `approvedAt`, size, bytes and note |
| 4 | Reviewing, replacing and restoring are explicit | **Verified** | The panel previews the active image and lists versions; **Restore** on an older row → `active = v1, versions = 2, revision = 3`, original `approvedAt` kept, and the older image stays served (`200`) |
| 5 | Clear behaviour when no baseline exists | **Verified** | `GET /api/baselines/…` → `200 {"baseline": null}`; the panel says nothing is approved, the approve button explains it needs a stored run, and **baseline mode cannot run** (button disabled) |
| 6 | Approval never happens automatically after a failed comparison | **Verified** | A regressing baseline run (`run-00507907…`, `3.8412 %`) left the manifest untouched; `approveBaseline` is only reachable from `POST /api/baselines`, and no engine code calls it |
| 7 | Real drift detection against the approved reference | **Verified** | Unchanged page **0 / 1,024,000 px → pass**, changed page **39,334 / 1,024,000 px = 3.8412 % → regression**, restored page **0 px → pass**; every report carries the `versionId` it used |
| 8 | Fixture mode preserved for demonstration and compatibility | **Verified** | `mode: "fixture"` still captures `/demo/baseline` vs the page state: 39,334 px / 3.8412 % on the shipped page, 0 px on the reverted page (no false positives) |
| 9 | Dashboard: modes, baseline preview, confirmation, history, timeline, honest states | **Verified** | Mode picker with the blocked reason, baseline panel (empty / loading / error / active), two-step approval confirm, version list with per-row restore confirm, comparison timeline, run history; all driven by the browser suite |
| 10 | Persistence, atomicity and path/ownership guards | **Verified** | Manifest written to a temp file then renamed; versions written with the `wx` flag; approvals serialise per pair and re-read on a lost update; refusals: foreign origin `403`, non-loopback host `403`, cross-target `400`, unknown version `400`, traversal image `400`, `current.png` as a baseline image `400` |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M7 — domain model | `ComparisonMode` (`fixture`/`baseline`), page-state variants, `BaselineManifest`/`BaselineVersion`/`BaselineReference`, additive changes to `ComparisonReport` |
| M8 — run options and guards | `run-options.ts` parses and validates one run request; `requireLocalAdmin` restricts writes to loopback + same-origin; `api-response.ts` centralises error mapping |
| M9 — approved baseline store | `baseline-paths.ts` (pure naming + traversal guards) and `baselines.ts` (approve / activate / read / read-active-image) with append-only versions, atomic manifest writes and optimistic concurrency |
| M10 — drift engine and API | Baseline mode loads the active version, captures the page, diffs, classifies and records the reference; new routes for baselines, approval, activation and baseline images |
| M11 — dashboard | Mode picker, baseline panel with preview + confirmation + version history, comparison timeline, empty/loading/error/success states, catalogue-driven modes per target |
| M12 — browser suite | `vitest.e2e.config.mts` + `e2e/` running Chromium against `next start` on a scratch port and a throwaway data directory: 22 tests in 3 files |
| M13 — CI and verification | GitHub Actions workflow (install → lint → typecheck → test → build → Chromium → browser suite), docs, lifecycle walkthrough, security probes |

### Phase 2 verification evidence

```
pnpm lint        clean
pnpm typecheck   clean
pnpm test        84 tests / 9 files passed
pnpm build       ✓ compiled; ○ /, /demo, /demo/baseline, /demo/current, /demo/reverted · ƒ /api/…
pnpm test:e2e    22 tests / 3 files passed (Chromium, real production server)
```

`pnpm test:e2e` output (`vitest run --config vitest.e2e.config.mts`):

```
e2e: UIProof listening on http://localhost:3210 (data: …\uiproof-e2e-<uuid>)
✓ e2e/dashboard-smoke.test.ts (7 tests)
✓ e2e/accessibility.test.ts (8 tests)
✓ e2e/baseline-lifecycle.test.ts (7 tests)
Test Files  3 passed (3)      Tests  22 passed (22)
```

The same suite passes with the file order shuffled (`--sequence.shuffle.files --sequence.seed=7`,
lifecycle first, smoke last), and again in the natural order. `pnpm verify` (lint → typecheck → unit
→ build → browser) was run to completion on the exact tree that is committed.

### Baseline lifecycle walkthrough (production server, clean data directory)

Driven through the HTTP API with same-origin headers (`V1`/`V2` are the approved version ids):

| Step | Result |
|------|--------|
| 1 · fixture run on the shipped page | `run-e931d9ae…` — 39,334 / 1,024,000 px = **3.8412109 %**, `regression`, capture 684 ms, compare 280 ms |
| 2 · approve it as the baseline | `bl-9bf77b5e-dd58-4c07-9afb-6412b20b6a3a`, version count 1, route `/demo/current`, 1280×800, 65,760 bytes |
| 3 · baseline run, page unchanged | 0 / 1,024,000 px = **0 %**, `pass`, `baseline.versionId = V1`, total 740 ms |
| 4 · baseline run, page state reverted | 39,334 / 1,024,000 px = **3.8412109 %**, `regression`, `baseline.versionId = V1`, total 715 ms |
| 5 · baseline run, shipped page again | **0 px**, `pass` from the same version, total 526 ms |
| 6 · approve the drifted run, then restore v1 | `versions = 2`, `active = V1`, `revision = 3` |
| 7 · restart the server, read the manifest | `active = V1`, `revision = 3`, both versions with their captured routes; 4 run directories with 3 PNGs + `report.json` each |
| 8 · safety probes | wrong-viewport source `400` · unknown version `400` · foreign origin `403` · non-loopback host `403` · traversal baseline image `400` · `current.png` as a baseline image `400` · arbitrary capture target `400` |

Independent artifact checks (decoded outside the metrics code):

| Check | Result |
|-------|--------|
| Approved image = source capture | md5 `688e183126859dcb6f1b94dbc668c472` for both `versions/bl-9bf77b5e….png` and the source run's `current.png` |
| Diff image integrity | `diff.png` contains **exactly 39,334** pixels of the diff colour `rgb(220, 38, 38)` and **exactly 5,105** pixels of the AA colour `rgb(250, 204, 21)` |
| Baseline image endpoint | `200`, `image/png`, `content-length: 65760`, `cache-control: public, max-age=31536000, immutable`, valid PNG signature, dimensions 1280×800 |
| No false positives | The reverted page state compared against the baseline fixture is byte-identical: **0 changed pixels** |

### Phase 1 compatibility re-check (production build, clean data directory)

Nothing in Phase 1 was allowed to regress, and the API stayed backward compatible:

| Check | Result |
|-------|--------|
| Control target ("same page twice") | `pass`, **0 / 1,024,000 px**, mode `fixture` — no false positives |
| A Phase 1 request body (`targetId` + `viewportId` + `maxDiffPercent`, no mode) | still fixture mode: 39,334 px / **3.8412 %**, `variantId: "shipped"` |
| Pages | `/`, `/demo`, `/demo/baseline`, `/demo/current`, `/demo/reverted` all `200` |
| Catalogue | modes and page states exposed per target; viewports and defaults unchanged (`maxDiffPercent 0.1`, `maxHistory 25`) |
| Phase 1 safety probes | malformed JSON `400` · unknown run `404` · artifact traversal `400` · cross-site compare `403` · bad viewport `400` · bad tolerance `400` |

**Approval is local-only.** Reads stay open (`GET /api/baselines/…` → `200`), and every write is
refused unless the request comes from a loopback host with a matching origin and no cross-site
signal — probed from a remote-shaped request:

| Probe | Result |
|-------|--------|
| Approve, cross-site `Sec-Fetch-Site` + foreign `Origin` | `403` |
| Approve, `Host: uiproof.example.com` (a deployed copy) | `403` |
| Approve, `Host: 192.168.1.50` (another machine on the LAN) | `403` |
| Activate a version, foreign `Origin` | `403` |
| Compare (`POST /api/compare`) from a foreign origin | `403` |
| Approve with a loopback `Host` but a non-existent run | passes the guard, then `404` — and stores nothing |

### Live UI audit (second browser, populated dashboard)

Beyond the automated suite, the running console was inspected in the preview browser with real state
(one approved baseline, four stored runs: 3.84 % regression, two 0 % passes):

- Two-column layout intact (main column 1005 px, rail 330 px), no horizontal overflow
  (`scrollWidth − innerWidth = −17`), 39 keyboard stops.
- The approved baseline image loads at its natural 1280 × 800 and renders at 295 × 184 inside the rail;
  the panel shows the active version, its source run, captured route and image size.
- Timeline: 4 bars, each a 236 × 130 px target with 3 px and 113 px drawn bars, caption
  `4 runs · peak 3.84 %`.
- Both confirmations were driven by clicking, in this second browser: **Approve this run as a new
  version** → `2 versions`, revision 2, notice naming the source run; then **Restore** on the earlier
  row → active back to v1, revision 3, both versions kept and the original `approvedAt` unchanged.
- No console messages and no failed requests were recorded during the audit.

### Defects found and fixed during Phase 2 verification

1. **Timeline bars were 3 px tall as pointer targets.** The comparison-timeline buttons sized
   themselves to the bar, so a low-change run produced a 323 × 3 hit box — far under the WCAG 2.2
   24 px target size. Each bar is now a full-height column button (132 px) containing the drawn bar,
   with a focus outline on the column. Found by the pinned accessibility suite, fixed, and the suite
   now passes.
2. **Two browser-test assumptions were wrong, and the tests were corrected rather than the product.**
   (a) The reverted page state in *fixture* mode is not a regression — `/demo/reverted` is
   pixel-identical to the baseline fixture, so the honest expectation is `pass` at 0 px, which is now
   asserted in both directions. (b) The accessibility probes measured the console's empty state
   because the stored report loads asynchronously; the probes now wait for a stored report (running a
   real comparison if the data directory is empty).
3. **The smoke suite assumed an empty baseline store.** It shares one data directory with the
   lifecycle suite, so it asserted the *invariant* instead: the panel claims a baseline exactly when
   the API has one, and baseline mode is enabled exactly then. Verified order-independent.
4. **The header badge still said "phase 1"** while the console hero said "phase 2 · drift detection".
   Stale copy like this is invisible to the engine tests, so the live UI audit looks for it; the badge
   now reads "phase 2".

### Stale README measurements corrected

- The anti-aliased pixel count in `diff.png` was documented as 5,101; the measured value at the
  current revision is **5,105** (the Phase 1 palette fix moved a few edge pixels). Corrected with the
  method stated.
- The "diff image contains 39,333 pixels" line was one revision behind the rest of the document;
  the measured value is **39,334**, consistent with `metrics.changedPixels`.
- Test counts (44/6 files) and the "no baseline history" / "no browser-test harness" limitations were
  rewritten to match what now exists.

---

## Decisions made during implementation

- **Route groups** `(console)` / `(fixtures)` keep console chrome off the screens under test.
- **Artifacts in `.uiproof/data`** (hidden + git-ignored): verified that writing screenshots during a
  run does **not** trigger a dev-server recompile.
- **`cacheComponents` kept enabled** (the Next 16 default), which required dropping the route
  `runtime` segment config — Node is the default runtime anyway.
- **`serverExternalPackages: ["playwright"]`** so the server compiler never bundles the driver.
- **Dimension mismatch pads rather than fails**, and the report carries `dimensionsChanged`.
- **A control target** that compares a fixture with itself, to make "zero false positives" testable.
- **No `next/image`** for artifacts: they are already-final run-scoped PNGs.
- **Page states are routes, not query parameters.** `/demo/current` and `/demo/reverted` are static
  pages, so the capture URL never carries input the guard would have to inspect, and each state
  captures identically run to run.
- **An approved baseline is a copy, not a reference.** Approval reads the run's PNG, decodes it to
  prove it is whole, and writes a new immutable file. Reports can then be pruned without breaking the
  history, and an approved image can never change because a run directory did.
- **Version ids are self-describing (`bl-<uuid>`)** and the image route only accepts that exact shape,
  which makes "no traversal through a file name" a property of the type rather than a check.
- **Optimistic concurrency over locks.** Approvals serialise in-process per target/viewport and every
  write re-reads the manifest and retries on a lost update, so two simultaneous approvals become two
  versions instead of one overwritten one.
- **The browser suite needs the production build** (`next start`), because the pages a user actually
  gets are the ones worth testing.

## Remaining limitations

- A regression never promotes a run to a baseline, and there is no scheduled refresh of an approved
  baseline — by design for this phase.
- Whole-viewport tolerance only: no ignore regions, no per-region masks, no full-page capture.
- A run is tied to one viewport; there is no multi-viewport approval.
- No git SHA on a run yet, so a regression cannot yet name the commit that caused it.
- Writes are local-only by rule (loopback + same origin), not by identity: there is no auth,
  no multi-tenancy and no queue. Concurrent runs share one Chromium.
- The browser suite is smoke-level and runs against a throwaway data directory; the console UI itself
  is not screenshot-diffed.
- The environment used for verification cannot composite browser frames reliably, so UI verification
  measures the rendered DOM and decodes rendered pixels rather than reviewing whole-page screenshots.

## Blockers

None outstanding.

## Next approved action

Phase 2 is delivered and verified on `main`. The recommended next milestone is **Phase 3 — make the
reference trustworthy and the gate useful**: ignore regions recorded in the report, git SHA per run,
multi-viewport approvals, and a CLI with a real exit code so UIProof can gate someone else's CI.
Details at the end of the README.
