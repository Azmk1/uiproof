# UIProof — North Star and Phase 1 scope

_Recorded before implementation; unchanged since. Last reviewed 2026-10-14._

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
- No new service dependencies (auth, cache, queue, database, GitHub, AI) in this phase.
- The engine must not become an open screenshot service.
