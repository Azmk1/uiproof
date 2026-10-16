# UIProof — progress log

**North star:** an automated frontend quality platform that detects visual regressions,
accessibility problems and design inconsistencies — see `docs/GOAL.md`.

**Current milestone:** Phase 4.5 — trusted baselines and genuine CI enforcement.
**Status:** complete, verified, committed.

Phase 1 = 8 / 8 criteria (100 %) · Phase 2 = 10 / 10 criteria (100 %) · Phase 3 =
12 / 12 criteria (100 %) · Phase 4 = 12 / 12 criteria (100 %) · Phase 4.5 = **7 / 7 criteria (100 %)**.

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
| Reproducibility of the reference | Three separate `generate-baseline.sh` runs in the pinned image — one of them from a CRLF checkout — produced the **same** screenshot: `sha256:28399ef61ab1a1e8fe14d462cf6f42fc01d4657214b87009c67a04ac1cc530e1`, 70,020 bytes, 1280 × 800 |
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
- Writes are local-only by rule (loopback bind + same origin), not by identity: there is no auth,
  no multi-tenancy and no queue. Concurrent runs share one Chromium.
- Cross-process safety assumes one machine and a local filesystem; there is no distributed lock.
- Registered projects are loopback-only, and a page that redirects to another origin is refused
  rather than captured.
- The CLI runs from this repository (the package is still `private`); a consumer needs the checkout,
  and `pnpm uiproof` rebuilds the git-ignored bundle when a source file changes.
- An approved baseline is only pixel-exact for the environment that rendered it. The committed
  example bundle is now rendered by the pinned image the gate runs in, and three independent runs
  produced identical bytes — but a different image digest, a different architecture or a page with
  live data still moves pixels, so a changed digest means "regenerate the baseline", not "the
  baseline is wrong".
- **The gate blocks only if the repository is configured to block.** A workflow cannot protect
  itself: requiring the `gate · trusted baseline` check, requiring review from code owners, requiring
  branches to be up to date and restricting pushes to the base branch are manual settings, listed in
  `docs/BASELINE-UPDATES.md`. Without them the gate is a signal, not a gate.
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

## Blockers

None outstanding. One item needs a human: the branch-protection settings that make the gate blocking
(required status check `gate · trusted baseline`, required code-owner review, up-to-date branches,
restricted pushes to the base branch) are repository settings GitHub does not let a workflow set. They
are listed in `docs/BASELINE-UPDATES.md`.

## Next approved action

Phase 4.5 is delivered and verified on `main`: the visual-regression workflow is a real gate — the
reference comes from the pull request's base branch, nothing in it captures or approves anything, the
comparison's exit code decides the job, and the whole job runs in one pinned container image so the
committed baseline and the runner's screenshot are comparable. A pull request with a real UI change
fails it; the same pull request shipping an approval of its own change still fails; reverting the UI
passes. The recommended next milestone is
**Phase 5 — make the gate sharper, and cheaper to run everywhere**: ignore regions recorded in the
report, a git SHA per run, `uiproof check --all` across a whole project, a published CLI package, and
multi-viewport approvals. Two smaller items belong with it: an automated check that the manual branch
protection settings in `docs/BASELINE-UPDATES.md` are actually configured, and a scheduled
regeneration probe that fails when a new image digest changes rendering rather than letting it surface
as a mystery regression. Details at the end of the README.
