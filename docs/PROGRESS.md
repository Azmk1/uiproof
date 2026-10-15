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

### M6 — Pre-Phase-2 delivery and quality audit

Phase 1 was pushed to `github.com/Azmk1/uiproof` (branch `main`, normal fast-forward, no history
rewritten) and then re-audited against the published commits.

| Audit check | Result |
|-------------|--------|
| Remote | `main` at the audited SHA; `gh api` lists both commits; repository default branch `main` |
| Lint / typecheck / tests / build | clean · clean · 44/44 · ✓ (re-run after the fixes below) |
| End-to-end run on final code | Clicked **Run comparison** in the browser: `regression`, 39,334 / 1,024,000 px = **3.8412 %**, capture 852 ms, diff 197 ms — identical to the Phase 1 figure at the same revision |
| Production path | `pnpm build && next start` on a scratch port: `POST /api/compare` → `200`, mobile 8.8729 %, foreign origin `403`; scratch server stopped afterwards |
| Engine is real, not mocked | No `mock`/`fake`/`stub`/hardcoded metric anywhere in `src`; fresh run wrote 3 decodable PNGs + `report.json`; independently decoded `diff.png` holds **exactly** the 39,334 red pixels the metric claims; raw baseline-vs-current pixel difference is 52,052 (the rest are anti-aliasing/sub-threshold, as pixelmatch intends) |
| UI audit (Playwright, light + dark, 1440 px and 390 px, `/` and `/demo`) | No horizontal escape anywhere, no contrast failures in either scheme, no console errors, every control reachable by `Tab` shows a focus ring |

Three genuine defects were found by that audit and fixed:

1. **Prose scrambled by flex layout** — two `<p>` elements used `display: flex` with a text run, an
   inline `<span>` and more text as *direct* children. Each run therefore became its own flex item and
   the sentence wrapped out of reading order (visible on screen as "Only /demo the local fixtures…").
   Both now wrap the prose in a single element, which is what makes the sentence wrap normally.
2. **Tolerance slider target and thumb** — the range input was 6 px tall, so (a) its pointer target was
   6 px against the WCAG 2.2 24 px minimum and (b) Chromium clipped the thumb to that box, painting a
   squashed 16×7 blob. It is now a 24 px box with `bg-clip-content`, so the tracked area stays a 6 px
   hairline while the thumb renders as a full 16×16 circle (measured from pixels, not assumed).
3. **Screenshot zoom buttons** — 10 px type in a 23 px-tall box, i.e. 1 px under the target-size
   minimum; now 11 px type in a 29 px box, matching the design's 11 px type floor.

Remaining known issues after the audit (all minor, none blocking): the only sub-24 px hit boxes are
visually hidden radio inputs whose real target is a 288×66 or 93×29 label; the skip-link and the run-id
line are clipped by design; the Next.js dev-tools badge (dev only) has no focus ring; the environment
here cannot composite browser frames reliably, so the audit was done by measuring the rendered DOM and
decoding rendered pixels rather than by looking at whole-page screenshots.

## Blockers

None outstanding.

## Next approved action

Phase 1 is delivered on `main` and awaiting hands-on review. The recommended next milestone (baseline
approval + drift tracking) is described at the end of the README; no Phase 2 work has started.
