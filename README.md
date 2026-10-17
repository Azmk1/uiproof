# UIProof

**Automated frontend quality platform.** UIProof renders a screen, compares it against a known-good
baseline, and tells you exactly which pixels moved — with the measured share of the viewport that
changed, the highlighted difference image, and the artifacts stored on disk.

Phase 1 delivered the engine and the console. Phase 2 made it a real regression tool: you **approve
a capture as the baseline**, every later run is diffed against that stored reference, and drift is
classified as pass or regression against your tolerance — with the baseline version that was used
recorded in the report. Phase 3 points it at your own work: **register an application that is already
running on this machine**, pick one of its routes, capture it, approve it, and every later run against
that route is drift-checked against your approved screen. Captures stay inside the origins you
registered. Phase 4 makes it a tool you can gate on: a **CLI with documented exit codes**, `0` pass /
`1` regression / `2` the tool could not answer, and **portable approved baselines** — bundles you
commit next to your code and a clean CI runner can load and compare against. Phase 4.5 makes that
gate trustworthy: the reference comes from the pull request's **base branch** rather than from the
pull request itself, nothing in the gate ever **captures or approves** anything, and the whole job
runs in one **pinned container image** so the committed baseline and the runner's screenshot are
comparable. Later phases add accessibility and design-consistency checks, GitHub integration, and
AI-assisted repair proposals — none of that is wired up yet.

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
- **Your own local applications.** A registration file names a loopback origin and an explicit
  allow-list of routes. Those routes appear in the console next to the demo fixtures, are captured in
  real Chromium, and get their own baselines — kept apart from the demo targets and from each other.
- **A developer console** at `/` to pick a source (demo fixture or registered route), a comparison
  mode, a viewport and a tolerance, run the pipeline, inspect baseline / current / difference
  screenshots, see the approved baseline and its version history, watch a comparison timeline, and
  reload any earlier run.
- **Two local demo fixtures** with deliberate, documented visual differences — plus a `/demo/reverted`
  state that stands in for "the fix", so a regression can be produced and then undone without editing
  source. The engine is testable the moment the app boots.
- **Local persistence.** Screenshots and the JSON report are written to `.uiproof/data`, so a page
  refresh — or a server restart — keeps the last run, the approved baseline and the version history
  on screen.
- **A CLI that a pipeline can gate on.** `pnpm uiproof capture|check|audit|projects|baselines` runs the
  same engine without the dashboard, prints one JSON document for automation, and separates "your UI
  changed" (`1`) from "the tool could not answer" (`2`).
- **Portable, integrity-checked baselines.** `baselines export` writes a bundle you can commit;
  `baselines import --activate` loads it on a machine that has never seen UIProof, verifying every
  image against its recorded SHA-256, byte count and dimensions first.
- **Accessibility and layout audits.** `pnpm uiproof audit` runs axe-core against the live DOM and
  measures horizontal overflow at every viewport preset — desktop, tablet and mobile — judging both
  against a written policy whose every threshold is a number you can disagree with. Findings carry
  the rule, the element's selector and markup and the runner's remediation text; there is no score.
  Results the runner cannot decide are reported as questions ("needs review"), never as failures, and
  a passing scan only claims what it proves: this rule set found nothing on this page, in this
  browser, at this moment.
- **A quality panel in the console.** The dashboard runs the same audit for the selected source and
  renders findings grouped by impact, layout results per viewport and a link to the screenshot each
  measurement was taken from. Audits are stored like runs — a structured report plus one screenshot
  per viewport — and the newest one for the source is restored on reload.
- **A CI gate that can actually fail.** [.github/workflows/visual-regression.yml](.github/workflows/visual-regression.yml)
  compares a pull request's code against the approved bundle committed on its base branch, inside the
  pinned rendering image, and lets the comparison's own exit code fail the job. It never captures and
  never approves — a job that approves the page it is about to test cannot fail. The pass →
  regression → restore walkthrough is a separate workflow, labelled as the demonstration it is.
- **A second gate for accessibility and layout.** [.github/workflows/quality-gate.yml](.github/workflows/quality-gate.yml)
  audits the example application's support page at desktop, tablet and mobile with real Chromium and
  real axe-core, and fails the required check when the documented policy fails — an accessibility
  violation at `serious` or above, or layout escaping the viewport. A scan that cannot run is exit
  `2`, never a green build, and the audit JSON with one screenshot per viewport is uploaded whether
  the audit passed. The checker that judges the pull request — `src/`, `scripts/` and the registered
  route list — is extracted from the pull request's base branch, so a pull request cannot rewrite the
  policy engine judging it; the dependencies it borrows from the revision under test are the stated
  limitation ([docs/BRANCH-PROTECTION.md](docs/BRANCH-PROTECTION.md)).
- **A deliberately closed capture surface.** The engine only ever navigates to compiled demo routes
  or to routes named in the registration file, on the loopback origins that file declares. A browser
  request cannot name a URL: it sends a project id and a route id, and the server resolves them
  against the configuration. While capturing, the browser's network access is restricted to the
  registered origin (plus any origin the registration explicitly allows), so a page cannot quietly
  pull in a third-party asset.

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

## Testing your own local application

UIProof can capture an application that is already running on this machine — your dev server, your
preview build, anything on loopback. Nothing is uploaded and nothing is fetched from the internet:
the browser it drives talks to `127.0.0.1` (and to whatever you explicitly allow).

### 1 · Declare it

Create `uiproof.config.json` in the repository root (see
[examples/uiproof.config.example.json](examples/uiproof.config.example.json)):

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My app",
      "origin": "http://127.0.0.1:5173",
      "routes": [
        { "id": "home", "name": "Home", "path": "/" },
        { "id": "settings", "name": "Settings", "path": "/settings" }
      ],
      "allowedOrigins": []
    }
  ]
}
```

| Field | Rules |
| ----- | ----- |
| `id` | Lowercase letters, digits and dashes, up to 40 characters. Unique across the file. |
| `name` | How the project is labelled in the console (1–60 characters). |
| `origin` | `http(s)://` on a **loopback** host with **no** path, query, credentials or fragment — `http://127.0.0.1:5173`, not `https://staging.example.com`. |
| `routes` | A non-empty allow-list. Each entry needs an `id`, a `name` and a `path` that starts with `/` and contains no traversal (literal or percent-encoded), query, fragment, backslash or whitespace. |
| `allowedOrigins` | Optional. Extra origins the *page* may load resources from while being captured. Empty by default, so a capture is hermetic unless you widen it on purpose. Any `http(s)` origin; wildcards are refused. |

A malformed entry fails the whole file with a message naming the entry, and the console says so — half
a registry silently applied would be worse than none. The file is re-read whenever it changes (cached
on its size and modification time), so registering a route needs no restart.

Set `UIPROOF_PROJECTS_FILE` to keep the file somewhere else:

```bash
UIPROOF_PROJECTS_FILE=~/work/my-app.uiproof.json pnpm dev
```

### 2 · Capture, approve, drift

