import { CircleCheckBig, GitCompareArrows, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatChangePercentage } from "@/lib/compare/metrics";
import type { ComparisonReport } from "@/lib/compare/types";
import { formatClockTime, formatDuration, formatRelativeTime } from "@/lib/format-time";
import { cn, shortId } from "@/lib/utils";

function MetricTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly tone?: "default" | "regress" | "attention";
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 first:pl-0 last:pr-0">
      <span className="label-caps">{label}</span>
      <span
        className={cn(
          "tabular font-mono text-lg leading-none tracking-tight",
          tone === "regress" && "text-regress",
          tone === "attention" && "text-attention",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
    </div>
  );
}

function MetaRow({ label, value, mono = true }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="label-caps">{label}</dt>
      <dd className={cn("truncate text-[12px] text-ink-soft", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}

export function DiffLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-soft">
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-regress" />
        Changed pixels (counted)
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-attention" />
        Anti-aliasing (ignored)
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] border border-line-strong bg-surface" />
        Unchanged context
      </li>
    </ul>
  );
}

export function VerdictPanel({ report }: { readonly report: ComparisonReport }) {
  const isRegression = report.status === "regression";
  const { metrics } = report;
  // Reports written before Phase 2 have no mode; those runs compared the fixture pair.
  const mode = report.mode === "baseline" ? "baseline" : "fixture";
  const baseline = report.baseline ?? null;

  return (
    <section
      aria-label="Comparison verdict"
      className={cn(
        "overflow-hidden rounded-xl border bg-surface",
        isRegression ? "border-regress/35" : "border-line",
      )}
    >
      <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="label-caps">Verdict</span>
            <Badge variant="neutral">
              {mode === "baseline" ? <ShieldCheck /> : <GitCompareArrows />}
              {mode === "baseline" ? "approved baseline" : "fixture pair"}
            </Badge>
            {isRegression ? (
              <Badge variant="regress">
                <TriangleAlert />
                regression
              </Badge>
            ) : (
              <Badge variant="pass">
                <CircleCheckBig />
                no changes
              </Badge>
            )}
          </div>
          <div className="flex items-end gap-2">
            <span
              className={cn(
                "tabular font-mono text-[2.5rem] leading-none font-medium tracking-tight",
                isRegression ? "text-regress" : "text-pass",
              )}
            >
              {formatChangePercentage(metrics.changePercentage, 3)}
              <span className="text-[1.5rem]">%</span>
            </span>
            <span className="pb-1 text-[13px] text-ink-soft">of the viewport changed</span>
          </div>
          <p className="max-w-prose text-[13px] text-ink-soft">
            {metrics.changedPixels.toLocaleString("en-US")} of{" "}
            {metrics.comparedPixels.toLocaleString("en-US")} compared pixels differ. Tolerance is{" "}
            {metrics.maxDiffPercent}%.
          </p>
        </div>

        <dl className="flex w-full shrink-0 flex-col gap-2 sm:w-[290px]">
          <MetaRow label="Target" value={report.target.label} mono={false} />
          <MetaRow
            label={mode === "baseline" ? "Reference" : "Routes"}
            value={
              mode === "baseline" && baseline
                ? `${shortId(baseline.versionId)} · ${baseline.capturedRoute}`
                : `${report.target.baselinePath} → ${report.target.currentPath}`
            }
          />
          <MetaRow label="Captured" value={report.target.currentPath} />
          <MetaRow label="Viewport" value={`${report.viewport.label} · ${report.viewport.width}×${report.viewport.height}`} />
          {baseline ? (
            <MetaRow
              label="Baseline"
              value={`approved ${formatRelativeTime(baseline.approvedAt)} from ${shortId(baseline.sourceReportId)}`}
            />
          ) : null}
          <MetaRow label="Run" value={report.id} />
          <MetaRow label="Finished" value={formatClockTime(report.createdAt)} />
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-y-1 border-t border-line bg-surface-muted/60 px-5 sm:grid-cols-4 sm:divide-x sm:divide-line">
        <MetricTile
          label="Changed px"
          value={metrics.changedPixels.toLocaleString("en-US")}
          tone={isRegression ? "regress" : "default"}
        />
        <MetricTile
          label="Compared px"
          value={metrics.comparedPixels.toLocaleString("en-US")}
          hint={`${metrics.pixelThreshold} perceptual threshold`}
        />
        <MetricTile label="Capture" value={formatDuration(report.engine.captureMs)} hint={report.engine.browser} />
        <MetricTile
          label="Diff image"
          value={formatBytes(report.artifacts.diff.bytes)}
          hint={`${formatDuration(report.engine.compareMs)} of comparison`}
        />
      </div>

      {metrics.dimensionsChanged ? (
        <p className="flex items-start gap-2 border-t border-attention/30 bg-attention-soft px-5 py-3 text-[12px] text-attention">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          The two captures had different pixel dimensions. The smaller one was padded on white before
          diffing, so the highlighted edges are real layout differences.
        </p>
      ) : null}
    </section>
  );
}
