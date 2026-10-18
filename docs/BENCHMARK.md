# The repair benchmark

Ten defects, three applications, the whole loop for each one: measure the defect, ask for a patch,
apply it inside a container, run the project's own build and tests, re-measure, and record the
verdict. The point is not a leaderboard — it is that UIProof's repair claims can be reproduced and
inspected by anyone, and that the run says exactly which parts were the harness and which were a
model.

```bash
pnpm benchmark                                       # the deterministic reference run
UIPROOF_AI_API_KEY=… pnpm benchmark                   # the same corpus, judged against a real model
UIPROOF_BENCHMARK_SCENARIOS=vite-overflow,next-overflow pnpm benchmark   # one or two scenarios
```

Requirements: Chromium (`pnpm setup:browser`) and a container runtime (**docker** or podman), because
every scenario runs as container execution — `--network none`, read-only root, dropped capabilities.
With no runtime the suite skips and says so; a skip is never written up as a pass.

It is deliberately **not** part of `pnpm verify` or of CI. Ten repairs across three applications is a
long run, and a benchmark is something you choose to run and then read; the browser suite's container
files already cover the same machinery on a smaller scale.

## The two modes, and why the report names one

| Mode | When | What the numbers mean |
| ---- | ---- | --------------------- |
| `deterministic-stub` | no `UIPROOF_AI_API_KEY` (or `OPENAI_API_KEY`) | Every patch is the reference fix from [benchmark/defects.json](../benchmark/defects.json), served over the real HTTP interface by `e2e/support/stub-model.ts`. This measures **the harness and the pipeline** — isolation, scope checks, build, tests, re-measurement, verdict. It measures nothing about a model, and the report says so in its first caveat. |
| `live-model` | a key is configured | Every patch is written by the configured OpenAI-compatible model (`UIPROOF_AI_MODEL`, `UIPROOF_AI_BASE_URL`). These numbers are the model's, at that endpoint, on that day. |

The mode, the model name, the endpoint host and the container runtime are all written into the report,
so a pasted table can never be mistaken for the other mode.

## The corpus

| Scenario | Application | Defect | Target | Viewport |
| -------- | ----------- | ------ | ------ | -------- |
| `repair-app-label` | `examples/repair-app` (static fixture) | an input nothing names | audit, `a11y:label@` | desktop |
| `repair-app-contrast` | same | `#9a9a9a` on white (2.8:1) | audit, `a11y:color-contrast@` | desktop |
| `repair-app-overflow` | same | a 720 px banner on a phone | audit, `responsive:` | mobile |
| `repair-app-visual` | same | the page drifted from its approved baseline | report, `visual:` | desktop |
| `vite-label` | `examples/vite-app` (React + Vite) | a visible label that is never associated with its field | audit, `a11y:label@` | desktop |
| `vite-overflow` | same | a 640 px panel wider than a phone | audit, `responsive:` | mobile |
| `vite-contrast` | same | a muted line that is too muted, in the stylesheet | audit, `a11y:color-contrast@` | desktop |
| `next-label` | `examples/next-app` (Next.js) | the same defect class in a server-rendered app | audit, `a11y:label@` | desktop |
| `next-overflow` | same | a ledger table wider than a phone | audit, `responsive:` | mobile |
| `next-contrast` | same | a shared stylesheet's colour, on a second route | audit, `a11y:color-contrast@` | desktop |

The three applications are deliberately not alike: one is a static fixture read per request, one is a
Vite build served by `vite preview`, one is a Next.js production server. Two of the three fix the
defect in a stylesheet rather than in a component, and two run on a route that shares files with a
guard route that must not regress.

Each fixture also carries its own test command, and those tests are invariants rather than assertions
about the defect: they fail if a candidate "fixes" a missing label by deleting the field, or an
overflow by clipping or scrolling the panel. A patch that satisfies the measurement by removing the
thing being measured does not pass.

## What one scenario does

