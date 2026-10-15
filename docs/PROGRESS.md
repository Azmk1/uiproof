# UIProof — progress log

**North star:** an automated frontend quality platform that detects visual regressions,
accessibility problems and design inconsistencies — see `docs/GOAL.md`.

**Current milestone:** Phase 1 — foundation + first working visual regression workflow.
**Status:** complete, verified, awaiting hands-on review.

Progress = verified acceptance criteria / total = **8 / 8 (100 %)**.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | User can trigger a demo comparison from the dashboard | **Verified** | Clicked **Run comparison** in the browser: `POST /api/compare → 200`, verdict rendered as `regression · 3.841%` |
| 2 | Two captures of a page with deliberate visual differences | **Verified** | Live DOM comparison of `/demo/baseline` vs `/demo/current` confirms all five listed differences; diff image contains 39,334 highlighted pixels |
| 3 | Engine compares with pixelmatch and produces a highlighted diff image | **Verified** | `diff.png` holds exactly 39,334 diff-colour pixels = reported `changedPixels`; ~5.1k anti-aliased pixels excluded |
| 4 | Baseline, current and difference inspectable with a change percentage | **Verified** | Console tabs load all three PNGs (`200`, natural size 1280×800); 3.8412 % = 39,334 / 1,024,000 |
| 5 | Results persist locally across a page refresh | **Verified** | Each run writes 3 PNGs + `report.json` to `.uiproof/data`; after reload the console restored the newest stored run via `/api/reports/:id` |
| 6 | Capture restricted to trusted local demo routes | **Verified** | `{"targetId":"https://evil.example"}` → `400`; `/etc/passwd`, `//host`, `/demo/../secrets` rejected; cross-site/foreign-origin POST → `403`; traversal on artifacts → `400` |
| 7 | Tests, README and UI/engine separation | **Verified** | 44 Vitest tests across 6 engine files; README documents setup, architecture, API, limitations; comparison layer is React-free plain TypeScript |
| 8 | Lint, typecheck and tests pass on the final code | **Verified** | `pnpm lint` clean, `pnpm typecheck` clean, `pnpm test` 44/44, `pnpm build` succeeds |

## Milestone log

### M1 — Repository foundation
Next.js 16.4.1 (App Router, Turbopack) + React 19 + Tailwind v4 + TypeScript strict
(`strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`).
Vitest 5 configured with a `@/*` alias. pnpm 10, pinned dev/start ports.

### M2 — Design system and console shell
Token-driven palette (paper/ink + pass/regression/attention signals) in `globals.css`, adapting to
the OS colour scheme with no theme switcher. shadcn/ui primitives, Geist Sans/Mono, pixel-grid and
checkerboard motifs, console header/footer, skip link, focus-visible rings, `prefers-reduced-motion`
handling.

### M3 — Comparison engine
`lib/compare`: allow-list + capture-URL builder, shared Chromium with idle shutdown, deterministic
capture, pure decode/normalise/pixelmatch diff, verdict maths, filesystem persistence, and a thin
orchestrator. API routes stay thin and map typed errors to HTTP status codes.

### M4 — Dashboard and fixtures
Console with target/viewport/tolerance controls, verdict panel with real metrics, tabbed screenshot
inspector (fit/1×, open, download) and run history. Two fixtures rendering one shared component with
a variant prop, plus a control target that must report zero changes.

### M5 — Verification
Unit suite, dev-mode end-to-end run, security probes, determinism re-run, production build +
`pnpm start` run, WCAG contrast audit of the palette, and fixture DOM inspection.

## Verification evidence

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
| Stability | 5 repeat runs at the final revision: identical 39,334 px (spread 0, i.e. 0.000000 % of viewport) |
| Diff-image integrity | Diff PNG contains exactly 39,334 diff-colour pixels (metric and image agree) |
| Persistence | `/api/reports` newest-first; `/api/reports/:id` reloads; run dir holds 3 PNGs + `report.json` |
| Production freshness | Reports list grew after a run on `pnpm start` (route is dynamic, not build-time frozen) |
| Artifacts | `image/png`, correct `Content-Length`, immutable cache header, valid PNG signature |
| Safety probes | traversal `400` · cross-site/foreign origin `403` · bad target/viewport/tolerance/JSON `400` · unknown run `404` |
| Contrast audit | All token pairs pass WCAG AA in light and dark (body 16:1, primary button 4.9:1, badges 4.6–4.9:1) |
| Fixture DOM | Nav item removed, heading classes changed, total changed, CTA recoloured/reworded, ribbon added — all confirmed live |

Two accessibility failures were found and fixed during verification: the light-mode amber
(`attention`) token measured 2.65:1 and `ink-faint` 3.93:1 on light surfaces. Both were darkened to
`oklch(0.54 0.13 76)` and `oklch(0.55 0.011 255)`, which now measure 4.66:1 and 4.85:1.

That palette fix is also the one place where the count legitimately moved: runs captured before the
fix reported 39,333 changed pixels, runs after it report 39,334. The fixtures use `ink-faint` and the
amber ribbon, so recolouring them changed a real pixel. No run-to-run variance was observed within a
single revision (5/5 identical).

## Decisions made during implementation

- **Route groups** `(console)` / `(fixtures)` keep console chrome off the screens under test.
- **Artifacts in `.uiproof/data`** (hidden + git-ignored): verified that writing screenshots during a
  run does **not** trigger a dev-server recompile.
- **`cacheComponents` kept enabled** (the Next 16 default), which required dropping the route
  `runtime` segment config — Node is the default runtime anyway.
- **`serverExternalPackages: ["playwright"]`** so the server compiler never bundles the driver.
- **Dimension mismatch pads rather than fails**, and the report carries `dimensionsChanged` so the UI
  can explain it.
- **A control target** that compares a fixture with itself, to make "zero false positives" a
  testable claim rather than an assertion.
- **No `next/image`** for artifacts: they are already-final run-scoped PNGs; the rule override is
  scoped in `eslint.config.mjs`.

## Blockers

None outstanding.

## Next approved action

Awaiting hands-on review of Phase 1. The recommended next milestone (baseline approval + drift
tracking) is described at the end of the README; no Phase 2 work has started.
