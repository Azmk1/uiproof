import { Cpu, Gauge, HardDrive, ScanLine } from "lucide-react";
import { ComparisonConsole } from "@/components/console/comparison-console";
import { Badge } from "@/components/ui/badge";

const PIPELINE = ["capture", "diff", "measure", "persist"] as const;

const ENGINE_NOTES = [
  {
    icon: Cpu,
    title: "Deterministic captures",
    body: "Chromium renders both routes at one viewport with a fixed colour profile, light colour scheme and animations disabled, so an unchanged page produces an identical image.",
  },
  {
    icon: ScanLine,
    title: "Pixelmatch diffing",
    body: "The two PNGs are decoded, matched dimension-for-dimension and compared with a perceptual colour metric that ignores anti-aliased noise.",
  },
  {
    icon: HardDrive,
    title: "Local artifacts",
    body: "Screenshots and the JSON report are written to .uiproof/data, so a refresh or a server restart still shows the last run.",
  },
  {
    icon: Gauge,
    title: "Measured, not estimated",
    body: "Change percentages come from counted pixels — never from a heuristic — and the report keeps the capture and comparison timings.",
  },
] as const;

export default function ConsolePage() {
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 py-8 lg:px-8 lg:py-12">
      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="accent">phase 1 · foundation</Badge>
          <span className="label-caps">visual regression console</span>
        </div>
        <h1 className="max-w-3xl text-[clamp(2rem,4.5vw,2.85rem)] leading-[1.04] font-semibold tracking-[-0.035em]">
          Catch visual regressions before your users do.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          UIProof renders the same screen twice in headless Chromium, compares the screenshots pixel by
          pixel, and highlights exactly what moved — alongside the measured share of the viewport that
          changed.
        </p>
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {PIPELINE.map((step, index) => (
            <li key={step} className="flex items-center gap-3">
              <span className="label-caps text-ink-soft">{step}</span>
              {index < PIPELINE.length - 1 ? (
                <span aria-hidden="true" className="text-ink-faint">
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <ComparisonConsole />

      <section aria-label="How the engine works" className="grid gap-x-8 gap-y-6 border-t border-line pt-8 sm:grid-cols-2 xl:grid-cols-4">
        {ENGINE_NOTES.map((note) => (
          <div key={note.title} className="flex flex-col gap-2">
            <note.icon aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{note.title}</h2>
            <p className="text-[13px] leading-relaxed text-ink-soft">{note.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
