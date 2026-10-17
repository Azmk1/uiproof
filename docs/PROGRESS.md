# UIProof — progress log

**North star:** an automated frontend quality platform that detects visual regressions,
accessibility problems and design inconsistencies — see `docs/GOAL.md`.

**Current milestone:** Phase 8 — autonomous repair engine and verification.
**Status:** complete, verified, committed.

Phase 1 = 8 / 8 criteria (100 %) · Phase 2 = 10 / 10 criteria (100 %) · Phase 3 =
12 / 12 criteria (100 %) · Phase 4 = 12 / 12 criteria (100 %) · Phase 4.5 = 7 / 7 criteria (100 %) ·
Phase 5 = 9 / 9 · Phase 5.1 = 7 / 7 · Phase 6 = 8 / 8 · Phase 7 = 8 / 8 ·
**Phase 8 = 10 / 10 criteria (100 %)**.

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

The same sequence ran on GitHub Actions for the Phase 2 commits
([run 38828130420](https://github.com/Azmk1/uiproof/actions/runs/38828130420), `main` at
`d619413`/`7622766`) and passed every step: install (`--frozen-lockfile`) → lint → typecheck →
**84 unit tests** → production build → Chromium install → **22 browser tests**. Nothing in this
milestone is claimed from a local-only run.

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

### Phase 3 verification evidence

```
pnpm lint        clean
pnpm typecheck   clean
pnpm test        155 tests / 13 files passed
pnpm build       ✓ compiled; 17 routes (demo pages static, every /api route dynamic), no warnings
pnpm test:e2e    33 tests / 4 files passed (Chromium, real production servers)
```

The browser suite now runs **four** servers: the Phase 1/2 one on a scratch port, the registered
project one, and short-lived ones for the unsafe-configuration and unreachable-application probes.

The same sequence ran on GitHub Actions for the Phase 3 commits
([run 38833704895](https://github.com/Azmk1/uiproof/actions/runs/38833704895), `main` at `c436158`)
and passed every step: install (`--frozen-lockfile`) → lint → typecheck → **155 unit tests** →
production build → Chromium install → **33 browser tests**, including the eleven-step walkthrough
against the example application. Nothing in this milestone is claimed from a local-only run.

Live measurement of the workflow, production server, example application on its own port:

| Step | Result |
|------|--------|
| Capture-only, `/` | `captured`, **0 / 0 px compared**, capture 310 ms, 942 ms end to end, PNG 48,302 bytes |
| Approve it | `bl-d8fe56c5-2ee8-4492-a3d7-aea0f15c41a4`, route `/`, 1280 × 800, 48,302 bytes — the same bytes as the capture |
| Baseline run, unchanged | **pass**, 0 / 1,024,000 px = 0 %, 363 ms |
| The application's own view file replaced | **regression**, 9,945 / 1,024,000 px = **0.97119140625 %**, capture 189 ms, compare 212 ms, diff PNG 67,500 bytes |
| Diff image decoded independently | Exactly **9,945** pixels of the difference colour `rgb(220, 38, 38)` — metric and picture agree (asserted by the suite on every run) |
| Original view restored | **pass**, 0 px, 391 ms |
| `/embedded` (image from another origin) | `captured`, `source.blockedRequests = 1` — refused, counted, page still rendered |
| Baseline manifest afterwards | **one** version, still active, revision 1 — a regression never approves itself |
| UIProof restarted on the same data directory | Baseline, its version and all five runs still present; a fresh baseline run still passes at 0 px |

Refusals, all through the real API: unregistered project → `400 project_not_registered`; unknown or
`../../etc/passwd` route → `400 route_not_registered`; `https://evil.example` target →
`400 invalid_target`; a registered route that 302s to `https://example.com` →
`502 capture_redirected` **with the run count unchanged**; a config file whose route path is
`/../../etc/passwd` → `projectConfigError` set, `projects: []`, and a capture →
`500 project_config_invalid`; an origin on a closed port → `502 project_unreachable` naming
`127.0.0.1:<port>`; a cross-site approval → `403`.

### Defects found and fixed during Phase 3 verification

1. **A real data-loss-class bug in `persistRun`, found by the new integration test.** Building the
   `writeFile` promises *before* awaiting `mkdir` let them race the directory creation, so the first
   run in a brand-new data directory failed with `ENOENT` and answered `500 storage_failed`. The unit
   suite could not see it (it never wrote a run into a fresh directory) and the Phase 1/2 browser
   suite hid it (its throwaway directory had usually already been populated). The file list is now
   built first and written only after the directory exists. This is exactly the kind of failure the
   brief's "real application" requirement is meant to surface — it appeared the moment a second,
   independent server used an empty data directory.
2. **The redirect refusal was right but unnamed.** A 302 to a public origin was refused by the
   network guard before Chromium could commit the navigation, so the capture failed with a generic
   `capture_failed` rather than `capture_redirected`. Navigation hops the guard refuses are now
   recorded and reported as the redirect they are, with the destination named.
3. **A Turbopack build warning** ("dynamic filesystem access causes tracing of the whole project")
   from `stat`-ing the registration file. Fixed with the documented opt-out comment on that one call,
   after checking that the file really is outside the build.
4. **Stale phase copy.** The hero badge and the header badge still said "phase 2"; both now say
   "phase 3", and the sidebar's "only `/demo` fixtures can be captured" note was rewritten — it had
   become false the moment registration landed.

### Honest security statement for this phase

- **The loopback bind is the control; the `Host` check is not.** A remote client cannot open a socket
  to `127.0.0.1`, which is what actually excludes other machines. A caller that can already reach the
  port can forge `Host`. `0.0.0.0` is no longer accepted as loopback precisely so that a wildcard bind
  cannot be mistaken for a local one.
- **There is still no identity.** Anyone with access to the machine and the port can approve, restore
  and capture. `UIPROOF_ALLOW_REMOTE_BASELINES=1` is not a security feature.
- **The lock is local-filesystem only.** One machine, no network share. On shared storage the
  optimistic re-read remains, which prevents an overwrite but is not a distributed lock.
- **`allowedOrigins` deliberately widens the browser's network reach** for a project that needs a
  second origin. It is per project, never a wildcard, and empty by default.
- **Only loopback origins can be registered.** No public or LAN targets, by design in this phase.
- **The page must stay on its registered origin.** A legitimate cross-origin redirect is refused;
  register the destination as its own route.

### Stale README measurements corrected

- The anti-aliased pixel count in `diff.png` was documented as 5,101; the measured value at the
  current revision is **5,105** (the Phase 1 palette fix moved a few edge pixels). Corrected with the
  method stated.
- The "diff image contains 39,333 pixels" line was one revision behind the rest of the document;
  the measured value is **39,334**, consistent with `metrics.changedPixels`.
- Test counts (44/6 files) and the "no baseline history" / "no browser-test harness" limitations were
  rewritten to match what now exists.

---

## Phase 3 — real application integration and security hardening

**Goal:** stop being a tool that only compares its own demo fixtures. Point UIProof at an
application that is already running on this machine, capture the routes you registered, approve
their baselines, and detect real drift — without giving the engine a way to screenshot arbitrary
URLs and without an authentication system (the brief ruled one out unless it was strictly needed).

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **A · request guard audited.** `0.0.0.0` is no longer loopback, and the servers bind loopback by default | **Verified** | `isLoopbackHost("0.0.0.0")` and `("0.0.0.0:3000")` are `false`; `package.json` `dev`/`start` and the browser-suite spawner all pass `-H 127.0.0.1`; pinned by `lib/http/loopback-binding.test.ts` |
| 2 | **A · network clients cannot get write access through spoofed headers** | **Verified** | The bind is the control and it is pinned by test; the suite connects over a real socket to a real server. Honest limit recorded below: `Host` is a header, so it is defence in depth, not authentication |
| 3 | **A · baseline concurrency made atomic across processes, with tests** | **Verified** | `.manifest.lock` taken with an atomic `mkdir` around the whole read-modify-write, owner pid recorded, no stealing from a live owner, 20 s abandonment, typed conflict error; `lib/compare/file-lock.test.ts` (6 tests) plus the existing optimistic re-read |
| 4 | **B · projects registered in a local configuration file** | **Verified** | `uiproof.config.json` (or `UIPROOF_PROJECTS_FILE`): id, name, loopback origin, allow-listed routes, optional `allowedOrigins`. `lib/projects/registry.ts` is pure and unit tested (18 tests); `config.ts` re-reads on size/mtime change |
| 5 | **B · configuration validated rigorously, separate from demo targets** | **Verified** | A malformed entry fails the whole file with a message naming it; origins must be loopback with no path/query/credentials; route paths reject traversal, encoded traversal, query, fragment, backslash, whitespace, controls; duplicate ids/paths refused; project baselines live under `baselines/projects/…` so they can never collide with a demo target |
| 6 | **C · Playwright captures registered routes** | **Verified** | `capturePage` takes a URL plus an optional origin allow-list; `buildProjectCaptureUrl` rebuilds the URL from the registration, never from the request |
| 7 | **C · unreachable servers produce actionable errors; redirects cannot escape; network restricted by default** | **Verified** | `probeReachable` → `502 project_unreachable` naming origin and port; a blocked or followed off-origin redirect → `502 capture_redirected` and nothing stored; a request context route aborts every request outside the approved origins and the count lands in `source.blockedRequests` (measured: 1 for the `/embedded` route) |
| 8 | **C · deterministic settings and project identity preserved** | **Verified** | Viewport, colour scheme, reduced motion, disabled animations, hidden carets, fonts/images awaited — unchanged from Phase 1; reports carry `source: { kind, scopeKey, projectId, projectName, routeId, routeName, origin, path, blockedRequests }` |
| 9 | **D · per-project, per-route, per-viewport baselines; explicit approval; versions and restore; no contamination; no migration** | **Verified** | Approve/activate/read all resolve a `BaselineScope` first; a run may only be adopted for the scope *and* viewport it came from; demo paths are byte-for-byte the Phase 2 paths, and a Phase 2 manifest still reads (16 new unit assertions cover both kinds) |
| 10 | **E · dashboard: project and route selection, capture, approve, drift** | **Verified** | One `Source` picker lists the demo fixtures and every registered route under its project's name and origin; modes are per-source (`fixture` is not offered for a project); a capture-only verdict says *captured*, not *pass*; the run timeline is scoped to the selected source |
| 11 | **F · an independent example application plus the whole workflow against it** | **Verified** | `examples/example-app` (dependency-free Node server, 4 routes + `/healthz` + a deliberate off-origin redirect) and `e2e/project-integration.test.ts` (11 tests): start → register → capture → approve → change its real UI → regress → restore → pass → restart → still there. Numbers in the evidence table below |
| 12 | **G · full verification, documentation, honest limitations, pushed to GitHub** | **Verified** | lint · typecheck · 155 unit tests · production build · 33 browser tests, all green; README documents registration, the workflow and the security boundary; `docs/PROGRESS.md` records the numbers; commit and push below |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M14 — hardening audit | `0.0.0.0` removed from loopback classification, servers bound to `127.0.0.1`, the escape hatch pinned by test; the Phase 2 read-write-reread race replaced by a real cross-process lock (`file-lock.ts`) with its own tests |
| M15 — run sources | `RunSource`, `BaselineScope`, `capture` mode and the additive `source` request field; `run-options.ts` resolves demo and project sources through one path, with typed refusals for an unregistered project or route |
| M16 — project registry | Pure parser (`registry.ts`) plus cached file reader (`config.ts`); the catalogue exposes projects, the configuration path and any configuration error verbatim |
| M17 — scoped baselines | `baseline-paths.ts` and `baselines.ts` generalised over scopes, `projects/…` namespaced, dual route trees sharing one handler module |
| M18 — capture hardening | Origin allow-list, blocked-request accounting, preflight reachability, redirect refusal, navigation-hop detection |
| M19 — dashboard | Source picker, per-source modes, capture-only states in the verdict, timeline and history, phase 3 copy |
| M20 — integration test | The independent example application and the eleven-step browser walkthrough, including the refusals |

---

## Phase 4 — the CLI, portable baselines and a CI gate

> Superseded in part by Phase 4.5: the workflow described below approved its own reference on the
> runner, which is exactly what Phase 4.5 removed. Read the Phase 4.5 section for the current gate.

**Goal:** turn UIProof from a console you watch into a tool a pipeline can gate on. Run it from a
terminal without the dashboard, get a documented exit code, and carry an approved baseline to a clean
CI runner as a committable artifact.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **CLI built on the existing engine** — `capture`, `check`, `projects`, `baselines`, `--help`, `--version`, explicit project/route/viewport/config/storage/tolerance options, no dashboard server | **Verified** | `src/cli/{args,main,output,exit-codes}.ts` + `scripts/uiproof.mjs` (esbuild bundle, git-ignored output). `main.ts` calls `runComparison`, `approveBaseline`, the store's readers and the portable module — no second diff, no HTTP. 13 CLI end-to-end tests run the real process |
| 2 | **Documented, deterministic exit codes** — `0` pass, `1` regression, `2` everything else, capture never reported as a pass | **Verified** | `exit-codes.ts` + the help text + the README table. Measured: pass `0`, capture `0` with `status: "captured"`, regression `1`, missing baseline `2 baseline_not_found`, unknown project/route `2 project_not_registered` / `route_not_registered`, unknown viewport and `--tolerance 500` `2` usage errors, off-origin redirect `2 capture_redirected`, unreachable app `2 project_unreachable` |
| 3 | **Readable output plus optional structured JSON** | **Verified** | `--json` writes exactly one JSON document to stdout and moves the human trail to stderr (`baselines status --json` verified to parse); the suite asserts the CLI's `report` object equals `<store>/reports/<id>/report.json`. `pnpm --silent` documented for redirection because pnpm's banner would otherwise land in the file |
| 4 | **Portable baseline format with metadata and clear scope ownership** | **Verified** | `src/cli/portable.ts`: `uiproof-baselines.json` + `scopes/(demo|projects)/…/<viewport>/versions/bl-<uuid>.png`; every version carries id, path, SHA-256, bytes, dimensions, `approvedAt`, `sourceReportId`, `capturedRoute`, note; scopes are `project:<id>/<route>` or `demo:<targetId>` |
| 5 | **Integrity validation of imported images** | **Verified** | Byte count, dimensions and SHA-256 are verified before a write (`lib/compare/integrity.ts`); a byte flipped in a bundle PNG → exit `2 baseline_integrity_failed` with the store untouched. 15 unit tests build bundles with the real export path and then edit the manifest by hand |
| 6 | **Explicit approval only, no automatic replacement, no overwrites, reports kept apart** | **Verified** | An import stores versions and activates only with `--activate`; a version id that already exists with different bytes is a conflict; an identical image is a no-op that still honours `--activate` (a bug the CLI suite found and this commit fixes); bundles never contain run reports |
| 7 | **Documented strategy for committing baseline artifacts** | **Verified** | README *Portable approved baselines* / *Gating a CI pipeline*, `examples/uiproof-baselines/README.md` (what it holds, how it was produced, the rendering-environment caveat), and a real committed bundle: 1 version, 47.2 KB PNG + manifest, 52 KB total |
| 8 | **Working GitHub Actions example, clean runner, no pre-existing data** | **Verified** | `.github/workflows/visual-regression.yml`: install → `playwright install --with-deps chromium` → start `examples/example-app` and wait for `/healthz` → import the committed bundle → approve on the runner → gate (unchanged `0`) → deliberate regression (`1`) → revert (`0`) → export → upload reports, JSON, bundle and the app log. Rehearsed command by command locally, then ran on GitHub: run 1 on `3ad6b88` **succeeded** on `ubuntu-latest` in 44 s and uploaded the `uiproof-visual-regression` artifact (914,987 bytes). `ci.yml` on the same commit also passed |
| 9 | **End-to-end verification with real Chromium** | **Verified** | `e2e/cli.test.ts`, 13 tests, real process, real Chromium: unchanged → `0`, changed → `1`, missing baseline → `2`, unknown project/route ↦ `2`, reachable-check on an unreachable app → `2`, JSON equals the persisted report, export/import into a working directory that has never run UIProof → `0` then `1` on a real edit, `--activate` honoured, tampered bundle → `2`. Numbers below |
| 10 | **Existing suites preserved and extended** | **Verified** | Unit 155 → **177** tests / 13 → **15** files; browser 33 → **46** tests / 4 → **5** files. All previous tests still pass unmodified |
| 11 | **Security and reliability maintained** | **Verified** | The CLI captures registered routes only (no URL input, same allow-list as the console); imported paths are re-derived from the validated scope and `resolveBundlePath` refuses anything leaving the bundle; unknown viewport/option/tolerance and missing bundle are typed usage errors; the console, its endpoints and the baseline lifecycle are untouched, and the browser suite still drives them |
| 12 | **Constraints respected, docs updated, full chain green** | **Verified** | No AI, no auth, no cloud database, no microservices, no npm publish (`private: true`), no architecture rewrite, Phase 1–3 APIs and stored data unchanged. `pnpm lint` · `pnpm typecheck` · `pnpm test` 177/177 · `pnpm build` · `pnpm test:e2e` 46/46, plus the workflow rehearsal |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M21 — CLI core | `args.ts` (pure parser, 7 tests), `exit-codes.ts`, `output.ts` (stdout/stderr split), `main.ts` dispatching to the engine |
| M22 — bundling and launcher | `scripts/uiproof.mjs`: esbuild bundles `src/cli/main.ts` into the git-ignored `.uiproof/cli/uiproof.mjs`, rebuilds only when a source file is newer, keeps playwright/pixelmatch/pngjs external, and forwards the child's exit code |
| M23 — portable bundles | `integrity.ts` (SHA-256, byte, dimension and decodability checks) and `portable.ts` (bundle layout, strict manifest parser, export from the store, import through the store's immutable write path) |
| M24 — store import path | `importBaselineVersion` and `listStoredBaselines` in `baselines.ts`: `wx` writes, manifest mutation under the existing lock, return-to-caller activation decision |
| M25 — CLI integration suite | `e2e/cli.test.ts` — 13 tests through the real process; found and fixed two real defects (below) |
| M26 — CI example | `examples/ci/uiproof.config.json`, the committed bundle plus its README, and `.github/workflows/visual-regression.yml`, rehearsed step by step here |
| M27 — verification | lint, typecheck, 177 unit tests, production build, 46 browser tests, CLI suite, workflow rehearsal, docs |

### Phase 4 verification evidence

```
pnpm lint        clean (0 errors, 0 warnings)
pnpm typecheck   clean
pnpm test        177 tests / 15 files passed   (was 155 / 13)
pnpm build       ✓ compiled
pnpm test:e2e    46 tests / 5 files passed     (was 33 / 4; cli.test.ts: 13 tests in 30 s)
```

| Check | Result |
|-------|--------|
| CLI, clean store | `baselines import --activate` added 1 verified version; `check` → `PASS 0% (0 / 1,024,000 px)`, exit `0` |
| CLI, real regression | `views/home.html` ← `home.changed.html`: `REGRESSION 0.9712% (9,945 / 1,024,000 px)`, exit `1`; JSON `status=regression changed=0.97119140625% (tolerance 0.1%)` |
| CLI, recovery | View restored → `PASS 0%`, exit `0`; the approved baseline was never touched (1 version, still active) |
| JSON vs persisted report | Equal in the suite (passing run and failing run) |
| Fresh working directory | Export → import into a directory with no prior UIProof data → `0` on the unchanged page, `1` after a real edit, `0` after restore |
| Committed bundle | `examples/uiproof-baselines`: 1 version, `project:example-app/home` @ desktop, 47.2 KB PNG + manifest, 52 KB total, SHA-256 recorded and re-verified on every import |
| Workflow rehearsal | Health wait → import → approve → `0` → deliberate change → `1` (JSON parsed) → revert → `0` → export (2 versions, 94.3 KB) → app left byte-identical to git |
| GitHub Actions, run 1 | `visual-regression.yml` on `3ad6b88`: **success** in 44 s (02:21:56Z → 02:22:43Z), one artifact `uiproof-visual-regression` (914,987 bytes) |
| GitHub Actions, CI | `ci.yml` on the same commit: **success** (02:22:00Z → 02:23:58Z) — lint, typecheck, 177 unit tests, production build and all **46** browser tests on Linux |

**Two real bugs the CLI suite found, both fixed at the source:**

1. **Every CLI invocation kept Chromium alive for ~61 s.** The engine shares one browser and closes it
   on a 60 s idle timer — correct for a server, wrong for a one-shot process, where the browser handle
   held the event loop open. A command that did its work in 1.1 s took 62.04 s to exit, measured. The
   CLI now closes the browser in a `finally` block; the same measurement is 1.8 s, and the CLI suite
   went from 507 s to 30 s.
2. **`baselines import --activate` silently ignored activation on an already-present version.**
   Importing without `--activate` and then again with it left `activeVersionId` null, so the
   documented clean-runner commands produced a store that could not be compared against. An import
   that finds identical bytes now activates that version under the manifest lock, and a unit test
   pins it (added, not rewritten, alongside the 14 existing bundle tests).

---

## Phase 4.5 — trusted baselines and genuine CI enforcement

**Goal:** make the visual-regression workflow able to actually stop an unapproved visual change
from merging. It could not, because of the defect this phase exists to remove: the "gate" imported a
committed baseline and then ran `capture --approve` on the application under test immediately before
checking it. Broken code could be approved seconds before it was measured, in the same job, and the
job would report a passing comparison. That is a demonstration of the CLI, not a gate.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **Reproducible Linux/Chromium environment**: pinned browser/runtime container, pinned fonts, viewport, device scale factor, locale, and honest documentation of what is *not* deterministic | **Verified** | `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a…` — pinned by tag *and* digest — is the `container:` of all three workflows and the image `scripts/ci/in-container.sh` reproduces locally; `playwright` is an exact dependency (no caret); Chromium build 1248, Node 24.21.0 and `fc-match system-ui` → *WenQuanYi Zen Hei* are recorded in every provenance record. What stays unpinned (another architecture, another digest, a page with live data) is written down in `docs/BASELINE-UPDATES.md` |
| 2 | **Trusted baseline generated in that environment**, exported with its SHA-256 metadata, committed, with a separate documented update process | **Verified** | `scripts/ci/generate-baseline.sh` captures → approves → exports inside the image; the committed bundle is the container-rendered one (`bl-c6198d4d…`, `sha256:28399ef6…c530e1`, 70,020 bytes, 1280 × 800). Updates go through `baseline-update.yml` (`workflow_dispatch` only, uploads an artifact, **commits nothing**) and `docs/BASELINE-UPDATES.md` |
| 3 | **The gate compares the pull request's code with the base branch's approved baseline**, no capture/approve during a check, `0` passes, `1` fails the job, `2` fails the job, artifacts uploaded either way, and a pull request cannot authorise its own change | **Verified** | `scripts/ci/trusted-baseline.sh` extracts the bundle from `github.event.pull_request.base.ref` with `git archive`; `run-gate.sh` imports/activates it, refuses to continue if the active version is not the trusted one, and exits with the comparison's own code. Links and numbers below |
| 4 | **Demonstration workflow preserved and clearly separated** | **Verified** | `.github/workflows/visual-regression-demo.yml` (named *walkthrough*, runs on `main`/manual) asserts each documented exit code, which is the opposite of a gate; the gate asserts nothing and simply fails |
| 5 | **Security appropriate to untrusted pull-request code** | **Verified** | `permissions: contents: read`; no secret referenced; the application under test is started with `env -i` (PATH/HOME/LANG/TZ/HOST/PORT only); nothing commits or approves; the CLI's loopback + registered-route surface is unchanged |
| 6 | **Six scenarios demonstrated with real screenshots** | **Verified** | 17/17 assertions in the walkthrough, seven scenarios, on Linux: `0` unchanged, `1` changed, **`1` with a rewritten bundle**, `0` restored, `2 baseline_not_found`, `2 baseline_integrity_failed` (with both hashes named), `2 project_unreachable` |
| 7 | **Existing functionality preserved; lint, typecheck, unit, browser, build and the real gate all run** | **Verified** | 177 → **188** unit tests (11 new, in `src/lib/ci/pinned-environment.test.ts`), 46 browser tests, production build, and all three workflows green on `main` |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M28 — pinned environment | Exact Playwright pin, image tag + digest, local reproduction wrapper (`scripts/ci/in-container.sh`), and the drift guard that fails `pnpm test` when the pin, the image or the Chromium revision stop agreeing |
| M29 — the scripts the workflows run | `lib.sh` (configuration, scrubbed app start, health wait, exit-code capture), `trusted-baseline.sh` (extract from a commit + verify every image against the manifest), `run-gate.sh` (load, verify the reference, check, report, exit with the CLI's code), `generate-baseline.sh` (capture → approve → export + provenance), `walkthrough.sh` (seven scenarios), `in-container.sh` |
| M30 — the gate | `visual-regression.yml` rewritten: base-branch extraction, `contents: read`, no capture, no approval, artifacts on success *and* failure, step summary |
| M31 — the demonstration | The old workflow split in two: the walkthrough above, and the reviewed `baseline-update.yml` that approves but never commits |
| M32 — the trusted baseline | Three container-rendered generations, byte-identical; the bundle replaced the Windows-rendered one deliberately (`git rm` + add, reviewed as one commit); `.gitattributes` pins the rendered app's line endings |
| M33 — proof on a real pull request | PR #1: a real UI change → gate fails; the same PR plus a bundle that matches its own UI → still fails; UI reverted → passes with the PR's bundle still in place |
| M34 — verification | Local container runs, GitHub runs, artifacts, docs |

### Phase 4.5 verification evidence

```
pnpm lint        clean
pnpm typecheck   clean
pnpm test        188 tests / 16 files passed   (was 177 / 15)
pnpm build       ✓ compiled
pnpm test:e2e    46 tests / 5 files passed
```

| Check | Result |
|-------|--------|
| Reproducibility of the reference | Four separate `generate-baseline.sh` runs in the pinned image — three locally (one from a CRLF checkout) and one on a `ubuntu-latest` runner — produced the **same** screenshot: `sha256:28399ef61ab1a1e8fe14d462cf6f42fc01d4657214b87009c67a04ac1cc530e1`, 70,020 bytes, 1280 × 800 |
| The update workflow, on a runner | [run 38845231360](https://github.com/Azmk1/uiproof/actions/runs/38845231360) — **success**: captures, approves, exports and uploads; its artifact's PNG carries the same SHA-256 as the committed baseline, and the repository is untouched |
| Gate, locally, in the image | Untouched application → `ok the run used the trusted reference bl-c6198d4d…`, `changed: 0% of the viewport`, `exit 0` |
| Walkthrough, locally | 17/17 assertions matched, seven scenarios, exit `0` |
| Gate on `main` | [run 38844220690](https://github.com/Azmk1/uiproof/actions/runs/38844220690) — **success**, `exit 0`, `changed: 0%`, trusted bundle from commit `df1312a`, `working tree copy: identical to the trusted bundle` |
| Walkthrough on `main` | [run 38844220574](https://github.com/Azmk1/uiproof/actions/runs/38844220574) — **success**, 17/17, including the gate ignoring a rewritten bundle and `baseline_integrity_failed` naming both hashes |
| Project CI on `main` | [run 38844220557](https://github.com/Azmk1/uiproof/actions/runs/38844220557) — **success**: lint, typecheck, 188 unit tests, production build, 46 browser tests on Linux |
| Real UI change in a pull request | [PR #1 / run 38844548795](https://github.com/Azmk1/uiproof/actions/runs/38844548795) — the gate step **fails**: `REGRESSION 0.4404% of the viewport changed (4,510 of 1,024,000 px), above the 0.1% tolerance`, against `bl-c6198d4d…`; the upload step still succeeds |
| A pull request that approves its own change | [PR #1 / run 38844710523](https://github.com/Azmk1/uiproof/actions/runs/38844710523) — the PR ships a bundle *matching* its changed UI; the gate logs `the working tree copy … DIFFERS from the trusted bundle; this check ignores it`, compares against the base commit anyway, and **fails**: `exit 1` |
| The same approval, loaded against its own UI | Locally in the image: `PASS 0% of the viewport changed (0 of 1,024,000 px)`, `exit 0` — the approval was legitimate and pixel-exact, and the gate rejected the change regardless |
| UI reverted, bundle still in the pull request | [PR #1 / run 38844877047](https://github.com/Azmk1/uiproof/actions/runs/38844877047) — **success**, `exit 0`, `changed: 0%`, with the same warning about the differing bundle |

**Defects found and fixed during Phase 4.5:**

1. **The gate approved what it was about to test** (above). No capture and no approval exists in the
   gate now, and a unit test asserts the workflow contains neither.
2. **GitHub rejected all three new workflows outright** — `runner` is not a context a workflow-level
   `env:` may use, so no job ran on any trigger. Found from the run's annotation, fixed by building
   the paths from `$RUNNER_TEMP` inside the steps, and guarded by a test that reads the restricted
   `env:` blocks (verified by injecting the mistake and watching the test fail).
3. **Container jobs cannot read their own workspace with git.** Running as root over a runner-owned
   checkout is "detected dubious ownership"; both workflows stopped at their first `git` command.
   The workspace is now named in git's environment configuration for those processes only.
4. **The host's `core.autocrlf` made the container believe the application was modified.** Chasing it
   produced a real answer rather than a workaround: an LF and a CRLF checkout render the same 70,020
   bytes, and `.gitattributes` now pins the rendered application to LF so the question cannot come back.

---

## Phase 5 — the accessibility and responsive quality gate

**Goal:** make UIProof detect the second and third thing the platform claims to detect —
accessibility problems and design inconsistencies — as measurements a pipeline can gate on. Until
this phase the tool could only see pixels: a page could pass a perfect visual comparison while
shipping an unlabelled button, a 3:1 contrast note and a 720px banner that escapes a phone.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **A clean page passes at every viewport, and a deliberate scroller is evidence, not a defect** | **Verified** | Demonstration point 1, through the real CLI: `audit` on the registered `/support` route exits `0` with `pass` at desktop, tablet and mobile — 0 findings, 0 defects at every viewport. The page's table is wider than a phone and is recorded as contained overflow with the region that absorbs it (`table-scroll`), never as a defect; `audit.json` on disk equals the report the CLI printed, with one screenshot per viewport beside it |
| 2 | **A missing accessible name is detected — and so is an incorrect one** | **Verified** | Point 2: the email field (`#support-email`) raises `label` (critical), the select left unnamed by a dangling `for=` raises `select-name` (critical), the icon-only button whose content is `aria-hidden` raises `button-name` (critical). Every finding carries the rule, its WCAG tags, the element's selector and markup and the runner's remediation text; fingerprints are `rule@selector` |
| 3 | **A genuine contrast failure reports its measured ratio; an undecidable one is a question** | **Verified** | Point 3: the muted note raises `color-contrast` (serious) whose evidence carries the measured ratio and both colours (`#9a9a9a` on `#ffffff`, below 4.5:1) — computed from the rendered page, not guessed. The ✎ glyph's contrast cannot be computed, so it is a `needs-review` question: reported beside the violations and never counted against the policy. The `accessibility.serious` failure's evidence names the violation's fingerprint and not the question's |
| 4 | **Horizontal overflow is detected at the mobile viewport and not at desktop** | **Verified** | Point 4: the fixed 720px maintenance banner gives `documentOverflowPx > 300` and an uncontained `element-overflow` finding at mobile (the failure's evidence names `maintenance-banner`), and `responsive.document-overflow` + `responsive.element-overflow` both fail the policy; the same page at desktop has zero defects and no responsive failure. The deliberate table scroller stays contained evidence throughout |
| 5 | **Restoring the code removes the findings, and the report names what was resolved** | **Verified** | Point 5: against a reference approved from the defective page, `--new-only` reports the fingerprints as known and none new; after the view is restored the same policy reports every one as *resolved*, none new or known; a plain audit is clean at all three viewports again |
| 6 | **The screenshot workflow is untouched, and a failing audit never touches a baseline** | **Verified** | Point 6: `capture --approve` and `check` work exactly as before beside the gate, and a failing audit exits `1` leaving the approved version untouched (1 version, still active, unchanged bytes) |
| 7 | **CI receives the documented exit status for each quality-gate policy** | **Verified** | Point 7: `0` clean, `1` policy failure at each `--fail-on` band, `2` when the scan cannot run at all — and `2` stays distinct from `1` throughout, matching the README's exit-code table |
| 8 | **API + dashboard: audit endpoints, findings by impact, responsive by viewport, evidence links** | **Verified** | `POST /api/quality/audit`, `GET /api/audits[?limit]`, `GET /api/audits/:id` and `GET /api/audits/:id/:file` (traversal-guarded like run artifacts); `e2e/quality-api.test.ts` (4 tests) proves the contract against a registered application including the refusals. The console's quality panel groups findings by impact, reports layout per viewport and links each measurement to the screenshot it came from, and restores the newest stored audit on reload (`e2e/dashboard-smoke.test.ts`) |
| 9 | **Full verification, documentation, honest limitations** | **Verified** | lint · typecheck · **223** unit tests / 19 files · production build · **58** browser tests / 7 files, the whole chain green; README documents the gate, its flags and what a pass does not mean; the limitations and the bug this phase found are recorded below |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M35 — measurements | `quality/axe.ts` (axe-core injected into the captured page, defensive reading of the runner's payload) and `quality/responsive.ts` (document overflow, elements escaping the viewport, deliberate-scroller detection); `quality/fingerprint.ts` gives every finding the identity `rule@selector` |
| M36 — policy and orchestration | `quality/policy.ts` (every threshold a number, one human-readable line) and `quality/audit.ts` (capture + scan per viewport preset, approved-reference comparison, verdict with named evidence); `quality/storage.ts` stores `audit.json` plus one screenshot per viewport under `audits/`, deliberately apart from run reports |
| M37 — CLI | `uiproof audit` plus `capture|check --quality`, the policy flags (`--fail-on`, `--new-only`, `--wcag-only`, `--max-document-overflow`, `--max-element-overflow`) and documented exit codes; `e2e/quality.test.ts` drives all seven demonstration points through the real process |
| M38 — defect fixtures | `examples/example-app/views/quality.html` and its deliberately broken twin `quality.changed.html` — five real defects (missing label, incorrect label, aria-hidden button, a measured contrast failure, a 720px banner) — swapped and restored by the test harness as real edits to the application's own view |
| M39 — API | The four audit endpoints, sharing the request guard and traversal rules of the run surface, plus typed client functions; `e2e/quality-api.test.ts` against the registered example application |
| M40 — dashboard | `quality-panel.tsx` (findings by impact, layout by viewport, evidence links, honest empty states) and `quality-audit-card.tsx` wired into the console; `quality/presentation.ts` keeps the grouping and the panel model pure and unit tested |
| M41 — verification and docs | The full chain green, README (gate, flags, evidence semantics, limitations) and this record |

### Evidence

| Check | Result |
|-------|--------|
| Clean page, all viewports | `QUALITY PASS`, exit `0`; 0 findings and 0 defects at desktop, tablet and mobile; the contained table scroller recorded with `table-scroll` at mobile |
| Five real defects swapped into the app's own view | `label`, `select-name`, `button-name` (critical), `color-contrast` (serious — measured ratio and both colours in the evidence), 1 needs-review question; mobile `documentOverflowPx > 300` with `maintenance-banner` uncontained; desktop clean |
| New / known / resolved | Against an approved reference: `--new-only` reports the defects as new on the changed page, known while they persist, and every one resolved after the restore |
| Evidence on disk | `<store>/audits/<id>/audit.json` equals the report the CLI printed; `desktop.png`, `tablet.png`, `mobile.png` each > 1,000 bytes; the API serves the same files at `/api/audits/<id>/<viewport>.png` |
| API contract | Clean audit → `200` with working evidence links; defects → `200` with findings by impact and layout defects only at mobile; history newest first with summaries equal to their reports; cross-site `403 untrusted_request`, unknown project `400 project_not_registered`, bad policy `400 quality_policy_invalid`, bad viewport `400 invalid_viewport`, traversal refused |
| Dashboard | **Run quality audit** in the browser → panel with findings by impact, per-viewport layout blocks and three evidence links returning `200 image/png`; the same audit restored after a reload |
| Full chain | lint · typecheck · 223 unit tests / 19 files · production build · 58 browser tests / 7 files — all green |

**A real defect this phase found, fixed at the source:**

1. **axe-core's injectable source does not survive bundling.** The library derives its browser
   `source` at runtime from `Function.prototype.toString()` of its own build. Inside the production
   server bundle that string is no longer the library: the injection appended silently, defined
   nothing, and every scan failed with `axe-core is not present in the page` — while the CLI's esbuild
   bundle worked, so nothing looked wrong until `e2e/quality-api.test.ts` drove the same engine
   through `next start`. The scanner now injects the pristine `node_modules/axe-core/axe.min.js` read
   from disk (the runtime value is only a fallback), and verifies after injecting that axe actually
   loaded, so a broken injection is an honest `quality_unavailable` rather than a misleading page
   error.

---

## Phase 5.1 — quality-gate correctness and CI enforcement

**Goal:** before adding new product features, make the Phase 5 quality engine honest in the places
where it could silently pass, and connect it to a genuine GitHub pull-request check. Three specific
false-pass paths were found and closed, and a second required gate now audits a real page at three
viewports on every pull request.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **No accessibility violation disappears from a verdict because of a reporting limit** | **Verified** | The scanner builds a complete, uncapped violation index (`AccessibilitySummary.violations`) before the 60-entry display cap, and the policy reads only that. `views/quality.flood.html` produces **68 findings** at desktop whose only serious violation (`svg-img-alt@#flood-icon`) sorts *past* the cap: the 60 shown findings contain **nothing** at `serious` and the verdict still fails on `accessibility.serious` with that fingerprint as evidence, and the report says `truncated: true` with `the verdict evaluated all 68`. Pinned by a unit test that feeds the policy a capped display list and a complete index that disagree |
| 2 | **An approved finding at one viewport never authorises the same finding at another** | **Verified** | References are matched per viewport (`judgeMeasurements` builds a viewport-keyed map; `evaluateQualityPolicy` compares each audited viewport only with its own reference). With a desktop-only approval of the defective page: `--new-only` across all viewports exits `1` because every fingerprint is new at mobile/tablet, and the verdict says `No approved accessibility snapshot exists for mobile`; the *same page* audited at desktop only exits `0` with 0 new and 4 known. The old union-of-all-references matcher would have passed both |
| 3 | **Approved snapshots survive export, a wiped store and import** | **Verified** | The portable bundle carries the snapshot per version (scanner version, `approvedAt`, sorted fingerprints, count) and import validates it strictly — unknown fields, unsorted/duplicated fingerprints and a count that disagrees with the list are refused (`portable_bundle_invalid`). Round trip proven end to end: approve → export → import into an empty store → `--new-only` desktop audit exits `0` with `new = 0` and the same 4 known fingerprints as the local store, `accessibilitySnapshots: 1` reported by the import. Backward compatible: a bundle without a snapshot imports with **no** reference and `accessibilitySnapshots: 0`, never an empty one (`--new-only` then counts everything and says so) |
| 4 | **A CI quality gate that fails on a real defect and never on a missing scan** | **Verified on GitHub Actions** | `.github/workflows/quality-gate.yml` audits the registered `/support` route at desktop, tablet and mobile inside the pinned image and maps `uiproof audit`'s exit code onto the job (`0` pass, `1` policy failure, `2` infrastructure). It never approves, and `audit-gate.sh` refuses `--new-only` unless a trusted bundle actually imported a reference. The audit JSON, one screenshot per viewport, the failure evidence and the app log are uploaded whether the audit passed or failed |
| 5 | **The checker is not the pull request's code, and the residual risk is stated** | **Verified** | `scripts/ci/trusted-checker.sh` extracts `src/`, `scripts/` and the registration file from the base branch with `git archive` and the gate runs that copy (`UIPROOF_CLI_DIR`); the workflow points the gate at `$WORK/checker/scripts/ci/audit-gate.sh` and the base revision's config, so a pull request cannot rewrite the policy engine, the scanner wrapper or the route list judging it. CODEOWNERS routes the checker, the workflows, the dependencies and the approved references to review, and `docs/BRANCH-PROTECTION.md` documents the required checks and states precisely what is **not** isolated: the installed dependencies still come from the revision under test |
| 6 | **Every demonstration, on real Chromium and real axe-core** | **Verified on GitHub Actions** | `scripts/ci/quality-walkthrough.sh`: clean page passes at 3 viewports (with 3 screenshots), introduced serious violation fails (`1`), introduced mobile overflow fails (`1`) with the failure naming `mobile`, desktop-only approval does not authorise mobile (`1`) while the desktop-only audit passes (`0`), portable reference classifies identically after export/import (`0`), the 68-finding page fails on the serious finding beyond the cap (`1`), the CSP page that refuses the scanner is `2` with **nothing persisted**, and the restore passes (`0`) — **38/38 assertions matched**, locally and in CI |
| 7 | **Delivery** | **Verified** | lint · typecheck · **238** unit tests / 19 files · production build · **62** browser tests / 8 files — all green; README and `docs/BRANCH-PROTECTION.md` written; committed and pushed without force-pushing |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M42 — complete measurements | `AccessibilitySummary.violations` (one entry per fingerprint, most severe impact retained) and `ResponsiveSummary.defects`, both built before any display cap; `snapshotOfSummary` and every approval now read the complete index; the CLI prints `(showing 60 of 68 findings; the verdict evaluated all 68)` |
| M43 — viewport-scoped references | `referencesByViewport` in the policy input, per-viewport new/known/resolved classification, `No approved accessibility snapshot exists for <viewport>` in the verdict notes, and a runner-version note when a snapshot was recorded by a different axe-core |
| M44 — portable snapshots | `AccessibilitySnapshot` through export/import with strict validation (`parseAccessibilitySnapshot`), applied again inside `importBaselineVersion`; the import reports how many versions carried one |
| M45 — fixtures | `views/quality.flood.html` (65 landmark findings + one serious `svg-img-alt`, 68 total), `views/quality.csp.html` served with `Content-Security-Policy: script-src 'self'` (the injection axe needs is blocked), and the CI registration file extended with `support`, `support-flood` and `support-csp` |
| M46 — the gate | `scripts/ci/audit-gate.sh` (evidence always written, `--new-only` refused without an imported reference), `scripts/ci/trusted-checker.sh` (base-revision checker + provenance), `UIPROOF_CLI_DIR` in `lib.sh`, `.github/workflows/quality-gate.yml` |
| M47 — the walkthrough | `scripts/ci/quality-walkthrough.sh` with 8 scenarios / 38 assertions and `.github/workflows/quality-walkthrough.yml`; the application under test is a scratch copy, so the checkout is never touched |
| M48 — trust boundary and docs | `.github/CODEOWNERS`, `docs/BRANCH-PROTECTION.md`, README (gate, scoping, portable snapshots, limitations), `e2e/quality-hardening.test.ts` (4 tests) |
| M49 — GitHub verification | `main` green across all five workflows at `56ddc79`; the quality walkthrough reproduces 38/38 assertions in CI; [pull request #2](https://github.com/Azmk1/uiproof/pull/2) introduces a real defect → `gate · accessibility and layout` fails (run 39005319352) with the audit report and 3 screenshots uploaded while the visual gate stays green, and the restore passes (run 39005580428) |

### Evidence

| Check | Result |
|-------|--------|
| The truncation defect, before and after | The fixture measures 68 findings; the readable list is capped at 60 and contains **0** findings at `serious` or above, while the complete index contains the serious `svg-img-alt`. The verdict fails on it, names the fingerprint, and the report carries `truncated: true` plus the evaluated-all note |
| Viewport scoping | Desktop-only approval → all-viewports `--new-only` audit exits `1`, records 1 reference (desktop), reports new findings and states that mobile and tablet have none; desktop-only `--new-only` audit exits `0` with 0 new / 4 known |
| Portable round trip | `baselines export` → bundle manifest carries `quality.fingerprints` (4), `runnerVersion`, `approvedAt`; `baselines import --activate` into an empty store reports `accessibilitySnapshots: 1`; the `--new-only` classification equals the local one (known 4, new 0, resolved 0) |
| Scanner unavailable | `views/quality.csp.html` → `audit` exits `2` with `quality_unavailable` ("Executing inline script violates … script-src 'self'"), `reportPath: null`, and **no `audits/` directory** in the store; `audit-gate.sh` maps it to an infrastructure failure |
| The gate itself, locally | `/support` clean → exit `0` with the report and 3 screenshots copied to the evidence directory; `/support-flood` → exit `1`; `/support-csp` → exit `2`; `--new-only` with no imported reference → exit `2` with "there is nothing trustworthy to compare against" |
| The walkthrough | `38/38 assertions matched`, exit `0`, in the pinned image on GitHub and in Git Bash locally |
| Full chain | lint · typecheck · 238 unit tests / 19 files · production build · 62 browser tests / 8 files |
| On GitHub Actions (`main`, `56ddc79`) | CI `success`, Visual regression gate `success`, Visual regression walkthrough `success`, Quality gate `success` (run 39005281985), Quality walkthrough `success` (run 39005281955, 38/38 assertions) |
| On GitHub Actions (PR #2, defect `38c959d`) | Quality gate **failure** (run 39005319352): `accessibility.critical` ×3 (`button-name`, `label`, `select-name`), `accessibility.serious` ×1 (`color-contrast`), `responsive.document-overflow` 346px at mobile, `responsive.element-overflow` `div#maintenance-banner +346px`, exit `1`, evidence uploaded. Visual regression gate `success` (untouched `/` route) |
| On GitHub Actions (PR #2, restore `8c1aab1`) | Quality gate `success` (run 39005580428), CI `success`, Visual regression gate `success` |

**What was not silently accepted:** the two false-pass paths were bugs, not missing features — a
reporting limit and a union-of-references matcher each let a real defect through. Both are now refused
by construction (the verdict reads only the complete index; a reference is matched only to the
viewport it was approved for), and both have a fixture that fails if the property is lost again.

---

## Phase 6 — the independent developer pilot

**Goal:** prove UIProof is genuinely usable outside its own repository — a realistic application,
written for the exercise, in its own working directory — before any AI-assisted repair work begins.
Every phase until now had been exercised on fixtures and an example app authored by the same person
who wrote the checker.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **A separate, realistic application — not one of this repository's fixtures** | **Verified** | `Ridgeway Ops`: a four-route Next.js 16.4.1 hire-desk console, its own git repository at `C:\Users\azmrk\Documents\GitHub\uiproof-pilot`, no shared code with UIProof. Dashboard, bookings list with filters, booking detail, settings form; hand-written CSS with desktop and mobile breakpoints; [docs/PILOT.md](PILOT.md#1--what-was-piloted) |
| 2 | **Installed by a reproducible local distribution — no npm publish** | **Verified (after a fix)** | `pnpm pack` → a 354 KB tarball whose `prepack` builds `dist/cli/uiproof.mjs`; `pnpm add -D file:vendor/uiproof-0.1.0.tgz` in the pilot, 40.5 s cold / 7 s reinstall. The first attempt — `pnpm add -D file:../uiproof` — produced **no command**: the package had no `bin`, no bundle and no `files` list. That blocking gap was fixed in this phase |
| 3 | **At least three routes, desktop and mobile viewports** | **Verified** | Four registered routes; eight approved baselines (four routes × desktop 1280×800 / mobile 390×844) in 11 s; `audit` additionally measures tablet, which the pilot learned matters for `--new-only` |
| 4 | **Approved baselines, genuine regressions and accessibility problems, accurately reported** | **Verified** | Four plausible edits (two KPI values + a 720 px promo strip; a label replaced by a span; low-contrast helper text) produced `REGRESSION 5.3404 %` desktop / `2.1269 %` mobile, `accessibility.critical select-name@#booking-status`, `accessibility.serious color-contrast@.hint-subtle` and `responsive.document-overflow 348 px` at mobile. The untouched route stayed `PASS 0 %` at both gates; the bookings page stayed visually `PASS 0 %` while failing the audit — the two gates caught different things |
| 5 | **Onboarding tested: setup, configuration errors, baseline review, CLI usability, CI integration, report readability** | **Verified** | Registration validated by `uiproof projects`; five configuration failures (missing file, malformed JSON, non-loopback origin, unknown project, unknown route) each exited `2` naming the file and the value; an unreachable app exited `2` and was never mistaken for a UI change; `baselines status` reviewed the store; export 528 KB → import on a wiped store → `PASS 0 %` with `9 version(s) carried an accessibility snapshot`; a 16-invocation gate script measured at 25–33 s, failing 1 → passing 0 |
| 6 | **False positives, confusing UX and unnecessary steps identified — and only demonstrated problems fixed** | **Verified** | No false positives: 8/8 checks reported 0 % after approval, deliberate scrollers stayed contained evidence, 24 undecidable contrast checks stayed questions. Four real problems were found and fixed (installability; a violation/question distinction missing from the listing; a count that called 24 questions "24 violations"; a store-relative evidence path) plus two cosmetic ones. Nothing was changed on speculation — [docs/PILOT.md](PILOT.md#12--what-was-changed-in-uiproof-because-of-the-pilot) lists the five edits |
| 7 | **CI trust-boundary weaknesses reviewed and documented without overclaiming** | **Verified** | [docs/PILOT.md](PILOT.md#10--remaining-trust-boundary-weaknesses) records seven weaknesses of a guest setup: the CLI arrives as a committed tarball, dependencies come from the revision under test, the reference bundle lives in the branch, no branch protection, no cross-machine determinism, a gate script a pull request can edit, and `needs review` never gating. The pilot's workflow has **not** run on a hosted runner and says so |
| 8 | **The whole workflow recorded: steps, real time, screenshots, findings, limitations** | **Verified** | [docs/PILOT.md](PILOT.md) with measured timings per step, five committed screenshots (`docs/pilot/`), the friction table in the order it was hit, the trust boundary and the limitations |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M42 — package the CLI | `bin/uiproof.mjs` launcher, `files` allow-list, `prepack` building `dist/cli/uiproof.mjs`, `--out` on the bundler; `dist/` ignored by git and lint. Verified by packing, installing into two throwaway projects and running capture/check/audit from the installed package |
| M43 — the pilot application | `Ridgeway Ops`: four routes, fixed data (no clock, so captures are stable), responsive CSS, its own git history, committed portable baselines and a CI gate script + workflow. Built outside this repository by design |
| M44 — baselines and detection | Eight approvals; defects applied as a real commit, measured, then reverted with `git checkout`; the defective-page-approved → fixed → `resolved 1` cycle run against a separate store |
| M45 — reporting fixes | `src/cli/finding-lines.ts` (needs-review marker + a count line that counts violations, not questions) with 7 unit tests; the audit transcript prints the absolute evidence directory; one duplicated hint removed; `e2e/quality.test.ts` asserts the printed path exists on disk |
| M46 — documentation | `docs/PILOT.md` (13 sections), README install path + the "approve every viewport you audit" rule + limitations rewritten, `docs/pilot/` screenshots, this record |

### Evidence

| Check | Result |
|-------|--------|
| Install from a tarball | `pnpm pack` → 354 KB (`bin/`, `dist/cli/`, `package.json`, `README.md`); `pnpm exec uiproof --version` → `0.1.0` and a real capture in two separate throwaway projects |
| Clean-store parity | `baselines export` (528 KB, 9 versions) → wiped store → `baselines import --activate` → `PASS 0%`, `audit --new-only` clean |
| Regressions | dashboard `1` (5.3404 % desktop / 2.1269 % mobile), settings `1` (0.5471 % / 2.551 %), bookings `0` visual but `1` audit, detail `0`/`0` |
| Quality gate | `audit` exit `1` on three routes with named fingerprints and a measured 348 px overflow; exit `0` after the revert |
| CI script | `GATE FAIL` with four named failures → after the revert `GATE PASS`, 25–33 s for 16 CLI invocations |
| Full chain (this repository) | lint · typecheck · **245** unit tests / 20 files · production build · **62** browser tests / 8 files — green |

**Problems this phase found in UIProof, all fixed at the source:** the package could not be installed
at all; the audit listing gave a violation and a needs-review question the same shape; the count line
called every finding a violation; the evidence path could not be opened as printed. Each was found by
using the tool, not by reading it — which is the point of the phase.

One more was self-inflicted and caught before it shipped: the bundling script that `pnpm pack` runs
took a `--out` flag for its own output path, which is also `baselines export --out <dir>`'s flag, so
every export/import in the browser suite broke. The suite failed, the flag was renamed to
`--bundle-out`, and the two failing files were re-run green. A build-tooling change is exactly as
capable of breaking the product as a source change, and the existing tests were the reason it did not.

---

## Phase 7 — evidence-grounded AI diagnosis

**Goal:** let a developer point UIProof at a stored failure and get a useful, evidence-grounded
explanation of what likely caused it — without the AI change any code, invent a source reference, or
touch a verdict.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **Structured diagnostic context; measured facts clearly separated from hypotheses** | **Verified** | `src/lib/diagnosis/context.ts` builds issues from a stored report only: rule/impact/WCAG tags/selector/markup, changed pixels/tolerance/viewport (and diff/current/baseline URLs), measured overflow in px. Needs-review results are excluded with a warning; a  passing or capture-only run is refused. 12 tests in `context.test.ts` assert the fact list verbatim, the viewport dedupe, and that a clean viewport is never offered as an issue |
| 2 | **Safe, read-only source investigation with verified paths and lines** | **Verified** | `workspace.ts` (no write path at all, canonical-root re-check on every read, dot-files/secrets/dependencies/build output skipped by rule, depth/count/size caps) and `candidates.ts` (route/selector/markup/text ranking with the reason recorded). `workspace.test.ts` covers a real temp tree, a junction escape and an unlisted path; `candidates.test.ts` asserts every reported line contains the match in the real file |
| 3 | **Provider-agnostic OpenAI-compatible model, optional, bounded** | **Verified** | `client.ts`: `POST {base}/chat/completions`, configurable key/base URL/model through `UIPROOF_AI_*` (or `OPENAI_*`), timeout 2–180 s, token cap, 200k response cap, one retry on `429`/`5xx`, one retry without JSON mode. Without a key nothing is called and every existing gate behaves exactly as before. 16 client tests cover configuration, retries, refusals, timeout and unreachable endpoints |
| 4 | **Structured, validated diagnosis with honest uncertainty** | **Verified** | `schema.ts` refuses missing fields, unknown keys, bad confidence, prose and oversized text; verifies every cited path against the files sent for that issue and every line against the excerpt actually shown, keeping failures as `unverifiedSources` with a reason. `diagnose.test.ts` covers a valid answer, a fenced answer, a fabricated file, an out-of-excerpt line, a skipped issue and a malformed answer |
| 5 | **CLI `uiproof diagnose` and a dashboard panel, separate from verdicts** | **Verified** | `src/cli/main.ts` `runDiagnose` (exit 0 diagnosed, 2 otherwise, never 1); `diagnosis-panel.tsx` wired into the run view and the audit card with measured facts first, `model-generated` + confidence + uncertainty, verified vs unverified citations and evidence links; three HTTP routes. A diagnosis file has no status/verdict field and lives under `diagnoses/`, which no gate reads |
| 6 | **Known-defect cases from the pilot, with deterministic fixtures** | **Verified** | `e2e/diagnosis.test.ts` runs the real support page with the pilot's defects (missing accessible name, contrast, mobile overflow), audits it with Chromium + axe, and diagnoses the stored audit through the CLI against a local OpenAI-compatible stub. The stub cites only the excerpt UIProof sent; the test asserts the cited `views/quality.html` line really contains `support-email`. Unit tests cover missing model, malformed answer, invented key, 5xx, missing/absent source and an escape attempt |
| 7 | **No source modification, no patches, no PRs, no hosted service, no auth, no rewrite** | **Verified** | The workspace module has no write API; `diagnose.test.ts` asserts the source tree is byte-identical in file listing after a run, and the audit JSON is unchanged after both success and failure. No existing test, workflow or baseline was changed |
| 8 | **Everything verified and documented; commit and push** | **Verified** | lint · typecheck · 334 unit tests / 26 files · production build · 71 browser tests / 9 files; README gains a configuration + limitations section. Live model call: **not performed** (no credentials in the environment) — reported separately, not implied |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M47 — diagnostic context | `context.ts` + `types.ts` + report fixtures reused by every later test; 12 context tests |
| M48 — source investigation | `workspace.ts`, `candidates.ts`; safety rules by construction (no write path, canonical root, skip lists, caps); 22 tests across `workspace.test.ts` (9) and `candidates.test.ts` (13), built on a real temporary tree. Three ranking rules came out of evidence rather than guesses: a file containing the reported selector now outranks the route's own page (a test showed the opposite), a comment that names a selector is no longer treated as the match (a live run cited the example app's own explanatory comment), and a template that can render markup outranks a stylesheet that merely mentions its class |
| M49 — model integration | `client.ts` with an `EnvLike` seam so tests never touch `process.env`; 16 client tests |
| M50 — schema and verification | `schema.ts`; 16 validation tests including fabricated citations and out-of-excerpt lines |
| M51 — pipeline | `prompt.ts` (bounded, deterministic assembly) and `diagnose.ts` (load report → measure → select → ask → validate → persist); 22 pipeline tests against real stores |
| M52 — CLI and HTTP | `diagnose` command with exit-code discipline; `/api/diagnoses` (GET history + availability, POST diagnose, GET one); config `sourceDir` with relative resolution; 6 parser tests |
| M53 — dashboard | `diagnosis-panel.tsx` in the run view and the audit card; no verdict rendered anywhere in it |
| M54 — end to end | `e2e/diagnosis.test.ts`: 5 CLI tests against the real example app + a local stub model, 4 API tests for the dashboard endpoints |
| M55 — documentation | README section (configuration, what is sent, what is verified, limitations), configuration table, API table, PROGRESS record |

### Evidence

| Check | Result |
|-------|--------|
| Unit suite | **334 passed**, 1 skipped (a file symlink that Windows without Developer Mode cannot create; the directory-junction escape test runs and passes). Diagnosis area: 88 tests across 6 files |
| Browser suite | **71 passed** / 9 files, including 5 real `uiproof diagnose` runs and 4 diagnosis-API checks |
| Source-location accuracy (a real session, not the test stub's fixtures) | Defective support view audited (exit 1, four failures), then diagnosed: 11 files listed, 5 read, 21,438 prompt characters, 23 ms, exit 0, **0 unverified citations**. The contrast issue cited `views/quality.changed.html:52` (the 2.81:1 note) and the missing-name issue cited `views/quality.changed.html:60` (`<input id="support-email" …>`), both verified against the line UIProof read |
| Safe boundaries | No source write API; source tree unchanged after a run; unlisted path refused; junction to an outside directory skipped; secrets/`.env`/`node_modules`/build output never listed |
| Live model | **Not run.** `UIPROOF_AI_API_KEY` and `OPENAI_API_KEY` are unset here, so no genuine provider call was made; the pipeline was exercised through the real HTTP interface against a local OpenAI-compatible stub instead |

---

## Phase 8 — autonomous repair engine and verification

**Goal:** take an actually broken frontend, propose one narrowly scoped repair, test it in an
isolated copy with the same measurements UIProof already trusts, reject it when it does not hold up,
and leave independently verifiable evidence — without ever altering the developer's working tree.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | **Diagnosis baseline is trustworthy:** live-model behaviour measured when credentials exist, citations vs causation kept distinct, source selection improved only with test evidence, Git revision recorded, stale references detected | **Verified (live model unverified)** | The Phase 7 pipeline is unchanged in behaviour and still passes its 88 tests (plus 1 host-specific skip), including citation verification against the line UIProof read. Phase 8 adds `revision.ts`: commit SHA, `git status` dirty state and up to 50 changed paths recorded per repair, plus a SHA-256 digest over every copied source file; `revision.test.ts` proves a changed or deleted file is reported stale. No `UIPROOF_AI_API_KEY`/`OPENAI_API_KEY` exists in this environment, so **no live provider call was made** and no claim about real-model quality is made |
| 2 | **Structured repair proposal:** measured issue, source change, explanation, files, expected improvement, uncertainty; validated patch output; never execute model commands | **Verified** | `proposal.ts` validates every field, the issue key against the offered list, confidence, uncertainty, size and patch shape; fences are tolerated and prose is refused. `prompt.ts` shows only measured issues plus bounded excerpts. Commands come only from the registration; `sandbox.ts` runs argument vectors with `shell: false`. `proposal.test.ts` / `prompt.test.ts` cover the refusals |
| 3 | **Isolated execution:** disposable checkout at a pinned revision, stale/unsafe paths refused, patches checked first, no baseline changes, clean sandbox environment, original preserved | **Verified** | `sandbox.ts` copies the registered `sourceDir` into a temporary directory with file/size caps, records the digest, refuses a tree that changes during the copy, and deletes it afterwards. `patch.ts` refuses traversal, absolute/drive/backslash paths, renames, `/dev/null`, hidden files, credentials, dependencies, generated output, CI policy, baselines and the registration file — all with a reason. Sandbox environment is allow-listed; sandbox URLs must be loopback; nothing writes to the source, a baseline or Git metadata. Tests assert the source file is byte-identical after every run |
| 4 | **Deterministic verification:** original defect gone, no passing route/viewport regressed, no new serious/critical findings, overflow improved or not worsened, build and tests pass, patch inside scope | **Verified** | `measure.ts` runs the real audit engine and the visual comparison against the sandbox; `verify.ts` classifies each target (fixed/improved/unchanged/not-measured), each regression (accessibility / layout / visual / build / test / scope), and computes `verified`, `partially-improved`, `rejected` or `unverified` from those measurements only. `verify.test.ts` covers every branch, including the deliberately bad patch |
| 5 | **Bounded iteration:** at most two attempts, evidence-driven revision, visible reasons, hard limits | **Verified** | `engine.ts` refuses `maxAttempts` outside 1–2, and the CLI clamps it. A failed attempt's recorded reasons and measurements are carried into the revision prompt (asserted by `e2e/repair.test.ts`: the second prompt contains `Previous attempt 1 was REJECTED`). Limits recorded in the run: 2 attempts, 4 patch files, 200 patch lines, 48,000 patch characters, 120 s per command, a wall-clock run budget and `UIPROOF_AI_MAX_TOKENS` |
| 6 | **CLI and developer experience:** `uiproof repair --audit <id>` plus failed reports, defects/diff/verification/screenshots/remaining issues/safety, export a verified patch, never merge/commit/approve | **Verified** | `runRepairCommand` in `src/cli/main.ts`: `--report`/`--audit` (exactly one), `--max-attempts 1|2`, `--out` writing the verified patch, `--json` with the full record. Exit `0` only for verified, `1` for no verified repair, `2` when it could not run. Five end-to-end scenarios in `e2e/repair.test.ts` drive the real engine; the patch download route serves `text/x-diff` from the stored record only |
| 7 | **Dashboard:** inspect candidates, compare results, view rejected attempts, download verified patches, status separate from authoritative verdicts | **Verified** | `repair-panel.tsx` renders in the failing run/audit path with a `model-generated` badge, the measured issue, the diff, before/after screenshots, every verification line, every attempt (including rejected ones with the reason) and a download link. It has its own `aria-label="AI repair"` section and never writes to the comparison or audit verdict. `e2e/repair-dashboard.test.ts` drives it in a real browser and asserts the audit panel still says `fail` |
| 8 | **Controlled real-world experiments:** missing name, contrast, mobile overflow, CSS visual regression; original tree unchanged; bad patch rejected | **Verified** | `e2e/repair.test.ts` runs all five scenarios on `examples/repair-app` with Chromium, axe-core and real PNG diffs. Only the model is a deterministic stub. Measured results below |
| 9 | **Preserve Phase 1–7 and verify everything:** lint, typecheck, unit, build, browser, CLI, repair tests | **Verified** | `pnpm lint` clean, `pnpm typecheck` clean, **383 unit tests** across 31 files (382 pass, 1 skipped on a host without symlink privilege), production build succeeds, **77 browser tests** across 11 files, including the 5 repair-engine scenarios, the dashboard panel, the CLI suite and every earlier phase |
| 10 | **Document and deliver:** actual model performance, attempts, verified successes, failures, cost, limitations, security assumptions; commit and push without force | **Verified** | README gains an *AI repair* section, registration fields, API routes, test rows and limitations; [PHASE8-REPORT.md](PHASE8-REPORT.md) records the evidence table, the measured before/after values, the cost bounds and the exact security assumptions; commit SHA and test counts are in that report |

### Milestone log

| Milestone | Outcome |
|-----------|---------|
| M56 — revision and isolation | `revision.ts` (Git SHA, dirty state, content digest, stale detection) and `sandbox.ts` (disposable copy, caps, scrubbed env, no shell, loopback only, readiness polling, teardown in `finally`); 8 unit tests |
| M57 — patch safety | `patch.ts`: a strict unified-diff parser and exact applier with no fuzz, a named denylist for every class of file a repair may not touch, extension and allow-list checks, and 4-file/200-line limits; 20 unit tests |
| M58 — proposal | `proposal.ts` (strict schema, issue-key validation, patch summarisation) and `prompt.ts` (measured issues, bounded excerpts, revision evidence); 10 unit tests |
| M59 — verification | `measure.ts` (audit + visual diff of the sandbox, before and after) and `verify.ts` (targets, regressions, build/test, scope, verdict policy with reasons); 12 unit tests |
| M60 — bounded engine | `engine.ts`: revision pinning, baseline measurement, baseline build/test, optional revision on failure, attempt budget, run budget, warnings, storage of every attempt; `storage.ts` writes `repairs/<id>/repair.json`, patches and screenshots |
| M61 — CLI | `uiproof repair` with exit-code discipline, patch export and JSON output; parser tests |
| M62 — HTTP and dashboard | `/api/repairs` (GET history + availability, POST run), `/api/repairs/:id`, patch and artifact routes; `repair-panel.tsx` wired into the audit card and run view |
| M63 — fixtures and end to end | `examples/repair-app` (four defects, a structural build check, a real test command, a registration file), `e2e/support/repair-app.ts`, `e2e/support/stub-model.ts`, 5 engine scenarios and 1 dashboard scenario |
| M64 — audit and documentation | Full verification run, README, PROGRESS and PHASE8-REPORT |

### Evidence

| Check | Result |
|-------|--------|
| Unit suite | **382 passed**, 1 skipped, 31 files. Repair area: 40 tests across 5 files |
| Browser suite | **77 passed** / 11 files, including 6 repair tests |
| Missing accessible name | Audit `fail` with `a11y:label@#email` (critical). Attempt 1 (a comment only) **rejected**: "did not improve: the same rule still fires on the same element". Attempt 2 added `<label for="email">Email</label>` → **verified**; support@mobile critical findings **1 → 0**, violations **2 → 1**, guard route `manual@desktop` **0 → 0** |
| Insufficient contrast | `.note` changed from `#9a9a9a` to `#595959` → **verified**; support@mobile serious **1 → 0**, violations **2 → 1**, the unrelated `label@#email` finding stayed and was **not** reported as a regression |
| Mobile horizontal overflow | banner `width: 720px` → `max-width: 100%` → **verified**; document overflow **354 px → 0 px**, escaping elements **1 → 0** |
| Visual regression | `padding: 8px 4px` → `24px 16px` against an approved baseline → **verified**; changed pixels **4,049 (0.3954 %) → 0**, status `regressed → match`; the baseline manifest and PNG were byte-identical afterwards |
| Deliberately bad patch | Fixes the missing name while making the `<h1>` low-contrast → target `fixed`, but **rejected**: "1 new serious/critical finding(s) appeared at support@mobile: color-contrast@h1" |
| Original tree | Every scenario asserts the fixture's `views/index.html` is byte-identical after the run; the dashboard test asserts the API's `originalUnchanged: true` and re-reads the file |
| Isolation | `/tmp` copy, `shell: false`, allow-listed environment, loopback sandbox, sandbox deleted after the run; the audit JSON, baseline store and source are never written |
| Live model | **Not run** — no credentials in this environment. All model behaviour described above is a deterministic OpenAI-compatible stub; the pipeline, not model quality, is what was measured |

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
- A quality audit is a scan, not a certification: it reports what one rule set found on one page, in
  one browser, at one moment. `needs-review` results are exactly what the runner could not decide and
  need a human; they are never counted as failures.
- "New findings" need an approved reference: without an approved baseline's accessibility snapshot
  an audit cannot say which findings are new, and says so instead of guessing.
- No git SHA on a comparison **run** yet, so a regression cannot yet name the commit that caused it.
  A repair pins one for the tree it copies and records it with the run.
- Writes are local-only by rule (loopback bind + same origin), not by identity: there is no auth,
  no multi-tenancy and no queue. Concurrent runs share one Chromium.
- Cross-process safety assumes one machine and a local filesystem; there is no distributed lock.
- Registered projects are loopback-only, and a page that redirects to another origin is refused
  rather than captured.
- The CLI is installable from a tarball (`pnpm pack` → `pnpm add -D <tarball>`, verified in the
  [pilot](PILOT.md)), but the package is still `private`: no registry, no consumer versioning
  contract, and re-installing after an upstream change is manual. From inside this repository,
  `pnpm uiproof` still rebuilds the git-ignored bundle when a source file changes.
- An approved baseline is only pixel-exact for the environment that rendered it. The committed
  example bundle is now rendered by the pinned image the gate runs in, and three independent runs
  produced identical bytes — but a different image digest, a different architecture or a page with
  live data still moves pixels, so a changed digest means "regenerate the baseline", not "the
  baseline is wrong".
- **The gate blocks only if the repository is configured to block.** A workflow cannot protect
  itself: requiring the `gate · trusted baseline` check, requiring review from code owners, requiring
  branches to be up to date and restricting pushes to the base branch are manual settings, listed in
  `docs/BASELINE-UPDATES.md`. Without them the gate is a signal, not a gate.
- **None of that protection transfers to a project that adopts the CLI.** The pilot's own workflow
  imports a bundle from its branch and runs a checker it installed from a committed tarball, so a pull
  request there could authorise or judge its own change. `docs/PILOT.md` lists the seven weaknesses a
  guest setup has and what it would take to close each one; the pilot's workflow has also not run on a
  hosted runner, and only its commands were exercised locally.
- The gate checks one project route at one viewport per invocation; more routes are a loop over
  `run-gate.sh` in the consumer's workflow.
- The walkthrough edits the application's view and the repository's bundle inside the runner's
  checkout to make its points, and restores both; a final step fails the job if the checkout is not
  clean afterwards. It is therefore unsuitable to run against pull requests, and does not.
- `capture` and `check` cover registered routes only; multi-route or multi-viewport gating is a loop in
  the consumer's pipeline, and there is no watch mode. Bundles may carry demo scopes, but the CLI cannot
  capture a demo fixture.
- The browser suite is smoke-level and runs against throwaway data directories; the console UI itself
  is not screenshot-diffed.
- The environment used for verification cannot composite browser frames reliably, so UI verification
  measures the rendered DOM and decodes rendered pixels rather than reviewing whole-page screenshots.
- **AI diagnosis is optional and heuristic.** Source selection ranks files by route shape, selector,
  markup and visible text; it can miss the file that actually causes a defect and can offer a
  plausible one that does not. The prompt records why each file was chosen and which lines matched,
  and the absence of a candidate is reported rather than filled in — but it is a hypothesis.
- **The model sees excerpts, not the repository, and can be wrong.** The schema check and citation
  verification prove the answer has the right shape and that its paths/lines are the ones UIProof
  showed; they cannot prove the explanation is true. Confidence and uncertainty are the model's own.
- **A diagnosis needs a registered `sourceDir`.** Without one the command exits `2` with instructions;
  there is no monorepo-aware multi-root investigation, and line numbers are as read at diagnosis time
  (a later edit can move them).
- **One request per diagnosis.** Up to 8 issues, 4 candidate files each, 30-line excerpts and a
  24,000-character prompt; there is no multi-turn investigation, no repository-wide search and no
  tool use. Oversized material is dropped with a warning rather than silently truncated.
- **No live provider call was made during verification.** The deterministic stub exercises the real
  HTTP interface; a genuine OpenAI-compatible call still depends on the operator's credentials.
- **A repair is an isolated experiment, not a merge.** It never writes to the registered source, never
  changes an approved baseline and never commits or opens a pull request; applying a verified patch is
  a manual action. The evidence proves only what was measured — the target and guard routes at the
  audited viewports, the configured build and test commands, and observable accessibility, layout and
  visual state.
- **The repair sandbox is a copy, not a container.** Generated application code runs with the
  developer's own OS privileges. Commands are limited to the registration and executed without a
  shell, the environment is allow-listed and the server is loopback-bound, but this is protection
  against accidental edits, not a boundary against hostile code.
- **Repair proposals are bounded and capped.** At most two attempts, 4 files and 200 changed lines per
  patch, one bounded model request per attempt. A defect that needs a wider change is out of scope and
  the run records the refusal rather than stretching the limits.
- **Repair quality with a real model is unmeasured here.** The deterministic stub proves the
  isolation, validation and verification pipeline — the numbers above are real measurements of real
  patches — but not how often a live model proposes the right one. That remains the honest gap.

## Blockers

None outstanding. One item needs a human: the branch-protection settings that make both gates
blocking — required status checks `gate · trusted baseline` **and** `gate · accessibility and layout`,
required code-owner review, up-to-date branches, restricted pushes to the base branch — are
repository settings GitHub does not let a workflow set. They are listed in
`docs/BRANCH-PROTECTION.md` (and the older gate section of `docs/BASELINE-UPDATES.md`).

One dependency of the quality gate is stated rather than hidden: the checker is extracted from the
base branch, but it resolves its installed dependencies from the revision under test, so a pull
request that edits `pnpm-lock.yaml` is still inside the trust boundary. CODEOWNERS routes those files
to review; a separate locked install is the next step.

## Next approved action

Phase 6 is delivered: UIProof has been installed into an application outside this repository and used
to approve baselines, catch real regressions and gate a pipeline — see [PILOT.md](PILOT.md). The
pilot's four product defects are fixed and covered by tests; its findings are recorded, including the
seven trust-boundary weaknesses a guest CI setup still has and the fact that the pilot's own workflow
has never run on a hosted runner.

Phase 7 is delivered: a stored failure can now be handed to an optional, OpenAI-compatible model
that explains it from UIProof's own measurements and from excerpts of the registered application
source, with every citation verified against the line UIProof read and no verdict touched. It is
covered by deterministic unit tests and a real end-to-end run of the pilot's defects; no live model
provider was called because no credentials were configured here, and that is reported rather than
implied.

Phase 8 is delivered: `uiproof repair` and the console's *AI repair* panel take a stored failure
through proposal → scope-checked diff → isolated copy → re-measurement → build and tests → verdict,
with every attempt stored. Five deterministic end-to-end scenarios cover all four required defects
and a deliberately bad patch, and each asserts the developer's tree is byte-identical afterwards.
No live model provider was called; that limitation is recorded here and in
[PHASE8-REPORT.md](PHASE8-REPORT.md) rather than dressed up as model performance.

The sharpening work from the pilot's friction list is still the next milestone: ignore regions
recorded in the report, a git SHA per **run** (repairs already pin one), `uiproof check --all` across
a whole project, the CLI published to a registry (the pilot took it as far as an installable
tarball), and multi-viewport approvals. Two smaller items belong with it: an automated check that the
manual branch protection settings in `docs/BASELINE-UPDATES.md` are actually configured, and a
scheduled regeneration probe that fails when a new image digest changes rendering rather than
letting it surface as a mystery regression. For repair, the next evidence to gather is real-model
repair success across a corpus of defects and a cost/latency baseline — then, and only then, an
optional review workflow for verified patches. Details at the end of the README.