1. Copies the fixture to a temporary directory and builds it **inside the container**, so the
   application under measurement is the fixture's own toolchain output.
2. Measures the defect: a quality audit for the audit targets, or an approved baseline plus a drifted
   page for the visual scenario (the run asserts the drift really reads as a regression).
3. Hands the stored measurement to the repair engine with a model endpoint — the stub in
   `deterministic-stub` mode, the configured provider in `live-model` mode.
4. Runs the engine's own loop: validate the proposal, apply it to a fresh copy, run the project's
   build and tests, re-measure the target route and every guard route, and compute the verdict.
5. Asserts the original fixture tree is byte-identical afterwards, then records the verdict, the
   attempts, each attempt's own reasons, the measured before/after values, the isolation summary, the
   duration and the prompt/response sizes.

## The report

Every run writes three files:

- `docs/benchmark/<timestamp>.json` — the full record, including each attempt's reasons and measured
  targets, and the scenarios' own notes.
- `docs/benchmark/latest.json` — the same record, for the newest run.
- `docs/benchmark/latest.md` — the table below, generated from the JSON, never typed by hand.

The committed [latest.md](benchmark/latest.md) is the current evidence. The run of 2026-10-18:

| Scenario | Category | Verdict | Isolation | Attempts | Verified at | Duration |
| -------- | -------- | ------- | --------- | -------- | ----------- | -------- |
| repair-app-label | accessibility | verified | container | 1 | 1 | 13 s |
| repair-app-contrast | accessibility | verified | container | 1 | 1 | 7 s |
| repair-app-overflow | responsive | verified | container | 1 | 1 | 7 s |
| repair-app-visual | visual | verified | container | 1 | 1 | 8 s |
| vite-label | accessibility | verified | container | 1 | 1 | 15 s |
| vite-overflow | responsive | verified | container | 1 | 1 | 15 s |
| vite-contrast | accessibility | verified | container | 1 | 1 | 15 s |
| next-label | accessibility | verified | container | 1 | 1 | 45 s |
| next-overflow | responsive | verified | container | 1 | 1 | 37 s |
| next-contrast | accessibility | verified | container | 1 | 1 | 36 s |

**10 / 10 verified, all ten on the first attempt, 197 s total, median 14.7 s** — in
`deterministic-stub` mode, on docker 29.8.2, with every scenario executed as container execution.
That is what the reference fixes and the pipeline do together; it is not a model's score.

One finding from that corpus is worth keeping. The first version of the reference patch for the two
overflow scenarios added `max-width: 100%` and nothing else, and the benchmark recorded
`partially-improved` — twice, with the evidence: *304 px → 14 px* of document overflow on the Vite
fixture and *344 px → 14 px* on the Next.js one. The panel's padding sat outside the width it was
being constrained to, so the naive fix left 14 px behind. The reference patch now also sets
`box-sizing: border-box`, and the run verifies. A harness written to agree with the fix would have
called the first patch a success.

## What the numbers are, and what they are not

- **Token counts are estimates**, computed as four characters per token over the characters actually
  sent and received. No tokeniser was run, and the report says so.
- **Cost is reported only if you supply a price**: `UIPROOF_BENCHMARK_PRICE_PER_MTOK=<usd per million
  tokens>`. The report multiplies the estimate by it and labels the result an estimate; with no price
  it reports `not reported` rather than inventing one.
- **`live-model` numbers are a snapshot of one endpoint.** Which model, which version, which day. A
  different provider is a different corpus result; the report records the model and host so the
  comparison is at least explicit.
- **Failure to fix is not a test failure.** The suite asserts that every scenario *ran* and produced a
  verdict. Whether the patch verified is the measurement being collected — a benchmark that failed its
  own suite whenever a model failed a defect would be reporting the wrong thing.
- **The corpus is ten defects on three small applications.** It says nothing about a large codebase, a
  state-management tangle, or a defect class nobody has written into a fixture yet.
