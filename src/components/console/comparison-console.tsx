"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, LoaderCircle, Lock, Play, ScanSearch, TriangleAlert } from "lucide-react";
import { ArtifactViewer } from "@/components/console/artifact-viewer";
import { BaselinePanel } from "@/components/console/baseline-panel";
import { ComparisonTimeline } from "@/components/console/comparison-timeline";
import { ModePicker, VariantPicker } from "@/components/console/mode-picker";
import { QualityAuditCard } from "@/components/console/quality-audit-card";
import { QualityPanel } from "@/components/console/quality-panel";
import { RunHistory } from "@/components/console/run-history";
import { SourcePicker, ToleranceControl, ViewportPicker } from "@/components/console/run-controls";
import { VerdictPanel } from "@/components/console/verdict-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  activateBaselineVersion,
  approveBaseline,
  createComparison,
  fetchBaseline,
  fetchCatalog,
  fetchReport,
  fetchReports,
} from "@/lib/api-client";
import { formatChangePercentage } from "@/lib/compare/metrics";
import {
  defaultSelection,
  modeForSource,
  parseSourceId,
  resolveSource,
  sourceGroups,
  type SelectedSource,
  type SourceSelection,
} from "@/lib/compare/source-selection";
import type {
  BaselineManifest,
  CatalogResponse,
  ComparisonMode,
  ComparisonReport,
  ReportSummary,
} from "@/lib/compare/types";
import { qualityModelFromSection } from "@/lib/quality/presentation";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * The scope key a stored run belongs to. Phase 3 reports carry it; a Phase 1/2 report
 * predates projects and was always a demo target, so its key is derived the same way.
 */
function reportScopeKey(report: ComparisonReport): string {
  return report.source?.scopeKey ?? `demo:${report.target.id}`;
}

