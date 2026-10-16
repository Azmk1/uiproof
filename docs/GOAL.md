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