1. Start your application (for the bundled example: `pnpm example:app`).
2. Open the console, pick your route under **Source**, and choose **Capture only**. One screenshot is
   stored — the console reports **captured**, never "pass", because there is nothing to compare
   against yet.
3. Press **Approve this run as the baseline** and confirm.
4. Choose **Approved baseline** and run again. An unchanged screen reports **0 %**; change your UI in
   your editor, run again, and the difference is measured, highlighted and stored.
5. Fix (or revert) the UI and run once more: back to **0 %** against the same approved version.

Approving is always explicit and always additive: replacing a baseline appends a version, restoring
an older one is one action, and a regression never approves itself.

### 3 · Watch it work on the example app

The repository ships a second web application for exactly this: a small billing UI under
[examples/example-app](examples/example-app) that UIProof did not write.

```bash
pnpm example:app                       # http://127.0.0.1:4173
cp examples/uiproof.config.example.json uiproof.config.json
pnpm dev                               # http://localhost:3000
```

`views/home.changed.html` is the same screen with different figures, a recoloured header rule and two
status changes. Copy it over `views/home.html` (or edit that file yourself — the server re-reads it on
every request), run the comparison again, and the console reports the regression. Put the original
back and it passes. That is the whole loop, on an application that has nothing to do with UIProof's
own fixtures.

### What is refused

| Attempt | Answer |
| ------- | ------ |
| A project id that is not in the file | `400 project_not_registered` |
| A route id that is not in that project (including `../` tricks) | `400 route_not_registered` |
| An absolute URL as a target | `400 invalid_target` |
| A registered route whose page redirects off the registered origin | `502 capture_redirected`, and nothing is stored |
| A development server that is not listening | `502 project_unreachable`, naming the origin and the port |
| A configuration file with an unsafe route path | The whole file is reported unusable (`GET /api/catalog` carries `projectConfigError`); a capture returns `500 project_config_invalid` |
| A resource on an origin the registration does not allow | The request is aborted in the browser and counted in the report's `source.blockedRequests` |
| A cross-site or non-loopback approval | `403` |

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
    │   ├── run-options.ts             # pure parsing/validation of one run request│   ├── baseline-paths.ts          # pure baseline naming + traversal guards, per scope
│   ├── baselines.ts               # approved-baseline store: approve, activate, read
│   ├── file-lock.ts               # cross-process lock (atomic mkdir) for manifest writes
│   ├── source-selection.ts        # pure: the console's source model (demo target | project route)
│   ├── diff.ts                    # pure: decode PNG → normalise → pixelmatch → diff PNG
│   ├── browser.ts                 # Chromium singleton with idle shutdown
│   ├── capture.ts                 # deterministic capture + origin allow-list + redirect refusal
│   ├── storage-paths.ts           # pure path rules + traversal guards
│   ├── storage.ts                 # filesystem persistence of artifacts and reports
│   ├── engine.ts                  # orchestrates one run (fixture, baseline or capture)
│   └── errors.ts                  # typed errors → HTTP status mapping
    ├── projects/                    # registered local applications
    │   ├── registry.ts              # pure: parse and validate a registration file
    │   └── config.ts                # cached reader (env path or uiproof.config.json)
    ├── quality/                     # accessibility + responsive measurements (no React)
    │   ├── axe.ts                   # axe-core runner: inject, scan, defensive payload reading
    │   ├── responsive.ts            # document/element overflow, deliberate-scroller detection
    │   ├── policy.ts                # the deterministic pass/fail policy + its description
    │   ├── fingerprint.ts           # stable finding identity: <rule>@<selector>
    │   ├── presentation.ts          # pure: findings by impact, viewport blocks, panel model
    │   ├── audit.ts                 # orchestrates one audit across the viewport presets
    │   └── storage.ts               # audit reports + per-viewport screenshots on disk
    ├── http/                        # request trust, capture origin, local-only guard, baseline handlers
    ├── api-client.ts                # typed fetch client used by the console
    └── format-time.ts
```

```
e2e/                                   # browser suite (real Chromium, real servers)
├── support/e2e-server.ts              # boots `next start` on a scratch port + data dir
├── support/setup.ts                   # Vitest global setup / teardown
├── support/helpers.ts                 # assertions, API readers, mode/variant selection
├── support/example-app.ts             # starts the independent example app for the tests
├── dashboard-smoke.test.ts            # console flow, measured verdict, quality audit panel, persistence
├── accessibility.test.ts              # the Phase 1 audit regressions, pinned
├── baseline-lifecycle.test.ts         # approve → pass → regress → recover → restore → reload
├── project-integration.test.ts        # register → capture → approve → real UI change → regress → restore → restart
├── cli.test.ts                        # the CLI through the real process: exit codes, portable bundles
├── quality.test.ts                    # the quality gate's seven demonstration points, through the CLI
├── quality-hardening.test.ts          # the cap, viewport scoping, portable snapshots, refused scanner
└── quality-api.test.ts                # the audit HTTP API: evidence links, findings, refusals
examples/
├── example-app/                       # the independent application (no dependencies)
│   ├── server.mjs                     #   reads views/ per request; /moved redirects away
│   ├── views/                         #   home, home.changed, settings, pricing, embedded
│   └── assets/app.css
└── uiproof.config.example.json        # how to register it
.github/workflows/ci.yml               # install · lint · typecheck · test · build · e2e
```

### Pipeline

```
POST /api/compare
      │
      ├─ resolve the source ─────────► run-options.ts
      │    · demo target id ──► targets.ts        (compiled allow-list)
      │    · project + route ─► projects/registry.ts (the registration file, not user input)
      ├─ validate viewport  ──► targets.ts
      ├─ validate tolerance ──► metrics.ts
      └─ resolve mode + page state ──► run-options.ts, targets.ts
      │
      │  mode = fixture            mode = baseline               mode = capture
      │  ─────────────            ───────────────               ──────────────
      ├─ capture /demo/baseline   ├─ load approved version       └─ capture just the page
      └─ capture the page state   └─ capture the page state          (nothing to compare yet)
                 │                          │                             │
                 └──────────────┬───────────┘                             │
                                │                                         │
                 ├─ decode + dimension match ──► diff.ts                  │
                 ├─ pixelmatch ────────────────► changed pixels + diff PNG
                 └─ verdict ───────────────────► metrics.ts (tolerance decides pass/regression)
                                │                                         │
                                └──── write PNGs + report.json ◄──────────┘
                                      (with the baseline version that was used)
                                      ──► storage.ts (.uiproof/data)
```

Approval is a separate, explicit step that never happens as part of a run:

```
POST /api/baselines            POST /api/baselines/…/activate
   │                                │
   └─ copy the run's current.png    └─ point the manifest at an existing version
      to bl-<uuid>.png, append a        (restore an older reference; every image stays)
      version to manifest.json,
      set it active — atomically,
      under a cross-process lock

scope = { kind: "demo", targetId }            scope = { kind: "project",
          ────────────────────────                    projectId, routeId }
   baselines/<target>/<viewport>/                  ──────────────────────────
                                                     baselines/projects/<project>/<route>/<viewport>/
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
| `GET`  | `/api/baselines/projects/:project/:route/:viewport` | The same for a registered project route                                 |
| `POST` | `/api/baselines/projects/:project/:route/:viewport/activate` | Replace / restore a project route's reference                  |
| `GET`  | `/api/baselines/projects/:project/:route/:viewport/:version.png` | An approved project baseline image                  |