function RunningState({ sourceLabel }: { readonly sourceLabel: string }) {
  return (
    <section aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" />
        <div className="flex flex-col">
          <h2 className="text-[13px] font-medium">Running comparison</h2>
          <p className="text-[12px] text-ink-soft">
            Launching Chromium, capturing {sourceLabel} and diffing it pixel by pixel.
          </p>
        </div>
      </div>
      <Progress label="Comparison in progress" />
      <div className="grid gap-4 sm:grid-cols-3">
        {["Reference", "Current", "Difference"].map((label) => (
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

/** What a run would do, said in the terms of the mode that is selected. */
function EmptyState({
  source,
  mode,
}: {
  readonly source: SelectedSource | null;
  readonly mode: ComparisonMode;
}) {
  const title =
    mode === "capture"
      ? "No screenshot yet"
      : mode === "baseline"
        ? "No drift run yet"
        : "No comparison yet";
  const body =
    mode === "capture"
      ? "Capture this route once and store the screenshot. Approving it as the baseline is what turns the next capture into a drift verdict."
      : mode === "baseline"
        ? "Run the engine to capture the page again and diff it against the approved baseline. Drift, if any, shows up as a percentage and a highlighted image."
        : "Run the engine to render both fixtures in Chromium, diff them with pixelmatch and store the screenshots. Results persist, so a refresh keeps the last report on screen.";

  return (
    <section className="pixel-grid flex min-h-[420px] flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-line-strong bg-surface/70 p-8 text-center">
      <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl border border-line bg-surface">
        {mode === "capture" ? <Camera className="size-5 text-ink-faint" /> : <ScanSearch className="size-5 text-ink-faint" />}
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        <p className="text-sm leading-relaxed text-ink-soft">{body}</p>
      </div>
      {source ? (
        <div className="flex flex-col gap-2">
          <p className="tabular font-mono text-[11px] text-ink-faint">
            {mode === "fixture" && source.target
              ? `${source.target.baseline.path} → ${source.target.current.path}`
              : mode === "baseline"
                ? `approved baseline → ${source.path}`
                : `${source.origin ?? ""}${source.path}`}
          </p>
          {source.target && mode === "fixture" && source.target.expectedChanges.length > 0 ? (
            <ul className="mx-auto flex max-w-md flex-col gap-1 text-[11px] text-ink-faint">
              {source.target.expectedChanges.map((change) => (
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
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [viewportId, setViewportId] = useState("desktop");
  const [mode, setMode] = useState<ComparisonMode>("fixture");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [maxDiffPercent, setMaxDiffPercent] = useState(0.1);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [loadingReportId, setLoadingReportId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Baseline state is derived from a keyed record rather than set inside the fetching
  // effect: the request that resolves is matched against the source on screen, so a slow
  // answer for a previous source can never overwrite the current one.
  const [loadedBaseline, setLoadedBaseline] = useState<{
    readonly requestKey: string;
    readonly manifest: BaselineManifest | null;
    readonly error: string | null;
  } | null>(null);
  const [baselineMutationError, setBaselineMutationError] = useState<string | null>(null);
  const [baselineNotice, setBaselineNotice] = useState<string | null>(null);
  const [baselineAttempt, setBaselineAttempt] = useState(0);
  const [isApproving, setIsApproving] = useState(false);
  const [activatingVersionId, setActivatingVersionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [catalogResponse, reportsResponse] = await Promise.all([fetchCatalog(), fetchReports()]);
        if (cancelled) return;
        const firstSelection = defaultSelection(catalogResponse);
        const firstSource = firstSelection ? resolveSource(catalogResponse, firstSelection) : null;
        setCatalog(catalogResponse);
        setSelection(firstSelection);
        setViewportId(catalogResponse.defaultViewportId);
        setMode(firstSource?.defaultMode ?? catalogResponse.defaults.defaultMode);
        setVariantId(firstSource?.target?.defaultVariantId ?? null);
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

  const selectedSource = useMemo(
    () => (catalog && selection ? resolveSource(catalog, selection) : null),
    [catalog, selection],
  );
  const scopeKey = selectedSource?.scopeKey ?? null;
  const baselineRequestKey = `${scopeKey ?? "none"}/${viewportId}/${baselineAttempt}`;

  // The baseline is fetched per source/viewport pair, so switching either one always
  // shows the reference that the next run would actually use.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;

    fetchBaseline(selection, viewportId)
      .then((response) => {
        if (cancelled) return;
        setLoadedBaseline({ requestKey: baselineRequestKey, manifest: response.baseline, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadedBaseline({
          requestKey: baselineRequestKey,
          manifest: null,
          error: messageOf(error, "The baseline store could not be read."),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [baselineRequestKey, selection, viewportId]);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetchReports();
      setHistory(response.reports);
    } catch {
      /* history is a convenience — a failed refresh must not hide the fresh report */
    }
  }, []);

  const baselineSettled = loadedBaseline?.requestKey === baselineRequestKey;
  const baseline = baselineSettled && !loadedBaseline?.error ? (loadedBaseline?.manifest ?? null) : null;
  const baselineState: "loading" | "ready" | "error" = baselineMutationError
    ? "error"
    : baselineSettled
      ? loadedBaseline?.error
        ? "error"
        : "ready"
      : "loading";
  const baselineError = baselineMutationError ?? loadedBaseline?.error ?? null;

  const variants = selectedSource?.target?.variants ?? [];
  const hasBaseline = baseline !== null && baseline.activeVersionId !== null;

  const candidate = useMemo(() => {
    if (!report || !scopeKey) return null;
    if (reportScopeKey(report) !== scopeKey) return null;
    if (report.viewport.id !== viewportId) return null;
    return { id: report.id, createdAt: report.createdAt };
  }, [report, scopeKey, viewportId]);

  const timelineReports = useMemo(
    () => (scopeKey ? history.filter((item) => item.scopeKey === scopeKey && item.viewportId === viewportId) : []),
    [history, scopeKey, viewportId],
  );

  const selectSource = useCallback(
    (id: string) => {
      const next = parseSourceId(id);
      if (!next || !catalog) return;
      const resolved = resolveSource(catalog, next);
      if (!resolved) return;
      setSelection(next);
      setMode((current) => modeForSource(resolved, current));
      setVariantId(resolved.target?.defaultVariantId ?? null);
      setBaselineNotice(null);
    },
    [catalog],
  );

  const handleRun = useCallback(async () => {
    if (!selection || !selectedSource) return;
    setIsRunning(true);
    setRunError(null);
    setAnnouncement(`Running ${mode} for ${selectedSource.label}.`);
    try {
      const result = await createComparison({ selection, viewportId, maxDiffPercent, mode, variantId });
      setReport(result);
      setAnnouncement(
        `${result.target.label}: ${
          result.status === "regression"
            ? "regression detected"
            : result.status === "captured"
              ? "screenshot captured, nothing to compare against yet"
              : "no changes detected"
        }, ${formatChangePercentage(result.metrics.changePercentage, 3)}% of the viewport changed.`,
      );
      await refreshHistory();
    } catch (error) {
      setRunError(messageOf(error, "The comparison failed."));
      setAnnouncement("The comparison failed.");
    } finally {
      setIsRunning(false);
    }
  }, [maxDiffPercent, mode, refreshHistory, selectedSource, selection, variantId, viewportId]);

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

  const handleApprove = useCallback(
    async (sourceReportId: string) => {
      if (!selection || !selectedSource) return;
      setIsApproving(true);
      setBaselineNotice(null);
      setBaselineMutationError(null);
      setRunError(null);
      try {
        const response = await approveBaseline({ selection, viewportId, sourceReportId });
        setLoadedBaseline({ requestKey: baselineRequestKey, manifest: response.baseline, error: null });
        setBaselineNotice(`Approved ${response.version.id} from ${sourceReportId}.`);
        setAnnouncement(`Baseline approved for ${selectedSource.label} from run ${sourceReportId}.`);
      } catch (error) {
        setBaselineNotice(null);
        setBaselineMutationError(messageOf(error, "The baseline could not be approved."));
        setAnnouncement("The baseline could not be approved.");
      } finally {
        setIsApproving(false);
      }
    },
    [baselineRequestKey, selectedSource, selection, viewportId],
  );

  const handleActivate = useCallback(
    async (versionId: string) => {
      if (!selection) return;
      setActivatingVersionId(versionId);
      setBaselineNotice(null);
      setBaselineMutationError(null);
      try {
        const response = await activateBaselineVersion({ selection, viewportId, versionId });
        setLoadedBaseline({ requestKey: baselineRequestKey, manifest: response.baseline, error: null });
        setBaselineNotice(`New runs now compare against ${versionId}.`);
        setAnnouncement(`Restored baseline version ${versionId}.`);
      } catch (error) {
        setBaselineMutationError(messageOf(error, "That version could not be restored."));
      } finally {
        setActivatingVersionId(null);
      }
    },
    [baselineRequestKey, selection, viewportId],
  );

  const baselineBlockedReason =
    mode === "baseline" && baselineState === "ready" && !hasBaseline
      ? selectedSource?.kind === "project"
        ? "No approved baseline for this route yet. Capture it once, approve that screenshot, then run again."
        : "No approved baseline for this target and viewport yet. Run once in fixture mode, then approve that run."
      : null;
  const canRun = Boolean(selectedSource) && !isRunning && baselineBlockedReason === null;

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
                Pick a source, then let the engine capture and diff it pixel by pixel.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {catalog && selectedSource ? (
                <>
                  <SourcePicker
                    groups={sourceGroups(catalog)}
                    selectedId={selectedSource.scopeKey}
                    onSelect={selectSource}
                    disabled={isRunning}
                    configPath={catalog.projectConfigPath}
                    configError={catalog.projectConfigError}
                  />
                  <ModePicker
                    modes={selectedSource.modes}
                    selected={mode}
                    onSelect={(next) => {
                      setMode(next);
                      setBaselineNotice(null);
                    }}
                    disabled={isRunning}
                    blockedReason={baselineBlockedReason}
                  />
                  <VariantPicker
                    variants={variants}
                    selectedId={variantId ?? selectedSource.target?.defaultVariantId ?? ""}
                    onSelect={setVariantId}
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
              ) : catalog ? (
                <p className="rounded-lg border border-dashed border-line-strong bg-surface-muted/50 p-3 text-[12px] leading-relaxed text-ink-soft">
                  Nothing is available to capture. The compiled demo fixtures should always be here, so this
                  console build is probably incomplete.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-16 w-full rounded-lg" />
                  <Skeleton className="h-9 w-full rounded-lg" />
                  <Skeleton className="h-9 w-full rounded-lg" />
                </div>
              )}

              <Button variant="accent" size="lg" className="w-full" onClick={handleRun} disabled={!canRun}>
                {isRunning ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Capturing pages…
                  </>
                ) : (
                  <>
                    <Play />
                    Run comparison
                  </>
                )}
              </Button>

              {selectedSource?.target && mode === "fixture" ? (
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  {selectedSource.target.expectedOutcome}
                </p>
              ) : null}

              <p className="flex items-start gap-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
                <Lock className="mt-0.5 size-3 shrink-0" />
                <span>
                  Only the local demo fixtures and the loopback origins in your registration file can be
                  captured — a URL the file does not name is refused.
                </span>
              </p>
            </CardContent>
          </Card>

          {selectedSource ? (
            <BaselinePanel
              targetLabel={selectedSource.label}
              viewportLabel={catalog?.viewports.find((item) => item.id === viewportId)?.label ?? viewportId}
              state={baselineState}
              error={baselineError}
              manifest={baseline}
              candidate={candidate}
              busy={isApproving || activatingVersionId !== null}
              busyVersionId={activatingVersionId}
              notice={baselineNotice}
              onRetry={() => setBaselineAttempt((attempt) => attempt + 1)}
              onApprove={handleApprove}
              onActivate={handleActivate}
            />
          ) : null}

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
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleRun} disabled={!canRun}>
                    Try again
                  </Button>
                  {mode === "baseline" || mode === "capture" ? (
                    <Button variant="ghost" size="sm" onClick={() => setMode("fixture")}>
                      Switch to fixture mode
                    </Button>
                  ) : null}
                </div>
              </div>
            </Alert>
          ) : null}

          {isRunning ? (
            <RunningState sourceLabel={selectedSource?.label ?? "the page under test"} />
          ) : report ? (
            <>
              <VerdictPanel report={report} />
              {report.quality ? (
                <QualityPanel
                  model={qualityModelFromSection(
                    report.quality,
                    report.viewport,
                    report.artifacts.current
                      ? {
                          url: report.artifacts.current.url,
                          bytes: report.artifacts.current.bytes,
                          width: report.artifacts.current.width,
                          height: report.artifacts.current.height,
                        }
                      : null,
                  )}
                />
              ) : null}
              <ArtifactViewer report={report} />
            </>
          ) : (
            <EmptyState source={selectedSource} mode={mode} />
          )}

          <ComparisonTimeline
            reports={timelineReports}
            activeId={report?.id ?? null}
            tolerance={maxDiffPercent}
            targetLabel={selectedSource?.label ?? "the selected source"}
            viewportLabel={catalog?.viewports.find((item) => item.id === viewportId)?.label ?? viewportId}
            onSelect={handleSelectReport}
          />

          <QualityAuditCard selection={selection} sourceLabel={selectedSource?.label ?? "the selected source"} />
        </div>
      </div>
    </>
  );
}
