# UIProof — North Star and phase scope

_The Phase 1 section was recorded before implementation and is unchanged since; the later sections
record what each following phase was approved to do. Last reviewed 2026-10-15._

## North star

UIProof is an automated frontend quality platform. It detects **visual regressions**,
**accessibility problems** and **design inconsistencies** in websites, and eventually integrates
with GitHub and uses AI agents to propose and verify repairs.

The product only exists if developers trust its numbers: a report must come from a real render, a
real pixel comparison, and a real stored artifact — never a placeholder, a cached fixture or an
estimate.

## Phase 1 — what is approved now

**Goal:** the foundation plus the first functional visual regression workflow, working end to end on
a local machine.

**In scope**

1. A clean, maintainable repository with strict TypeScript.
2. A polished, responsive developer console with a coherent design system and honest states
   (loading, empty, error).
3. A working comparison engine: two captures at identical viewport settings, pixelmatch comparison,
   highlighted difference image.
4. Two local demo pages with documented, deliberate visual differences.
5. A dashboard that triggers a comparison and shows baseline / current / difference plus the
   measured change percentage.
6. Local persistence of screenshots and reports that survives a page refresh.
7. Capture restricted to trusted local demo routes.
8. Meaningful tests, a README, and a clear boundary between UI and comparison logic.

**Explicitly out of scope for Phase 1:** authentication, databases, Redis, queues, microservices,
GitHub webhooks/integration, AI repair proposals, external URL screenshots, baseline approval
workflow, accessibility scanning.

## Fixed technical decisions

| Decision          | Choice                                            | Why |
| ----------------- | ------------------------------------------------- | --- |
| Framework         | Next.js 16 App Router, React 19, TypeScript strict | Route handlers keep the engine server-side; one process serves UI, API and fixtures |
| Styling           | Tailwind CSS v4 + shadcn/ui + Lucide               | Token-driven design system, accessible primitives, minimal dependencies |
| Browser           | Playwright (pinned Chromium)                       | Deterministic screenshot options, managed browser download |
| Comparison        | pixelmatch + pngjs                                 | Purpose-built, perceptual metric, no native dependencies |
| Tests             | Vitest                                             | Fast, ESM-native, no browser needed for the pure engine |
| Package manager   | pnpm                                               | Required by the brief |

## Acceptance criteria

1. A developer can clone the repository, install dependencies, start UIProof, open the dashboard,
   run a real screenshot comparison, view the generated visual differences, and reload the report
   successfully.
2. Linting, type checking and tests pass, with evidence recorded in `docs/PROGRESS.md`.
3. Every number shown in the UI is derived from a real capture and real pixel counts.

## Guardrails

- No fabricated metrics, fake API responses, placeholder buttons or static comparison results.
- No new service dependencies (auth, cache, queue, database, GitHub, AI) in these phases.
- The engine must not become an open screenshot service. Every phase that widens what can be
  captured has to keep a named, validated allow-list in the way.

## Phase 2 — approved baselines and drift detection (delivered)

**Goal:** stop comparing two fixtures and start comparing a page against a reference a developer
approved. A capture can be approved as an immutable, versioned baseline; every later run is diffed
against the active version; drift is classified pass/regression; the console shows the reference, its
history and the run timeline. Verified in `docs/PROGRESS.md` § Phase 2.

## Phase 3 — real application integration and security hardening (delivered)

**Goal:** make UIProof work against an application that is already running on this machine, not just
against its own demo pages.

**In scope**

1. Audit and harden the local write guard: no wildcard address in the loopback set, servers bound to
   loopback by default.
2. Make baseline metadata updates atomic across processes, with tests — or restrict and document the
   store as single-process.
3. Register local projects in a configuration file: id, name, explicit loopback origin, allow-listed
   routes. Invalid configuration is refused, not partially applied.
4. Capture registered routes in Playwright, with actionable errors for an unreachable server and a
   refusal for anything that leaves the registered origin.
5. Restrict the capture browser's network to the approved origins by default.
6. Per-project, per-route, per-viewport baselines with explicit approval, version history, restore,
   and no cross-project contamination — and no destructive migration of Phase 2 data.
7. A project and route selector in the existing console, in the existing design language, with no
   decorative controls.
8. An independent example application and a browser suite that demonstrates the whole workflow
   against it, using real captures and real responses.

**Explicitly out of scope for Phase 3:** authentication, distributed infrastructure, GitHub
pull-request automation, AI repairs, public URL scanning, multi-user SaaS behaviour.