`POST /api/compare` and `POST /api/baselines` accept one of two bodies. Phase 3 spelling, which is
what the console sends:

```json
{ "source": { "kind": "project", "projectId": "my-app", "routeId": "home" },
  "viewportId": "desktop", "mode": "capture" }
```

and the Phase 1/2 spelling, still accepted unchanged: `{ "targetId": "invoice-summary", "mode": "fixture" }`.
A run's `mode` is `fixture`, `baseline` or `capture`; an absent mode means "whatever this source does by
default" — the fixture pair for a demo target, a plain capture for a project route.

Errors use a stable shape and status: `{ "error": { "code", "message" } }` — `400` invalid input or
unsafe path, `403` cross-site request or non-local write, `404` unknown run or unknown baseline
version, `502` capture failure (including a refused redirect and an unreachable app), `503` Chromium
unavailable, `500` an unusable registration file.

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

# capture one route of an application registered in uiproof.config.json
curl -s -X POST http://localhost:3000/api/compare \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"source":{"kind":"project","projectId":"my-app","routeId":"home"},"mode":"capture"}'
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
   *and* viewport it was captured at; a Desktop run offered as the Mobile reference is a `400`. The
   same holds across projects: a run of one project route is never another project's reference.
7. **State-changing calls are local-only.** `/api/baselines` and `/activate` refuse non-loopback
   hosts and foreign origins. See *How local-only actually works* below — the honest version.
8. **Only registered origins are captured.** A project must be a loopback `http(s)` origin with an
   expiry-free path, and every capture URL is rebuilt from the registration (`buildProjectCaptureUrl`)
   and re-validated against the same path rules. A route the file does not name does not exist: the
   API answers `400`, it never guesses a URL.
9. **The capture browser is restricted to approved origins by default.** Every request the page makes
   is checked against the captured origin plus the registration's `allowedOrigins`; anything else is
   aborted and counted in the report as `source.blockedRequests`. Widening this is a deliberate edit.
10. **A redirect cannot move the capture.** If the page leaves its registered origin — followed or
    blocked by the network guard — the capture fails with `capture_redirected` and stores nothing.

### How local-only actually works

Be precise about this, because `Host` is a header and headers are written by the client:

- **The real control is the bind address.** `pnpm dev`, `pnpm start` and the browser suite all bind
  `127.0.0.1`. A socket on loopback cannot be connected to from another machine, so a remote client
  has nothing to talk to. If you start UIProof some other way, bind it yourself.
- **The `Host` check is defence in depth, not authentication.** `0.0.0.0` and `::` are *not* treated as
  loopback (they mean "a wildcard bind, reachable from the network") and neither is anything that
  merely contains `localhost`. But a caller that can already reach the port can send `Host: 127.0.0.1`.
  The bind, not this check, is what keeps other machines out.
- **There is no identity.** Anyone with access to this machine and to the port has full write access:
  no users, no roles, no tokens. `UIPROOF_ALLOW_REMOTE_BASELINES=1` exists only for someone who has
  put UIProof behind their own access control — it is not a security feature. Do not expose it to a
  network you do not control.

---

## Baselines and drift detection

A baseline is an **approved capture**, not a second fixture. Approving run `R` for
`(target, viewport)` copies `R`'s `current.png` byte-for-byte into an immutable version file and
appends a version to that pair's manifest:

```
.uiproof/data/
├── reports/run-<uuid>/                     baseline.png · current.png · diff.png · report.json
│                                            (a capture-only run has current.png only)
├── baselines/<target>/<viewport>/           demo targets — unchanged since Phase 2
│   ├── manifest.json                       the version list + which one is active
│   └── versions/bl-<uuid>.png              one immutable approved image per version
└── baselines/projects/<project>/<route>/<viewport>/
    ├── manifest.json
    └── versions/bl-<uuid>.png
```

The `projects` segment namespaces registered applications away from demo targets, so the two can
never share a directory — and project baselines existed only from Phase 3 onwards, so nothing from
Phase 2 was migrated or rewritten.

Properties, all of them verified rather than intended:

- **Approval is explicit.** It only happens through `POST /api/baselines`. A regression never
  approves itself, and a failed comparison leaves the manifest untouched.
- **Nothing is overwritten.** Approving again appends a version; the older image stays on disk and
  stays served. Restoring it is one `activate` call and it keeps its original `approvedAt`.
- **Each version records its provenance:** id, `approvedAt`, `sourceReportId`, the route it captured
  (`capturedRoute`), image size and bytes, and an optional note.
- **Metadata updates are atomic, and cross-process safe on one machine.** The manifest is written to
  a temporary file in the same directory and renamed over the target, so a crash mid-write cannot
  leave half a JSON document. Every mutation holds a filesystem lock (`.manifest.lock`, taken with an
  atomic `mkdir`) for the whole read-modify-write, waits rather than stealing a lock whose owner is
  still alive, and treats a lock whose owner has died as abandoned after 20 s. Approvals also serialise
  in-process per scope, and every write re-reads the manifest and retries on a lost update. This is a
  local-filesystem lock, not a distributed one: it assumes one machine and no network storage.
- **A report says which reference it used.** Baseline-mode reports carry
  `baseline: { versionId, approvedAt, sourceReportId, capturedRoute, width, height, imageUrl }`,
  which is what makes a regression attributable to a specific approved image.
- **Separate per source and viewport.** Desktop and Mobile approvals are independent records, and so
  are the demo targets and each registered project route. A run is always resolved to a scope before
  anything is read or written, and a manifest whose rows disagree with its own scope is treated as
  unreadable rather than trusted.
- **Only a whole, matching image can be adopted.** The stored `current.png` must decode before it is
  adopted, and a manifest whose rows disagree with its own directory is reported as unreadable rather
  than trusted.
- **No baseline is a normal state.** `GET /api/baselines/:target/:viewport` answers
  `{ "baseline": null }` with `200`; the console renders "nothing approved yet" and disables baseline
  mode instead of failing.

---

## The command line

`pnpm uiproof <command>` runs the same engine as the console, in a process a pipeline can gate on. It
never needs the dashboard server, an API key or a hosted service: it reads the registration file,
drives Chromium, and reads and writes the store at `UIPROOF_DATA_DIR` (default `.uiproof/data`) — the
same store the console uses, so the two are interchangeable on one machine. Nothing about the
comparison is reimplemented: the CLI calls `runComparison`, the baseline store's own readers and
writers, and the portable-bundle module.

| Command | What it does |
| ------- | ------------ |
| `uiproof capture --project <id> --route <id>` | Captures the route and stores the screenshot |
| `uiproof check --project <id> --route <id>` | Captures the route and diffs it against its approved baseline |
| `uiproof audit --project <id> --route <id>` | Measures accessibility and layout and judges them by policy |
| `uiproof projects` | Lists the projects and routes in the registration file |
| `uiproof baselines [status]` | Shows the approved baselines, their versions and which one is active |
| `uiproof baselines export (--project <id> \| --all) --out <dir>` | Writes a portable baseline bundle |
| `uiproof baselines import --from <dir> [--activate]` | Loads a bundle into this machine's store |
| `uiproof --help` · `uiproof --version` | Help and version |

