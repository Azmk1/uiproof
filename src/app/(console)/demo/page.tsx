import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { COMPARISON_TARGETS } from "@/lib/compare/targets";

export const metadata: Metadata = {
  title: "Fixtures",
  description: "The two local demo pages UIProof is allowed to screenshot.",
};

export default function FixturesPage() {
  const [regressionPair, control] = COMPARISON_TARGETS;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-8 lg:px-8 lg:py-12">
      <section className="flex flex-col gap-4">
        <span className="label-caps">Fixtures</span>
        <h1 className="max-w-3xl text-[clamp(1.75rem,3.5vw,2.4rem)] leading-[1.08] font-semibold tracking-[-0.03em]">
          Two pages, one of them quietly broken.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Both fixtures render the same React component with a different theme variant, so the only
          pixel differences between them are the deliberate regressions listed below. That makes the
          comparison engine testable the moment the app boots.
        </p>
      </section>

      <section aria-label="Fixture pages" className="grid gap-4 lg:grid-cols-2">
        {[regressionPair.baseline, regressionPair.current].map((route, index) => (
          <article key={route.path} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <Badge variant={index === 0 ? "neutral" : "regress"}>
                {index === 0 ? "baseline" : "current"}
              </Badge>
              <span className="font-mono text-[11px] text-ink-faint">{route.path}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{route.label}</h2>
              <p className="text-[13px] leading-relaxed text-ink-soft">
                {index === 0
                  ? "The reference screen: teal primary action, “Docs” in the navigation, the original total."
                  : "The regressed screen: indigo action with new copy, the navigation item removed, an added ribbon and a different total."}
              </p>
            </div>
            <Link
              href={route.path}
              className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium transition-colors hover:bg-surface-muted"
            >
              Open fixture
              <ArrowUpRight className="size-3.5" />
            </Link>
          </article>
        ))}
      </section>

      <section aria-label="Deliberate differences" className="grid gap-6 rounded-xl border border-line bg-surface p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <h2 className="label-caps">Deliberate differences</h2>
          <ul className="flex flex-col gap-2 text-[13px] text-ink-soft">
            {regressionPair.expectedChanges.map((change) => (
              <li key={change} className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-regress" />
                {change}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3 border-line lg:border-l lg:pl-6">
          <h2 className="label-caps">Control target</h2>
          <p className="text-[13px] leading-relaxed text-ink-soft">{control.summary}</p>
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-faint">
            <Lock className="mt-0.5 size-3 shrink-0" />
            {/* One wrapper element: direct text runs inside a flex row become separate flex
                items, which wraps the sentence out of reading order. */}
            <span>
              The engine only ever navigates to routes under <span className="font-mono">/demo</span>.
              Absolute URLs, traversal and protocol-relative paths are rejected before Chromium
              starts.
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}