**Guardrails**

- Every earlier phase keeps working: the demo fixtures, the Phase 2 API shape and the stored Phase 2
  baselines are untouched.
- A browser request may never name a URL, only a registered id.
- No fabricated comparisons in the integration test: the example application's UI really changes, and
  the regression is measured from real captures.
- The security statement stays honest about what is and is not a control.

## Phase 4 — CLI, portable baselines and CI quality gates (delivered)

**Goal:** let a developer run UIProof from a terminal and use it to block real visual regressions in
their own pipeline, with no dashboard involved.

**In scope**

1. A production-quality Node CLI — `capture`, `check`, `projects`, `baselines`, `--help`, `--version` —
   with explicit project, route, viewport, configuration, storage and tolerance options, invoking the
   existing engine directly rather than through the server.
2. Documented, deterministic exit codes: `0` pass, `1` regression, `2` anything that stopped the tool
   from answering — capture-only reported as *captured*, never as a pass — plus readable terminal
   output and optional structured JSON for automation.
3. Portable approved baselines: a committable bundle with metadata and integrity validation, explicit
   activation only, no automatic replacement, no version overwrites, and a documented strategy for
   keeping bundles in a repository. Runtime reports stay separate from canonical baselines.
4. A working GitHub Actions example on a clean runner: check out an example project, install, start its
   application, wait for health, load an approved baseline, run the CLI, fail the job when a regression
   exceeds tolerance, and upload screenshots and comparison reports.
5. End-to-end verification with real Chromium — unchanged page `0`, modified page `1`, missing baseline
   `2`, invalid project or route `2`, unreachable application `2`, JSON output matching the persisted
   report, export/import surviving a fresh working directory, and a clean CI-style run detecting a
   regression.

**Explicitly out of scope for Phase 4:** AI integration, authentication or multi-user SaaS features, a
cloud database, extra services, publishing a package to npm, and a major architecture rewrite.

**Guardrails**

- The CLI calls the engine: no second implementation of capture, diffing, metrics or the baseline
  lifecycle, and no dashboard server required to run a comparison.
- The capture surface stays closed — registered routes on loopback origins, the same allow-list the
  console enforces. No arbitrary public URL scanning.
- An imported bundle cannot write outside the store, cannot overwrite an approved version, and cannot
  change what is active by accident.
- The web console and its baseline lifecycle keep working unchanged.

## Phase 4.5 — trusted baselines and genuine CI enforcement (delivered)

**Goal:** make the visual-regression workflow able to actually stop an unapproved visual change from
merging. It could not: it imported a committed baseline and then approved the application under test
immediately before checking it, so a broken change could pass its own gate.

**In scope**

1. A reproducible Linux/Chromium environment — one container image, pinned by tag and digest, with the
   browser version, fonts, viewport, device scale factor, locale and the rest of the rendering input
   written down, and an honest account of what is still not deterministic.
2. A genuine approved baseline for the example application, generated in that environment, exported
   and committed with its SHA-256 and metadata intact — plus a separate, reviewable process for
   updating it that no pull request can reach and that commits nothing by itself.
3. A real pull-request gate: the proposed code is built and run, the reference comes from the base
   branch, nothing captures or approves during a check, `0` passes while `1` and `2` fail the job, and
   screenshots, diffs and reports are uploaded either way. A pull request cannot authorise its own
   visual change by editing the bundled baseline in the same pull request.
4. The Phase 4 pass → regression → restore walkthrough kept as an integration test, clearly separated
   from the gate, asserting each documented exit code rather than gating on it.
5. Verification in that environment with real screenshots: approved `0`, modified `1`, restored `0`,
   missing baseline `2`, tampered image `2`, and a modified bundle that cannot authorise its own pull
   request.

**Explicitly out of scope for Phase 4.5:** AI integration, authentication or multi-user features,
hosted scanning, publishing a package to npm, and a major architecture rewrite.

**Guardrails**

- The gate never captures and never approves. Anything that approves is a separate, dispatched,
  reviewed operation with no path from a pull request.
- The reference a gate compares against comes from a commit the pull request cannot write to.
- Every rendering-dependent variable is either pinned or named as unpinned; nothing is described as
  reproducible without a measurement behind it.
- The CLI's capture surface is unchanged: registered routes on loopback origins only.
- Existing tests, the console and its baseline lifecycle keep working unchanged.