Options: `--project`, `--route`, `--viewport desktop|tablet|mobile`, `--config <file>`,
`--storage <dir>`, `--tolerance <pct>`, `--quality`, `--fail-on <impact>`, `--new-only`, `--wcag-only`,
`--max-document-overflow <px>`, `--max-element-overflow <px>`, `--approve`, `--note <text>`, `--out`,
`--from`, `--activate`, `--all`, `--json`, `--quiet`. `pnpm uiproof --help` is the full text;
`pnpm build:cli` refreshes the bundle without running a command.

```bash
pnpm uiproof projects --config examples/ci/uiproof.config.json
pnpm uiproof capture --project example-app --route home --approve --note "first approval"
pnpm uiproof check --project example-app --route home
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | the comparison passed — or a capture was stored, because a capture is never a pass |
| `1` | a visual regression was detected — or the quality policy failed (`audit`) |
| `2` | configuration, baseline, browser or infrastructure error: the tool could not answer |

These are the interface. `2` is deliberately distinct from `1`: an unusable registration file, a
missing baseline, an unknown project or route, a route that redirects off its origin, an application
that is not listening, a Chromium that is not installed, or a bundle that fails its integrity check
must never look like "your UI changed". A capture prints "a capture is not a pass" and exits `0`
without claiming a verdict, and a failing `check` prints its measurement:

```text
REGRESSION  0.9712% of the viewport changed (9,945 of 1,024,000 px), above the 0.1% tolerance
Reference: bl-f29097f0-e19f-4d31-9f7f-f546f7f91ad7 · approve with: uiproof capture --approve
```

### Machine-readable output

`--json` prints **exactly one JSON document on stdout** and moves the human trail to stderr, so
`uiproof check --json | jq .status` works. Use `pnpm --silent uiproof …` when you redirect stdout,
otherwise pnpm's own banner lands in the file.

```json
{
  "command": "check",
  "status": "regression",
  "exitCode": 1,
  "source": { "projectId": "example-app", "routeId": "home", "viewportId": "desktop" },
  "tolerance": 0.1,
  "baseline": { "versionId": "bl-…", "approvedAt": "…", "sourceReportId": "run-…" },
  "report": { "id": "run-…", "metrics": { "changedPixels": 9945, "comparedPixels": 1024000, "changePercentage": 0.9712 } },
  "reportPath": "/…/.uiproof/data/reports/run-…",
  "diff": { "url": "/api/artifacts/run-…/diff.png" }
}
```

The `report` object *is* the persisted report: it is written to `<store>/reports/<run id>/report.json`
before the CLI prints it, and the CLI suite asserts the two are equal rather than trusting the
transcript.

### The quality gate

`uiproof audit` measures accessibility and responsive layout and judges both against a written
policy — every threshold of it is a flag, never an opinion baked into the tool:

| Flag | Meaning |
| ---- | ------- |
| `--fail-on minor\|moderate\|serious\|critical\|none` | Lowest impact that fails the policy (default `serious`; `none` reports everything and fails nothing) |
| `--new-only` | Fail only on findings absent from the approved baseline's accessibility snapshot |
| `--wcag-only` | Best-practice rules are reported but never counted against the policy |
| `--max-document-overflow <px>` | Horizontal document scroll allowed (default `1`) |
| `--max-element-overflow <px>` | Viewport escape allowed per element (default `1`) |

`audit` measures every viewport preset (desktop, tablet, mobile) unless `--viewport` narrows it, and
**never touches the approved baseline**: a failing policy exits `1` and leaves every approved
screenshot exactly as it was. `capture --quality` and `check --quality` attach the same measurements
to a run's report instead of gating on them.

What an audit stores is the evidence behind each measurement, never a score:
`<store>/audits/<audit id>/audit.json` plus one screenshot per audited viewport. Every finding
carries the rule and its WCAG tags, the element's selector and markup and the runner's remediation
text. Results the runner could not decide (an icon's contrast, say) are `needs-review` questions for a
human — reported beside the verdict, never counted as failures. Findings are identified by
`rule@selector`, so `--new-only` can name exactly which findings are newly introduced, which are
known and which a change resolved.

A passing audit is not a certification. It is what this rule set found, on this page, in this
browser, at this moment — and the report says exactly that.

**A reporting limit can hide a finding from a reader, never from the verdict.** The readable
finding list is capped at 60 entries, but the decision is made on the complete violation index
(`accessibility.violations`) that every scan carries, so a serious violation that sorts past the
cap still fails the check. When the list is capped the report says so — `truncated: true`, the total
count above it, a note next to the verdict and `(showing 60 of 68 findings; the verdict evaluated
all 68)` in the CLI output.

**An approval is scoped to the viewport it was made at.** `--new-only` compares each audited
viewport against the snapshot approved for *that* viewport: a desktop approval does not authorise
the same fingerprint on mobile, where axe can legitimately report differently. A viewport with no
approved snapshot has no approved findings — everything measured there counts as new, and the
verdict says `No approved accessibility snapshot exists for <viewport>` rather than borrowing
another viewport's approval. The same rule makes a bundle honest: an approval without a snapshot
never becomes one.

### Portable approved baselines

The store is runtime state — git-ignored, container-ephemeral, absent on a fresh CI runner. A
**bundle** is the same approvals in a form you can commit next to the code:

```
examples/uiproof-baselines/
├── uiproof-baselines.json                                     format, scopes, versions, SHA-256
└── scopes/projects/example-app/home/desktop/versions/
    └── bl-18d99168-047b-4730-9fee-9a28f0f80639.png            one immutable approved image
