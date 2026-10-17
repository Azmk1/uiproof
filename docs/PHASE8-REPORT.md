# Phase 8 — final report

**Autonomous repair engine and verification.**

Implementation commit: **`5a10e9d`** — `feat: propose, isolate and verify repairs without touching the source tree`
(branch `main`, based on `44ac26b`). This report documents what was built, what was measured, and
what remains unproven.

---

## 1 · What was delivered

| Piece | Where | What it does |
| ----- | ----- | ------------ |
| Repair engine | [src/lib/repair/](../src/lib/repair) | Pins a revision, copies the registered source into isolation, measures the unmodified page, asks for a patch, scope-checks and applies it to the copy, re-measures, runs build + tests, classifies the result, stores every attempt |
| CLI | `uiproof repair` in [src/cli/main.ts](../src/cli/main.ts) | `--report <run id>` or `--audit <audit id>`, `--max-attempts 1\|2`, `--out <file>`, `--json`; exit `0` verified, `1` not verified, `2` could not run |
| HTTP API | [src/app/api/repairs](../src/app/api/repairs) | `GET /api/repairs`, `POST /api/repairs`, `GET /api/repairs/:id`, `GET /api/repairs/:id/patch`, `GET /api/repairs/:id/artifacts/:name` |
| Dashboard | [repair-panel.tsx](../src/components/console/repair-panel.tsx) | An `aria-label="AI repair"` panel separate from the comparison and audit verdicts: measured issue, diff, before/after screenshots, every verification line, rejected attempts, patch download |
| Fixture | [examples/repair-app](../examples/repair-app) | Four deliberate defects, a structural build check, a real test command and a registration file |
| Tests | `src/lib/repair/*.test.ts`, [e2e/repair.test.ts](../e2e/repair.test.ts), [e2e/repair-dashboard.test.ts](../e2e/repair-dashboard.test.ts) | 40 unit tests, 6 browser tests (5 engine scenarios + the panel) |

Nothing in this phase changes a comparison status, an accessibility verdict or an approved baseline.
The panel's own status is the only place a repair verdict appears.

---

## 2 · Verification, with counts

Run on 2026-10-17 from a clean working tree at the implementation commit:

| Check | Command | Result |
| ----- | ------- | ------ |
| Lint | `pnpm lint` | clean |
| Types | `pnpm typecheck` | clean |
| Unit tests | `pnpm test` | **382 passed, 1 skipped (383) across 31 files**; repair area 40 / 5 files |
| Production build | `pnpm build` | succeeded (all `/api/repairs` routes dynamic) |
| Browser tests | `pnpm test:e2e` | **77 passed / 77 across 11 files**; repair area 6 tests |
| Phase 1–7 preservation | same suites | every earlier test still passes unchanged |

The single skip is a file-symlink test that Windows without Developer Mode cannot set up; the
directory-junction escape test runs and passes. No test was skipped or weakened for this phase.

---

## 3 · Repair evidence

The fixture application has four independent defects. Each scenario runs the **real** pipeline —
Chromium capture, axe-core, the responsive probe, real PNG diffing, the real build and test
commands, the real sandbox — against a deterministic OpenAI-compatible **stub model**, because no
provider credentials exist in this environment. Every measurement below is real; the model is not.

| Scenario | Before the patch | After the patch | Verdict |
| -------- | ---------------- | --------------- | ------- |
| Missing accessible name (`a11y:label@#email`) | support@mobile: 2 violations, 1 critical, fingerprint `label@#email`; guard `manual@desktop`: 0 | 1 violation, **0 critical**, `color-contrast@.note` remains; guard unchanged 0 | **verified** on attempt 2. Attempt 1 (a comment only) was **rejected**: "did not improve: the same rule still fires on the same element" |
| Insufficient contrast (`a11y:color-contrast@.note`) | support@mobile: 2 violations, 1 serious; fingerprints `color-contrast@.note` + `label@#email` | 1 violation, **0 serious**; `label@#email` still present; **no regression reported** | **verified** |
| Mobile horizontal overflow (`responsive:mobile`) | document overflow **354 px**, 1 element escaping (`div#maintenance-banner` +354 px) | document overflow **0 px**, **0** escaping elements | **verified** |
| Visual regression (`visual:desktop`) | **4,049 changed pixels = 0.3954 %** vs the approved baseline, status `regressed` | **0 changed pixels**, status `match` | **verified**; the baseline manifest and PNG are byte-identical afterwards |
| Deliberately bad patch | Fixes `label@#email` **and** makes the `<h1>` low-contrast | target `fixed`, but **1 new serious/critical finding** (`color-contrast@h1` at support@mobile) | **rejected** with that reason; patch kept as evidence |

