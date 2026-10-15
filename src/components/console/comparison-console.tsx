"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Lock, Play, ScanSearch, TriangleAlert } from "lucide-react";
import { ArtifactViewer } from "@/components/console/artifact-viewer";
import { RunHistory } from "@/components/console/run-history";
import { TargetPicker, ToleranceControl, ViewportPicker } from "@/components/console/run-controls";
import { VerdictPanel } from "@/components/console/verdict-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { createComparison, fetchCatalog, fetchReport, fetchReports } from "@/lib/api-client";
import { formatChangePercentage } from "@/lib/compare/metrics";
import type { CatalogResponse, ComparisonReport, ReportSummary } from "@/lib/compare/types";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function RunningState({ targetLabel }: { readonly targetLabel: string }) {
  return (
    <section aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" />
        <div className="flex flex-col">
          <h2 className="text-[13px] font-medium">Running comparison</h2>
          <p className="text-[12px] text-ink-soft">
            Launching Chromium, capturing both sides of {targetLabel} and diffing them pixel by pixel.
          </p>
        </div>
      </div>
      <Progress label="Comparison in progress" />
      <div className="grid gap-4 sm:grid-cols-3">
        {["Baseline", "Current", "Difference"].map((label) => (
          <div key={label} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="aspect-[16/10] w-full rounded-lg" />
            <span className="label-caps">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyState({ target }: { readonly target: CatalogResponse["targets"][number] | undefined }) {
  return (
    <section className="pixel-grid flex min-h-[420px] flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-line-strong bg-surface/70 p-8 text-center">
      <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl border border-line bg-surface">
        <ScanSearch className="size-5 text-ink-faint" />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">No comparison yet</h2>
        <p className="text-sm leading-relaxed text-ink-soft">
          Run the engine to render both fixtures in Chromium, diff them with pixelmatch and store the
          screenshots. Results persist, so a refresh keeps the last report on screen.
        </p>
      </div>
      {target ? (
        <div className="flex flex-col gap-2">
          <p className="tabular font-mono text-[11px] text-ink-faint">
            {target.baseline.path} → {target.current.path}
          </p>
          {target.expectedChanges.length > 0 ? (
            <ul className="mx-auto flex max-w-md flex-col gap-1 text-[11px] text-ink-faint">
              {target.expectedChanges.map((change) => (
                <li key={change}>· {change}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ComparisonConsole() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly ReportSummary[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [viewportId, setViewportId] = useState("desktop");
  const [maxDiffPercent, setMaxDiffPercent] = useState(0.1);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [loadingReportId, setLoadingReportId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [catalogResponse, reportsResponse] = await Promise.all([fetchCatalog(), fetchReports()]);
        if (cancelled) return;
        setCatalog(catalogResponse);
        setTargetId(catalogResponse.targets[0]?.id ?? null);
        setViewportId(catalogResponse.defaultViewportId);
        setMaxDiffPercent(catalogResponse.defaults.maxDiffPercent);
        setHistory(reportsResponse.reports);

        const latest = reportsResponse.reports[0];
        if (latest) {
          const stored = await fetchReport(latest.id);
          if (!cancelled) setReport(stored.report);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(messageOf(error, "The console could not load its catalogue."));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetchReports();
      setHistory(response.reports);
    } catch {
      /* history is a convenience — a failed refresh must not hide the fresh report */
    }
  }, []);

  const handleRun = useCallback(async () => {
    if (!targetId) return;
    const targetLabel = catalog?.targets.find((item) => item.id === targetId)?.label ?? "the fixtures";
    setIsRunning(true);
    setRunError(null);
    setAnnouncement(`Running comparison for ${targetLabel}.`);
    try {
      const result = await createComparison({ targetId, viewportId, maxDiffPercent });
      setReport(result);
      setAnnouncement(
        `${result.target.label}: ${
          result.status === "regression" ? "regression detected" : "no changes detected"
        }, ${formatChangePercentage(result.metrics.changePercentage, 3)}% of the viewport changed.`,
      );
      await refreshHistory();
    } catch (error) {
      setRunError(messageOf(error, "The comparison failed."));
      setAnnouncement("The comparison failed.");
    } finally {
      setIsRunning(false);
    }
  }, [catalog, maxDiffPercent, refreshHistory, targetId, viewportId]);

  const handleSelectReport = useCallback(async (id: string) => {
    setLoadingReportId(id);
    setRunError(null);
    try {
      const stored = await fetchReport(id);
      setReport(stored.report);
      setAnnouncement(`Loaded stored run from ${stored.report.createdAt}.`);
    } catch (error) {
      setRunError(messageOf(error, "That stored run could not be loaded."));
    } finally {
      setLoadingReportId(null);
    }
  }, []);

  const selectedTarget = catalog?.targets.find((item) => item.id === targetId);

  if (loadError) {
    return (
      <Alert variant="regress" className="mt-8">
        <TriangleAlert />
        <div className="flex flex-col gap-2">
          <AlertTitle>Console unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <Button variant="outline" size="sm" className="mt-1 w-fit" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,330px)_minmax(0,1fr)] lg:items-start">
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          <Card>
            <CardHeader>
              <CardTitle>Run a comparison</CardTitle>
              <CardDescription>
                Both sides are rendered at the same viewport, then diffed pixel by pixel.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {catalog ? (
                <>
                  <TargetPicker
                    targets={catalog.targets}
                    selectedId={targetId}
                    onSelect={setTargetId}
                    disabled={isRunning}
                  />
                  <ViewportPicker
                    viewports={catalog.viewports}
                    selectedId={viewportId}
                    onSelect={setViewportId}
                    disabled={isRunning}
                  />
                  <ToleranceControl
                    value={maxDiffPercent}
                    onChange={setMaxDiffPercent}
                    disabled={isRunning}
                  />
                </>
              ) : (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-16 w-full rounded-lg" />
                  <Skeleton className="h-9 w-full rounded-lg" />
                  <Skeleton className="h-9 w-full rounded-lg" />
                </div>
              )}

              <Button
                variant="accent"
                size="lg"
                className="w-full"
                onClick={handleRun}
                disabled={isRunning || !targetId}
              >
                {isRunning ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Capturing fixtures…
                  </>
                ) : (
                  <>
                    <Play />
                    Run comparison
                  </>
                )}
              </Button>

              {selectedTarget ? (
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  {selectedTarget.expectedOutcome}
                </p>
              ) : null}

              <p className="flex items-start gap-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
                <Lock className="mt-0.5 size-3 shrink-0" />
                Only the local <span className="font-mono">/demo</span> fixtures can be captured —
                absolute URLs are rejected by the engine.
              </p>
            </CardContent>
          </Card>

          <RunHistory
            reports={history}
            activeId={report?.id ?? null}
            loadingId={loadingReportId}
            onSelect={handleSelectReport}
          />
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          {runError ? (
            <Alert variant="regress">
              <TriangleAlert />
              <div className="flex flex-col gap-2">
                <AlertTitle>Comparison failed</AlertTitle>
                <AlertDescription>{runError}</AlertDescription>
                <Button variant="outline" size="sm" className="mt-1 w-fit" onClick={handleRun} disabled={isRunning}>
                  Try again
                </Button>
              </div>
            </Alert>
          ) : null}

          {isRunning ? (
            <RunningState targetLabel={selectedTarget?.label ?? "the fixtures"} />
          ) : report ? (
            <>
              <VerdictPanel report={report} />
              <ArtifactViewer report={report} />
            </>
          ) : (
            <EmptyState target={selectedTarget} />
          )}
        </div>
      </div>
    </>
  );
}
