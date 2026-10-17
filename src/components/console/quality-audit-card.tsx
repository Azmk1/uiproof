"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { QualityPanel } from "@/components/console/quality-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createAudit, fetchAudit, fetchAudits } from "@/lib/api-client";
import { sourceScopeKey, type SourceSelection } from "@/lib/compare/source-selection";
import { qualityModelFromReport } from "@/lib/quality/presentation";
import type { QualityReport } from "@/lib/quality/types";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Runs the accessibility and layout audit for the selected source and shows its result.
 *
 * Every viewport preset is measured — desktop, tablet and mobile — because overflow is
 * exactly what only shows up at the edges. The newest stored audit for the source is
 * loaded on page load, so a refresh keeps the last result on screen, and each measurement
 * links to the screenshot it was taken from.
 *
 * Like the baseline fetch in the console, results are keyed against the scope they belong
 * to and derived — never set inside the fetching effect — so a slow answer for a previous
 * source can never land on the current one.
 */
export function QualityAuditCard({
  selection,
  sourceLabel,
}: {
  readonly selection: SourceSelection | null;
  readonly sourceLabel: string;
}) {
  const scopeKey = selection ? sourceScopeKey(selection) : null;

  const [loaded, setLoaded] = useState<{
    readonly requestKey: string;
    readonly report: QualityReport | null;
  } | null>(null);
  const [runResult, setRunResult] = useState<{
    readonly requestKey: string;
    readonly report: QualityReport;
  } | null>(null);
  const [runFailure, setRunFailure] = useState<{ readonly requestKey: string; readonly message: string } | null>(
    null,
  );
  const [isRunning, setIsRunning] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // The stored result is keyed to the scope on screen: what the engine measured for one
  // source is never shown as the result for another.
  useEffect(() => {
    if (!scopeKey) return;
    let cancelled = false;

    fetchAudits()
      .then(async (history) => {
        const latest = history.audits.find((audit) => audit.scopeKey === scopeKey);
        return latest ? (await fetchAudit(latest.id)).report : null;
      })
      .then((report) => {
        if (!cancelled) setLoaded({ requestKey: scopeKey, report });
      })
      .catch(() => {
        // Audit history is a convenience; a failed load leaves the empty state, not an error.
        if (!cancelled) setLoaded({ requestKey: scopeKey, report: null });
      });

    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  const fresh = runResult?.requestKey === scopeKey ? runResult.report : null;
  const stored = loaded?.requestKey === scopeKey ? loaded.report : null;
  const report = fresh ?? stored;
  const isLoadingStored = scopeKey !== null && loaded?.requestKey !== scopeKey;
  const error = runFailure?.requestKey === scopeKey ? runFailure.message : null;

  const handleRun = useCallback(async () => {
    if (!selection || !scopeKey) return;
    setIsRunning(true);
    setRunFailure(null);
    setAnnouncement(`Measuring accessibility and layout for ${sourceLabel} at every viewport preset.`);
    try {
      const result = await createAudit({ selection });
      setRunResult({ requestKey: scopeKey, report: result.report });
      setAnnouncement(
        `Audit finished for ${sourceLabel}: ${
          result.report.verdict.status === "pass"
            ? "the policy passed"
            : result.report.verdict.status === "fail"
              ? "the policy failed"
              : "no verdict was evaluated"
        }.`,
      );
    } catch (caught) {
      setRunFailure({ requestKey: scopeKey, message: messageOf(caught, "The audit failed.") });
      setAnnouncement("The audit failed.");
    } finally {
      setIsRunning(false);
    }
  }, [scopeKey, selection, sourceLabel]);

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <section aria-label="Quality audit" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
        <header className="flex flex-col gap-2">
          <h2 className="label-caps">Quality audit</h2>
          <p className="max-w-prose text-[13px] leading-relaxed text-ink-soft">
            Measures the axe-core rule sets and layout overflow for {sourceLabel} at every viewport
            preset — desktop, tablet and mobile. The result is stored with its evidence: the
            screenshot each measurement was taken from.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" onClick={handleRun} disabled={selection === null || isRunning}>
            {isRunning ? (
              <>
                <LoaderCircle className="animate-spin" />
                Measuring viewports…
              </>
            ) : (
              <>
                <Play />
                Run quality audit
              </>
            )}
          </Button>
          {report && !isRunning ? (
            <span className="tabular font-mono text-[11px] text-ink-faint">
              {report.viewports.length} viewport{report.viewports.length === 1 ? "" : "s"} measured
            </span>
          ) : null}
        </div>

        {error ? (
          <Alert variant="regress">
            <TriangleAlert />
            <div className="flex flex-col gap-2">
              <AlertTitle>Audit failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </div>
          </Alert>
        ) : null}

        {isRunning ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton className="h-4 w-48 rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : report ? (
          <QualityPanel model={qualityModelFromReport(report)} />
        ) : isLoadingStored ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : null}
      </section>
    </>
  );
}
