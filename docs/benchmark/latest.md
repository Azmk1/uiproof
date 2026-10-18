# Repair benchmark — 2026-10-18T00:17:01.619Z

- **Mode:** deterministic-stub (stub)
- **Requested:** all
- **Runtime:** docker 29.8.2
- **Scenarios:** 10 · verified 10 · verified on the first attempt 10 · failed to run 0
- **Median duration:** 14717 ms
- **Estimated tokens:** 17724 prompt + 1653 response
- **Estimated cost:** not reported (no price supplied)

| Scenario | Category | Verdict | Isolation | Attempts | Verified at | Duration | Est. tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| repair-app-label | accessibility | verified | container | 1 | 1 | 13s | 1758 |
| repair-app-contrast | accessibility | verified | container | 1 | 1 | 7s | 1763 |
| repair-app-overflow | responsive | verified | container | 1 | 1 | 7s | 2202 |
| repair-app-visual | visual | verified | container | 1 | 1 | 8s | 1424 |
| vite-label | accessibility | verified | container | 1 | 1 | 15s | 2194 |
| vite-overflow | responsive | verified | container | 1 | 1 | 15s | 2797 |
| vite-contrast | accessibility | verified | container | 1 | 1 | 15s | 1640 |
| next-label | accessibility | verified | container | 1 | 1 | 45s | 1700 |
| next-overflow | responsive | verified | container | 1 | 1 | 37s | 2283 |
| next-contrast | accessibility | verified | container | 1 | 1 | 36s | 1616 |

## Caveats, as recorded by the run

- These patches came from the deterministic stub in e2e/support/stub-model.ts, which answers with the reference fix from benchmark/defects.json. The harness and the pipeline are measured here; a model's ability to fix these defects is not.
- Token counts are estimated at four characters per token, not counted by a tokeniser.
- No price was supplied (UIPROOF_BENCHMARK_PRICE_PER_MTOK), so no cost is reported — an invented one would be worse than none.
- Each scenario runs in container execution: no network, read-only root, dropped capabilities.

## What each scenario is

- **repair-app-label** (repair-app): A control nothing names, on a page that also has a contrast failure and a fixed-width banner: the patch has to fix one defect without touching the others.
- **repair-app-contrast** (repair-app): #9a9a9a on white is 2.8:1. The fix is a colour, so the patch is a one-line edit and the measurement is the only thing that can judge it.
- **repair-app-overflow** (repair-app): A 720px banner on a phone. The naive fix is to hide it; the test command in this fixture fails if the banner stops being a banner.
- **repair-app-visual** (repair-app): The page drifted from its approved baseline. The only acceptable repair is a rendering that matches the approved pixels again.
- **vite-label** (vite-app): The label is visible but never associated with the field: the patch has to add the association, and the fixture's own markup test must still pass afterwards.
- **vite-overflow** (vite-app): A fixed 640px panel. `max-width: 100%` alone is not a fix: the panel's own padding is measured outside its width, so a first version of this reference patch left 14px of overflow and the run recorded it as partially-improved rather than verified. A complete fix also makes the box include its padding.
- **vite-contrast** (vite-app): A muted line that is too muted. The fix belongs in the stylesheet, not in the component, and the model is only shown the files it may edit.
- **next-label** (next-app): The same defect class in a server-rendered React application, where the fix is JSX the framework then compiles.
- **next-overflow** (next-app): A ledger table wider than a phone, in a Next.js application UIProof has never seen — and the same lesson as the Vite fixture: a max-width that ignores the border box still overflows.
- **next-contrast** (next-app): The last defect is a colour in a shared stylesheet: fixing it must not break the two routes that share the file.