Every scenario asserts the fixture's `views/index.html` is byte-identical after the run. The
dashboard test additionally reads `originalUnchanged: true` from the repair API, downloads the
patch and confirms its bytes contain the fix, and asserts the quality audit panel still says
`fail`.

The two failed attempts are as important as the successes: they show the engine rejecting a
no-op change and a regression-causing change with the measured reason, rather than trusting the
model's own claim.

---

## 4 · Bounds and cost

| Limit | Value |
| ----- | ----- |
| Attempts per run | 2 maximum (CLI defaults to 2; the engine refuses anything outside 1–2) |
| Patch size | 4 files, 200 changed lines, 48,000 characters, 20 hunks per file |
| Prompt | 4 files × 12,000 characters; token cap from `UIPROOF_AI_MAX_TOKENS` |
| Commands | 120 s each; 10 min wall-clock run budget; no shell |
| Sandbox copy | File-count and byte caps; refuses a tree that changes during the copy |
| Model requests | One per attempt; no retry loop beyond `maxAttempts` |

**Cost was not measured in currency.** No live provider was contacted, so there is no
token bill to report. The bounds above are what a live run would be constrained by.

---

## 5 · Security assumptions

- **The sandbox is a copy, not a container.** Isolated code runs with the developer's own OS
  privileges. It is protection against accidental edits to the working tree, not a boundary
  against hostile code.
- **Commands come only from the registration**, are argument vectors executed with
  `shell: false`, and receive an allow-listed environment (no arbitrary secrets from the shell).
  Sandbox URLs must be loopback.
- **A model can never name a path, a command or a URL.** It returns a diff; UIProof parses the
  diff, rejects anything outside the copied source, and applies hunks by exact context match in
  memory.
- **Refused by name:** hidden paths and Git metadata, dependencies, lockfiles, generated output,
  test snapshots, key material, credential-named files, CI policy, container files, build/lint
  configuration, the registration file and baseline stores.
- **No writes outside the disposable copy.** The source tree, approved baselines, Git metadata,
  comparison reports and audits are read-only to a repair; the tests re-read them afterwards.
- **Nothing leaves automatically.** There is no merge, commit, push, PR, baseline approval or
  registry publish. A verified patch is downloadable and that is all.

---

## 6 · Outstanding issues and honest limitations

1. **No live-model evidence.** Every model response in this phase came from the deterministic
   stub. The tests prove the pipeline — validation, isolation, measurement, rejection — not how
   often a real model proposes a correct patch. Running the same fixture against two or three
   providers, recording success rate, latency and token cost, is the next evidence to gather.
2. **Repair verification covers what UIProof measures.** A patch that changes behaviour outside
   the measured routes/viewports, or introduces a defect the current rule set does not detect,
   is not caught. The project's own build and test commands are the second gate and must be
   registered.
3. **The fixture is small.** Four single-defect scenarios on a dependency-free HTML application;
   real framework projects (Next.js, Vite, Svelte) need their own sandbox command, build and
   test wiring, and their build times will dominate a repair run.
4. **The visual scenario needs `entryFiles`.** A screenshot carries no selector, so the project
   must name the page file a visual repair may look at. Without it the engine says so rather than
   guessing.
5. **Stale references are detected for repairs, not for stored diagnoses.** A repair records the
   commit SHA, dirty state and content digest it pinned, and reports stale files against it. A
   Phase 7 diagnosis still records only the lines it read; adding a run-level Git SHA would let
   it name the change that caused a regression.
6. **No run-level Git SHA in comparison reports.** Only repairs pin one. This remains the most
   valuable missing piece of context for both diagnosis and repair.
7. **The UI was verified through the DOM, not through screenshots.** The environment cannot
   composite browser frames reliably; the dashboard test reads the rendered panel, its loaded
   images (natural width > 0) and the downloaded patch bytes.

None of these is a regression in Phase 1–7 behaviour; all earlier suites pass unchanged.