```

`baselines export` writes it and `baselines import --from <dir>` loads it. The rules an import
enforces, each of them unit tested against hand-edited manifests:

- **Nothing in a bundle is trusted.** Every path is re-derived from the validated scope, and a path
  that is not the canonical one — or that would leave the bundle — is refused, so an imported bundle
  cannot write outside the store.
- **Every image is verified.** Byte count, dimensions and SHA-256 are checked before anything is
  written. A truncated, swapped or edited PNG is `baseline_integrity_failed` (exit `2`) and the store
  is left exactly as it was.
- **Approval stays explicit.** An import stores versions; it changes which one is *active* only when
  `--activate` asks for it. A version that exists but was never activated cannot be compared against.
- **Versions stay immutable.** A version id that already exists with different content is a conflict,
  never an overwrite. Importing the same bundle twice is a no-op; adding `--activate` to the second
  import activates the version that is already on the machine.
- **Reports stay out of bundles.** A bundle carries approvals, never results: the report of the run
  that produced an image stays in the store.
- **Accessibility snapshots travel with them.** When the approved run measured the page, the bundle
  carries the snapshot — scanner version, approval time, the violation fingerprints and their count
  — and an import restores it, so a clean checkout classifies `--new-only` exactly as the machine
  that approved did. The snapshot is validated strictly on the way in (unknown fields, unsorted or
  duplicated fingerprints and a count that disagrees with the list are all refused), a version with
  no snapshot imports with no reference rather than an empty one, and bundles written before this
  existed keep working unchanged.

### Gating a CI pipeline

[.github/workflows/visual-regression.yml](.github/workflows/visual-regression.yml) is a working gate
for a clean Ubuntu runner: `pull_request` and `push` to `main`, `contents: read`, no secrets, no
hosted service. It starts the application under test, loads the approved baseline, and runs one
comparison whose exit code *is* the job's verdict. Four things make it a gate rather than a
demonstration:

- **The reference comes from a commit the pull request cannot write to.** The bundle is extracted
  from the pull request's base branch with `git archive`, so editing
  [examples/uiproof-baselines](examples/uiproof-baselines) in the same pull request cannot authorise
  that pull request's change. The working-tree copy is compared, reported, and then ignored.
- **Nothing captures and nothing approves.** There is no `capture` and no `--approve` in the gate —
  a unit test asserts exactly that, because the defect this workflow used to have was approving the
  page it was about to test, which cannot fail.
- **A regression fails the job.** Exit `1` (a real visual difference) and exit `2` (missing baseline,
  tampered image, unreachable application, browser or configuration problem) both fail it, and the
  screenshots, the diff and the run's JSON are uploaded either way so a regression is reviewable.
- **The environment is pinned.** The whole job runs in
  `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a…`, because a baseline only matches a
  screenshot taken by the same Chromium with the same fonts.

Verified on GitHub Actions (links in [docs/BASELINE-UPDATES.md](docs/BASELINE-UPDATES.md#verified)):
`main` passes with `exit 0` and `changed: 0%` against the committed reference; a pull request with
three real edits to the example application's own view fails the gate with `exit 1` and **0.4404 %**
of the viewport changed, artifacts included; the *same* pull request shipping a bundle that matches
its own UI — an approval verified pixel-exact (`PASS 0% of the viewport changed`) when loaded against
that UI — still fails, because the reference comes from the base branch; and reverting the UI passes
again while the pull request keeps its own bundle.

[.github/workflows/visual-regression-demo.yml](.github/workflows/visual-regression-demo.yml) is the
Phase 4 walkthrough, kept as an integration test and clearly separated from the gate: it asserts each
documented exit code — `0` unchanged, `1` changed, `0` restored, `2` missing baseline, `2` tampered
image, `2` unreachable application — which is precisely what a gate must never do. It runs on `main`
and by hand, in the same pinned image, and its last step fails if it left the checkout dirty.

[.github/workflows/quality-gate.yml](.github/workflows/quality-gate.yml) is the accessibility and
layout gate, and it is built the same way: `pull_request` and `push` to `main`, `contents: read`, no
secrets, the same pinned image. `scripts/ci/audit-gate.sh` audits the registered `/support` route at
every viewport with the documented policy (`--fail-on serious`, best-practice rules counted, the
CLI's own overflow limits) and maps the audit's exit code onto the job — `0` passes, `1` (a policy
failure) fails, `2` (axe-core could not be injected, Chromium failed, the store failed) fails as
infrastructure. It never approves anything, and it refuses `--new-only` unless a trusted bundle
actually imported an accessibility reference in that run, so the flag can never appear to compare
against a reference that does not exist.

The checker is not the pull request's code. `scripts/ci/trusted-checker.sh` extracts `src/`,
`scripts/` and the registration file from the base branch with `git archive` and the gate runs from
that copy (`UIPROOF_CLI_DIR`), so the policy engine, the scanner wrapper and the gate script itself
are the protected revision's. The application under test is still the pull request's working tree —
that is what is being reviewed — started with a scrubbed environment, and the installed
dependencies are still the revision under test's, which is written down rather than implied.
[docs/BRANCH-PROTECTION.md](docs/BRANCH-PROTECTION.md) records the branch-protection and CODEOWNERS
settings that make both gates block, and exactly what remains outside the trust boundary.

Verified on GitHub Actions: on `main` the quality gate passes against the committed reference line
(run 39005281985) and the quality walkthrough reproduces **38/38** documented answers — clean pass,
introduced violation, introduced mobile overflow, desktop approval not authorising mobile, the
exported/imported reference, the 68-finding page whose serious violation sorts past the display cap,
the CSP page that refuses the scanner (exit `2`), and the restore (run 39005281955).
[Pull request #2](https://github.com/Azmk1/uiproof/pull/2) shows the failing direction: a real defect
in the application's own support view fails `gate · accessibility and layout` (run 39005319352) with
`accessibility.critical` ×3, `accessibility.serious` ×1 and `responsive.document-overflow` — 346px at
mobile — plus the audit report and one screenshot per viewport as the uploaded evidence, while the
visual gate stays green because it compares the untouched `/` route; restoring the page passes again
(run 39005580428).

Updating the baseline is its own reviewed procedure: dispatch
[the update workflow](.github/workflows/baseline-update.yml), review the artifact and its provenance,
commit the bundle. It cannot be reached from a pull request and it never commits anything itself.
[docs/BASELINE-UPDATES.md](docs/BASELINE-UPDATES.md) documents all of it, including the
branch-protection settings that turn the gate from a signal into a block, and what is not pinned.

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

### The environment a baseline comes from

Pinning the capture is not enough. A screenshot also depends on the browser build and the fonts, so
the gate, the walkthrough and the baseline generator all run in **one container image**, pinned by
tag and digest (`mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a…`; Playwright 1.64.1,
Chromium build 1248, and whatever fontconfig is inside it — `system-ui` resolves to *WenQuanYi Zen
Hei* there, which is why a Windows-rendered baseline could never match a Linux runner). The
generator records all of that in its provenance, and the same image is what the gate runs in.

Measured, not asserted: **three separate generator runs** in that image — one of them from a CRLF
checkout — produced byte-identical screenshots (`sha256:28399ef6…c530e1`, 70,020 bytes, 1280 × 800).
What that does *not* cover is worth writing down too: another architecture, another image digest, or
a page with live data still moves pixels, so a changed digest means "regenerate the baseline", not
"the baseline is wrong". `pnpm test` fails if the pins drift apart
([src/lib/ci/pinned-environment.test.ts](src/lib/ci/pinned-environment.test.ts)).

---

## Configuration

| Variable            | Default                  | Purpose                                                      |
| ------------------- | ------------------------ | ------------------------------------------------------------ |
| `UIPROOF_DATA_DIR`  | `<project>/.uiproof/data`| Where reports and screenshots are stored                     |
| `UIPROOF_BASE_URL`  | the incoming request's origin | Origin used to reach the fixtures while capturing        |
| `UIPROOF_PROJECTS_FILE` | `<project>/uiproof.config.json` | The project registration file                       |
| `UIPROOF_ALLOW_REMOTE_BASELINES` | unset | `1` relaxes the loopback check on approvals — only behind your own access control |

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
| `pnpm example:app`   | Serve the bundled example application on port 4173   |
| `pnpm uiproof …`     | The UIProof CLI (see [The command line](#the-command-line)) |
| `pnpm build:cli`     | Rebuild the CLI bundle without running a command      |

`pnpm test:e2e` needs `pnpm build` to have run first: it starts `next start` on a scratch port with a
throwaway `UIPROOF_DATA_DIR`, so it never touches your own runs and baselines. `pnpm verify` chains
everything in that order; the same sequence runs in CI on every push and pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)) — install with `--frozen-lockfile`, lint,
typecheck, unit tests, production build, Chromium install, browser suite.

---

## Testing

`pnpm test` runs **238 unit tests** across 19 files, all covering the engine, the guards, the baseline
store, the portable bundles, the quality measurements, the CLI's parser and the pinned CI environment
rather than the UI shell:

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
| `lib/http/loopback-binding.test.ts` | Pins the loopback bind in `dev`/`start`, that `0.0.0.0` is no longer treated as loopback, and that no script turns the remote-write escape hatch on |
| `lib/projects/registry.test.ts` | Registration parsing: loopback-only origins, path rules (traversal, encoded traversal, query, fragment, backslash), duplicate ids and paths, size limits, `allowedOrigins` validation, capture-URL rebuilding |
| `lib/compare/source-selection.test.ts` | The console's source model: scope keys, request shapes, baseline endpoint paths, per-source defaults |
| `lib/compare/file-lock.test.ts` | The cross-process lock: serialised critical sections, no stealing from a live owner, abandoned-lock takeover, timeout |
| `lib/format-time.test.ts`       | Relative time, UTC clock, duration formatting                                                          |
| `cli/args.test.ts`              | The CLI's argument parser: commands and subcommands, value and boolean flags, `--tolerance` bounds, unknown options, `--help` winning over a missing option, and the documented exit codes in the help text |
| `lib/ci/pinned-environment.test.ts` | The CI configuration itself: the Playwright pin is exact and matches the image tag, the image is pinned by tag *and* digest, every workflow runs in that same image, the recorded Chromium revision matches the installed Playwright, the gate workflow contains no `capture` and no `--approve` and reads a base-branch ref, and no workflow-level `env` reaches for a context GitHub does not allow there |
| `cli/portable.test.ts`          | Portable bundles, treated as hostile input: canonical paths and traversal refusal, hand-edited manifests (wrong format, unknown scope, unknown viewport, non-canonical file, malformed hash, duplicate id, an active version that is not listed), import into a store that does not exist yet, idempotent re-import, activation only on request, a tampered image writing nothing, a version-id conflict keeping the approved bytes, export refusing to rewrite a bundled image |
| `lib/quality/fingerprint.test.ts` | The stable identity behind "new findings": `rule@selector`, identical across rescans and insensitive to whitespace reflow, with distinct rules or elements never collapsing into one; violation sets deduplicate and sort, and the diff of two snapshots separates added, known and resolved regardless of order. Also the snapshot parser behind every imported approval: accepted unchanged, refused when it carries unknown fields, a blank scanner version, an unparseable approval time, a non-array or unsorted or duplicated fingerprint list, a fingerprint that is not `<rule>@<selector>`, or a count that disagrees with the list — and the complete-index reader falls back to the display list only for reports written before the index existed |
| `lib/quality/policy.test.ts`    | The policy's arithmetic: each `--fail-on` band fails on exactly its impact and above (an unstated impact fails rather than being presumed harmless), `none` reports everything and fails nothing, best-practice rules leave the verdict when excluded, `--new-only` counts only findings absent from the reference and falls back to counting everything with a note when there is no trustworthy one, document overflow fails above its pixel limit, and the description names every threshold. Phase 5.1 additions: the verdict reads the complete violation index rather than the capped display list (a serious finding only present in the index still fails, and the truncation is noted), responsive defects are read the same way, a desktop approval counts a fingerprint as new when the mobile reference lacks it, and new/known/resolved are classified per viewport under partial baseline coverage |
| `lib/quality/presentation.test.ts` | The dashboard's view of an audit, kept pure: violations grouped by impact with empty bands omitted and unstated impact last, one finding seen at several viewports deduplicated with the viewports recorded, needs-review results kept apart from violations whatever their impact says, and both panel models carrying measurements, evidence and engine facts through unchanged |

`diff.test.ts` is the important one: it builds synthetic PNGs in memory and asserts **exact** pixel
counts (e.g. a 10 × 10 block changed on a 100 × 100 white canvas is exactly 100 pixels and 1 %).
`baselines.test.ts` is the second: it writes real files into a temporary data directory and checks the
lifecycle semantics — nothing overwritten, nothing adopted across target/viewport, and a restore that
keeps the original approval timestamp. `cli/portable.test.ts` is the third: it builds bundles with the
real export path, then edits the manifest by hand the way a truncated download or a tampered commit
would look, and asserts that every one of them is refused.

### Browser suite

`pnpm test:e2e` runs **62 tests** across 8 files in real Chromium, against a real `next start` server
on a throwaway data directory ([e2e/](e2e)):

| File | Coverage |
| ---- | -------- |
| `dashboard-smoke.test.ts` | Console renders with no console errors · the mode invariant (baseline mode is gated on an approved baseline actually existing) · a fixture run produces a measured verdict whose stored report agrees with the panel, with three real PNGs served · the reverted page state reports 0 px, not a false positive · the report survives a reload · the quality audit panel runs from the UI, groups findings by impact, reports layout per viewport and links each measurement to its screenshot (restored after a reload) · the capture guard still closes |
| `accessibility.test.ts` | The Phase 1 audit regressions, pinned as measurements rather than claims: flex prose in reading order, every control ≥ 24 px, the slider hairline inside a 24 px hit area, zoom buttons at full size, WCAG AA contrast in both colour schemes, no overflow at 390 px, a focus ring on every keyboard stop, and the timeline reachable by keyboard with a ring on the focused bar |
| `baseline-lifecycle.test.ts` | The seven-step lifecycle below, driven through the UI wherever the UI has an action for it |
| `project-integration.test.ts` | The Phase 3 workflow against an independent application: start it, register it, capture a route, approve it, change the application's real UI, detect the regression, restore it, pass again, restart UIProof and find everything still there — plus the refusals |
| `cli.test.ts` | The Phase 4 workflow through the real CLI process (`node scripts/uiproof.mjs …`, exit codes read from the process): help and version, usage errors, `projects`, a missing baseline, `capture --approve` reporting *captured* and never a pass, a passing `check` whose JSON equals the persisted report, a real UI change exiting `1` and recovering to `0`, unknown project/route/viewport, an off-origin redirect, an unreachable application, export/import on a fresh working directory, activation only on request, a tampered bundle, and `baselines status` naming the approved run |
| `quality.test.ts` | The quality gate's seven demonstration points through the real CLI: a clean page passing at every viewport with the deliberate scroller recorded as evidence, a missing and an incorrect accessible name detected with structured evidence, a contrast failure reported with its measured ratio while an undecidable one stays a question, mobile-only overflow detected, restore naming what it resolved, screenshot baselines untouched by failing audits, and the documented exit code for each policy |
| `quality-hardening.test.ts` | The three ways a quality gate can silently pass, each measured on the live page: 68 findings against a 60-finding display cap where the only serious violation sorts *past* the cap (the truncated list contains nothing severe, the verdict fails on it anyway and the note says all 68 were evaluated); a desktop-only approval that leaves the same fingerprints new at mobile and tablet while the desktop-only `--new-only` audit passes; those snapshots surviving export → wiped store → import with an identical classification; and a CSP page that blocks axe-core's injection answering exit `2` with `quality_unavailable` and nothing persisted |
| `quality-api.test.ts` | The audit HTTP API against a registered application: a clean audit with working evidence links (per-viewport PNGs and `audit.json`), a real code change producing findings by impact and layout defects only at the narrow viewport, the history listing newest first with summaries that match their reports, and the refusals — cross-site requests, unknown projects, bad policy and viewport input, path traversal on the evidence route |

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
also order-independent — the files may run in any order, because the smoke suite asserts the
*invariant* ("baseline mode is enabled exactly when a baseline is stored") rather than assuming a
clean store. Verified with `--sequence.shuffle.files --sequence.seed=7`.

### The Phase 3 walkthrough, on somebody else's application

`project-integration.test.ts` is the one that matters for this phase. It copies
[examples/example-app](examples/example-app) to a temporary directory, starts it on its own port,
writes a registration file for it, starts a **second** UIProof server against that file, and then,
through the browser:

| Step | What is asserted |
| ---- | ---------------- |
| Start the app | `/healthz` answers, and the shipped screen serves `$48,200` |
| Register it | `GET /api/catalog` carries the project, its origin and all four routes; the picker shows them under the project's name with its origin |
| Capture | `POST /api/compare` returns `status: "captured"` — **no percentage**, no `diff.png` on disk, and a real decodable 1280 × 800 PNG |
| Approve | Through the console's two-step confirmation; the stored version names the capture run, the route `/` and 1280 × 800 |
| Unchanged | Baseline mode reports **pass, 0 of 1,024,000 px**, naming the approved version |
| Network guard | A route that loads an image from another origin still captures, with `source.blockedRequests ≥ 1` |
| Real UI change | The application's own view file is replaced with the changed screen; the run reports a **regression**, and the decoded diff image contains **exactly** `metrics.changedPixels` difference pixels |
| No self-approval | The baseline manifest still holds one version, still active |
| Restore | The original view goes back; the run reports **pass, 0 px** from the same version |
| Restart | UIProof is stopped and started again on the same data directory: the baseline and every run id are still there, and a fresh run still passes |
| Refusals | Unregistered project, unregistered/traversal route, absolute URL, off-origin redirect (`502`, nothing stored), unsafe path in the config file, unreachable dev server, cross-site approval |

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
- **Registered application (Phase 3):** against [examples/example-app](examples/example-app) on its
own port, in one production session — capture-only **310 ms** (942 ms end to end, 48,302-byte PNG)
  → approval `bl-d8fe56c5-…` at `/`, 1280 × 800, byte-identical size to the capture → unchanged
  baseline run **pass, 0 / 1,024,000 px, 363 ms** → the application's view file swapped for
  `home.changed.html` → **regression, 9,945 / 1,024,000 px = 0.9712 %**, capture 189 ms, compare
  212 ms, diff image 67,500 bytes with **exactly 9,945** difference-coloured pixels (the suite
  asserts that equality by decoding the PNG) → original view restored → **pass, 0 px, 391 ms**. The
  baseline manifest still held **one** version, active, after all of it, and after UIProof was
  restarted on the same data directory both the baseline and all five runs were still there.
- **Capture network restriction:** the `/embedded` route of the example app pulls an image from
  `https://cdn.example.com`. The capture succeeded and the report recorded `blockedRequests: 1` — the
  request never left the machine, and the page still rendered.
