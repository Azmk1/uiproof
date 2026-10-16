"use client";

import { Activity } from "lucide-react";
import { formatChangePercentage } from "@/lib/compare/metrics";
import type { ReportSummary } from "@/lib/compare/types";
import { formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";

interface ComparisonTimelineProps {
  readonly reports: readonly ReportSummary[];
  readonly activeId: string | null;
  /** Tolerance the next run will use, drawn as the reference line. */
  readonly tolerance: number;
  readonly targetLabel: string;
  readonly viewportLabel: string;
  readonly onSelect: (id: string) => void;
  readonly limit?: number;
}

/**
 * Change percentage of the most recent runs for one target and viewport, oldest on the
 * left. Bars are buttons, so the timeline is a keyboard-reachable way to step back
 * through history as well as a picture of when things started moving.
 */
export function ComparisonTimeline({
  reports,
  activeId,
  tolerance,
  targetLabel,
  viewportLabel,
  onSelect,
  limit = 24,
}: ComparisonTimelineProps) {
  const chronological = [...reports].slice(0, limit).reverse();
  const values = chronological.map((report) => report.changePercentage);
  const peak = Math.max(...values, tolerance, 0.01);
  const top = peak * 1.15;
  const tolerancePct = (tolerance / top) * 100;

  return (
    <section
      aria-label="Comparison timeline"
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="label-caps">Comparison timeline</h2>
          <p className="text-[12px] text-ink-soft">
            {targetLabel} at {viewportLabel} · oldest to newest
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink-faint">
          {chronological.length === 0
            ? "no runs yet"
            : `${chronological.length} run${chronological.length === 1 ? "" : "s"} · peak ${formatChangePercentage(peak, 2)}%`}
        </span>
      </header>

      {chronological.length === 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface-muted/50 p-3 text-[12px] leading-relaxed text-ink-soft">
          <Activity aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
          <span>Run a comparison to start the timeline for this target and viewport.</span>
        </p>
      ) : (
        <div className="relative flex h-[132px] items-end gap-1.5 border-b border-line pb-px">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line-strong"
            style={{ bottom: `${tolerancePct}%` }}
          />
          {chronological.map((report) => {
            const isActive = report.id === activeId;
            const isRegression = report.status === "regression";
            // A capture-only run measured nothing, so its bar is drawn at the floor
            // rather than at a percentage nobody claims.
            const heightPct = report.mode === "capture" ? 0 : Math.max((report.changePercentage / top) * 100, 2);
            const label =
              report.mode === "capture"
                ? `capture only, nothing compared · ${formatRelativeTime(report.createdAt)}`
                : `${formatChangePercentage(report.changePercentage, 2)}% · ${
                    isRegression ? "regression" : "passed"
                  } · ${report.mode === "baseline" ? "approved baseline" : "fixture pair"} · ${formatRelativeTime(
                    report.createdAt,
                  )}`;
            return (
              <button
                key={report.id}
                type="button"
                onClick={() => onSelect(report.id)}
                aria-pressed={isActive}
                aria-label={`Run ${report.id}: ${label}`}
                title={`${report.id} — ${label}`}
                className={cn(
                  // The column is the target, the bar is the picture: a short run still has
                  // a 132px hit box instead of the 3px one its bar would give it.
                  "group flex h-full min-w-0 flex-1 items-end rounded-t-[3px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative block w-full rounded-t-[3px] transition-colors",
                    isRegression
                      ? "bg-regress/70 group-hover:bg-regress"
                      : report.mode === "capture"
                        ? "bg-attention/60 group-hover:bg-attention"
                        : "bg-pass/60 group-hover:bg-pass",
                    isActive && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
                  )}
                  style={{ height: `max(3px, ${heightPct}%)` }}
                >
                  {report.mode === "baseline" ? (
                    <span className="absolute inset-x-0 top-0 h-[3px] rounded-t-[3px] bg-accent" />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-soft">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-pass/60" />
          passed
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-attention/60" />
          <span>captured, not compared</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-regress/70" />
          regression
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-4 border-t border-dashed border-line-strong" />
          {/* One wrapper element: prose split across flex items would wrap out of order. */}
          <span>current tolerance ({formatChangePercentage(tolerance, 2)}%)</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] border-t-[3px] border-accent" />
          ran against an approved baseline
        </li>
      </ul>
    </section>
  );
}
