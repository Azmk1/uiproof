"use client";

import { LoaderCircle } from "lucide-react";
import { formatChangePercentage } from "@/lib/compare/metrics";
import type { ReportSummary } from "@/lib/compare/types";
import { formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";

interface RunHistoryProps {
  readonly reports: readonly ReportSummary[];
  readonly activeId: string | null;
  readonly loadingId: string | null;
  readonly onSelect: (id: string) => void;
}

export function RunHistory({ reports, activeId, loadingId, onSelect }: RunHistoryProps) {
  return (
    <section aria-label="Run history" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="label-caps">Run history</h2>
        <span className="font-mono text-[11px] text-ink-faint">
          {reports.length === 0 ? "empty" : `${reports.length} stored`}
        </span>
      </header>

      {reports.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Runs are written to <span className="font-mono">.uiproof/data</span> and reload with the page.
        </p>
      ) : (
        <ul role="list" className="-mx-1 flex max-h-[300px] flex-col overflow-y-auto">
          {reports.map((report) => {
            const isActive = report.id === activeId;
            const isLoading = report.id === loadingId;
            return (
              <li key={report.id}>
                <button
                  type="button"
                  onClick={() => onSelect(report.id)}
                  aria-current={isActive ? "true" : undefined}
                  disabled={isLoading}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                    isActive ? "bg-surface-muted" : "hover:bg-surface-muted",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      report.status === "regression" ? "bg-regress" : "bg-pass",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] font-medium">{report.targetLabel}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint">
                      {report.viewportLabel} · {formatRelativeTime(report.createdAt)}
                    </span>
                  </span>
                  {isLoading ? (
                    <LoaderCircle className="size-3.5 animate-spin text-ink-faint" />
                  ) : (
                    <span
                      className={cn(
                        "tabular shrink-0 font-mono text-[11px]",
                        report.status === "regression" ? "text-regress" : "text-ink-soft",
                      )}
                    >
                      {formatChangePercentage(report.changePercentage, 2)}%
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