- **Refusals (Phase 3):** unregistered project → `400`; unknown or traversal route → `400`; absolute
  URL target → `400`; a registered route that 302s to `https://example.com` → `502
  capture_redirected` with nothing stored; a config file with `"/../../etc/passwd"` as a route path →
  the whole file reported unusable and a capture answered `500 project_config_invalid`; a dev server
  that is not listening → `502 project_unreachable` naming the origin and port; cross-site approval →
  `403`.
- **CLI (Phase 4), one session against [examples/example-app](examples/example-app):** with a store
  that did not exist yet — `baselines import --from examples/uiproof-baselines --activate` added 1
  version, verified against its SHA-256, byte count and dimensions → `capture --approve` → `check`
  **exit 0, 0 / 1,024,000 px** → `views/home.changed.html` copied over `views/home.html` → **exit 1,
  0.9712 % (9,945 px), `REGRESSION`** → view restored → **exit 0** again. The JSON of the failing run
  was `status=regression changed=0.97119140625% (tolerance 0.1%)`, and the same object is what
  `<store>/reports/<run id>/report.json` holds. Exporting afterwards wrote both versions (the imported
  one and the runner-approved one) into a 94.3 KB bundle.
- **Exit codes (Phase 4), each produced by the real process:** pass → `0`; capture → `0` with status
  `captured`; regression → `1`; missing baseline → `2 baseline_not_found`; unknown project → `2
  project_not_registered`; unknown route → `2 route_not_registered`; unknown viewport → `2` usage
  error; `--tolerance 500` → `2`; a route that redirects off its origin → `2 capture_redirected`; an
  application that is not listening → `2 project_unreachable`; a bundle whose PNG was byte-flipped →
  `2 baseline_integrity_failed`, with the store left untouched.
- **Two bugs the CLI suite found, both fixed rather than papered over.** Every CLI invocation used to
  keep its Chromium alive until the engine's 60 s idle timer fired, so a command that did its work in
  1.1 s took 62 s to exit — the shared browser is right for a server and wrong for a one-shot process,
  which now closes it on the way out (13 tests went from 507 s to 30 s). And `baselines import
  --activate` silently ignored activation when the version was already on the machine, so the
  documented clean-runner commands left the store with a baseline that was never active; an import
  that finds identical bytes now honours `--activate` and activates that version, with a unit test
  pinning it.
- **The example CI workflow (Phase 4), rehearsed step by step on this machine against the same commands
  the workflow runs:** health wait → import from the committed bundle → `capture --approve` on the
  runner → gate passes (`0`) → deliberate regression (`1`, JSON asserted) → revert → gate passes (`0`)
  → export, with the example application left byte-identical to git afterwards. *(Phase 4.5 removed the
  `capture --approve` from the gate; the walkthrough that still does it and checks the codes is a
  separate workflow.)*
- **The gate (Phase 4.5), in the pinned image and on GitHub:** `main` → `exit 0`, `changed: 0%`,
  reference `bl-c6198d4d…`, `working tree copy: identical to the trusted bundle`. A pull request with
  three real edits to the example application's view → `exit 1`, `REGRESSION 0.4404% of the viewport
  changed (4,510 of 1,024,000 px)`, artifacts uploaded anyway. The same pull request bringing a bundle
  that *matches* its own UI — loaded against that UI in the same image it reports `PASS 0% of the
  viewport changed (0 of 1,024,000 px)`, so the approval was legitimate and pixel-exact — still exits
  `1`: the log warns `the working tree copy … DIFFERS from the trusted bundle` and compares against the
  base commit. Reverting the UI passes (`exit 0`) while the pull request keeps its bundle.
- **The update path (Phase 4.5):** the `Approved baseline update` workflow, dispatched on `main`,
  regenerated the bundle on a `ubuntu-latest` runner and produced a PNG with the **same** SHA-256 as
  the committed one (`28399ef6…c530e1`, 70,020 bytes) — four independent generations, two machines, one
  image — while committing nothing.
- **The walkthrough (Phase 4.5), on `main` in the pinned image:** 17/17 assertions across seven
  scenarios — `0` unchanged, `1` changed, `1` even with a rewritten bundle in the tree, `0` restored,
  `2` missing baseline, `2` tampered image (naming both hashes), `2` unreachable application — and the
  checkout clean afterwards.
- **Stability:** five repeat runs at one revision → identical changed-pixel counts; the control
  target → 0 changed pixels, verdict `pass`, three times.

---

## Known limitations

- **Local only.** Artifacts live on the local filesystem; a read-only or ephemeral filesystem (most
  serverless hosts) will break persistence. `storage.ts` is the single seam to swap in object storage.
- **No identity, and the `Host` header is not one.** The write endpoints refuse non-loopback `Host`
  values and foreign origins, but the control that actually excludes other machines is the loopback
  bind. Everyone who can reach the port has full write access. See *How local-only actually works*.
- **Cross-process safety is filesystem-local.** The baseline lock (`.manifest.lock`) assumes one
  machine and a local filesystem. On a network share, or across hosts, the optimistic re-read is all
  that is left — enough to avoid an overwrite, not enough to be a distributed lock.
- **Loopback origins only.** A registration cannot point at a public site or a LAN hostname, so
  staging environments on another machine are out of scope for this phase (and deliberately so: the
  brief was explicit that public URL scanning is not part of it).
- **`allowedOrigins` widens the capture's network surface.** It is opt-in per project and never a
  wildcard, but a page that needs a CDN or a second local port will fetch it during a capture.
- **The page itself must stay on its registered origin.** A legitimate cross-origin redirect (an auth
  hop, for example) is refused; register the destination as its own route instead of allowing it
  through the capture.
- **A baseline is approved by hand.** There is no "approve automatically on `main`", no scheduled
  refresh and no threshold that promotes a run: a regression never approves itself, by design.
- **Viewport captures only.** Screenshots are viewport-sized, so differences below the fold are not
  compared. If two captures do differ in height, the smaller one is padded on white and the report
  flags `dimensionsChanged` — that is a fallback, not full-page comparison.
- **Whole-viewport tolerance.** The tolerance is a single percentage for the whole image; there are
  no per-region masks or ignore selectors yet.
- **A quality audit is a scan, not a certification.** It reports what one rule set found on one page,
  in one browser, at one moment, with the runner's version in the report. `needs-review` results are
  exactly what the runner could not decide — they need a human and are never counted as failures.
- **"New findings" need an approved reference.** Without an approved baseline's accessibility
  snapshot the audit cannot say which findings are new; the report says so rather than guessing. An
  approval is per viewport, so a desktop-only approval leaves the tablet and mobile findings
  unapproved — the verdict names those viewports rather than borrowing the desktop reference.
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
- **The CLI runs from this repository.** It is not published to npm yet (the package is `private`), so
  a consumer needs the checkout: `pnpm uiproof` bundles `src/cli` with esbuild into the git-ignored
  `.uiproof/cli/uiproof.mjs` and runs it. Shipping a package is a later decision, not a Phase 4 one.
- **A baseline is only pixel-exact for the environment that rendered it.** Fonts, rasteriser and
  Chromium build differ across machines, which is why the gate, the walkthrough and the generator all
  run in one pinned image: the committed bundle is reproducible there (four runs, one image hash) and
  nowhere else by assumption. A different digest or architecture means regenerating the baseline.
- **The gates block only if the repository says so.** Requiring the `gate · trusted baseline` and
  `gate · accessibility and layout` checks, requiring code-owner review, keeping branches up to date
  and restricting pushes to the base branch are manual GitHub settings — a workflow cannot protect
  itself. Without them both gates are signals. [docs/BRANCH-PROTECTION.md](docs/BRANCH-PROTECTION.md)
  lists exactly what to configure and what each setting buys.
- **The quality gate trusts the checker, not the dependencies.** The implementation that judges a
  pull request (`src/`, `scripts/ci/`, the registration file) is extracted from the base branch, but
  the extracted copy borrows the workspace's `node_modules`, installed from the pull request's
  lockfile. A dependency change is therefore still inside the trust boundary; CODEOWNERS routes
  `package.json` and `pnpm-lock.yaml` to review, and a fully hermetic answer — installing the base
  revision's lockfile separately — is the next step, not a claim this phase makes.
- **The quality gate audits one route at every preset.** It audits the registered support route at
  desktop, tablet and mobile in one invocation because `audit` measures every preset by default;
  gating several pages is a loop over `scripts/ci/audit-gate.sh` in your own workflow.
- **One route, one viewport per gate invocation.** Gating several routes is a loop over
  `scripts/ci/run-gate.sh` in your own workflow.
- **The CLI captures registered routes only.** `--project` and `--route` must exist in the registration
  file; there is no "compare this URL" mode. That is the same capture surface as the console, on
  purpose.
- **One route and one viewport per invocation.** There is no watch mode, no multi-route run and no
  queue: gating several routes is a loop in your own pipeline until a later phase adds it.
- **No visual diffing of the console itself.** Nothing screenshots the dashboard UI, so a styling
  regression in the console would not be caught by the tool that is meant to catch styling
  regressions.

---

## Next milestone

Phase 5 delivered the accessibility and responsive quality gate — `uiproof audit`, the console's
quality panel and the audit API — which was item 6 of this list, brought forward. What remains of the
list is next:

**Phase 6 — make the gate sharper, and cheaper to run everywhere.**

1. **Ignore regions.** Selector- or rectangle-based masks, recorded in the report, so a volatile
   area can be excluded visibly instead of by lowering the global tolerance.
2. **Tie runs to code.** A run against a real project's page is worth much more if the report carries
   the git SHA (and dirty state) it was captured at, so a regression names the change that caused it —
   and a gate can say which commit moved the pixels.
3. **One command for a whole project.** `uiproof check --all` across every registered route and
   viewport, with a single rolled-up exit code and per-route results, instead of a shell loop.
4. **Publish the CLI.** Ship `uiproof` as a package with a pinned Chromium dependency so a consumer
   does not need this repository at all, and keep the store format unchanged.
5. **Multi-viewport approvals.** One approval covering desktop/tablet/mobile, with per-viewport pass
   or fail in a single report.
6. **Then GitHub integration and AI repair proposals** — after all of the above, not before.

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
