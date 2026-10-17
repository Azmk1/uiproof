"use client";

import { useCallback, useEffect, useState } from "react";
import { FileCode2, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { MetaRow } from "@/components/console/verdict-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createDiagnosis, fetchDiagnoses, fetchDiagnosis } from "@/lib/api-client";
import type {
  Diagnosis,
  DiagnosisAvailability,
  DiagnosisSummary,
  DiagnosedIssue,
  StaleSources,
} from "@/lib/diagnosis/types";
import { formatRelativeTime } from "@/lib/format-time";
import { shortId } from "@/lib/utils";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

const CONFIDENCE_TONE = { high: "neutral", medium: "neutral", low: "attention" } as const;

function MeasuredFacts({ issue }: { readonly issue: DiagnosedIssue }) {
  return (
    <dl className="flex flex-col gap-1">
      {issue.measured.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4">
          <dt className="label-caps">{fact.label}</dt>
          <dd className="max-w-[70%] text-right font-mono text-[11px] break-words text-ink-soft">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ModelAnswer({ issue }: { readonly issue: DiagnosedIssue }) {
  const answer = issue.diagnosis;
  if (!answer) {
    return (
      <p className="text-[12px] text-ink-faint">
        The model did not diagnose this issue. The measurement above stands on its own.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="attention">
          <Sparkles />
          model-generated
        </Badge>
        <Badge variant={CONFIDENCE_TONE[answer.confidence]}>
          {answer.confidence} confidence
        </Badge>
      </div>
      <p className="max-w-prose text-[13px] leading-relaxed text-ink">{answer.summary}</p>
      <div className="flex flex-col gap-1">
        <span className="label-caps">Likely cause</span>
        <p className="max-w-prose text-[12px] leading-relaxed text-ink-soft">{answer.likelyCause}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="label-caps">Suggested approach</span>
        <p className="max-w-prose text-[12px] leading-relaxed text-ink-soft">{answer.repairApproach}</p>
      </div>
      {answer.citedFacts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="label-caps">Facts it relied on</span>
          <ul className="flex flex-col gap-0.5">
            {answer.citedFacts.map((fact) => (
              <li key={fact} className="font-mono text-[11px] break-words text-ink-faint">
                · {fact}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {answer.uncertainty ? (
        <p className="rounded-lg border border-attention/30 bg-attention-soft px-3 py-2 text-[11px] leading-relaxed text-attention">
          Uncertainty the model stated: {answer.uncertainty}
        </p>
      ) : null}
      {answer.sources.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="label-caps">Source references (verified by UIProof)</span>
          <ul className="flex flex-col gap-1">
            {answer.sources.map((source) => (
              <li key={`${source.path}:${source.line ?? 0}`} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
                  <FileCode2 aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
                  {source.path}
                  {source.line === null ? "" : `:${source.line}`}
                </span>
                <span className="text-[11px] text-ink-faint">{source.why}</span>
                {source.lineText ? (
                  <code className="overflow-x-auto rounded border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
                    {source.lineText}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {answer.unverifiedSources.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-regress/30 bg-regress-soft/50 px-3 py-2">
          <span className="label-caps text-regress">Citations UIProof could not verify</span>
          <ul className="flex flex-col gap-1">
            {answer.unverifiedSources.map((source) => (
              <li key={`${source.path}:${source.line ?? 0}`} className="text-[11px] leading-relaxed text-ink-soft">
                <span className="font-mono">
                  {source.path}
                  {source.line === null ? "" : `:${source.line}`}
                </span>{" "}
                — {source.reason}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-faint">
            These were not shown to the model by UIProof, so treat them as a guess rather than a finding.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The AI diagnosis of one failed run or audit, and nothing else.
 *
 * Three separations are visible in the layout on purpose:
 *
 *  · **Measured facts come first**, straight from the report, and are shown for every issue
 *    even when the model had nothing useful to say about it.
 *  · **The model's words are labelled** — a `model-generated` badge, a confidence, its own
 *    uncertainty, and citations split into *verified by UIProof* (a path and line UIProof
 *    actually read and showed it) and *could not verify* (everything else, with the reason).
 *  · **No verdict appears here at all.** This panel never renders a pass or a fail; the
 *    verdict belongs to the measurements, and a diagnosis cannot change one.
 */
export function DiagnosisPanel({
  reportId,
  auditId,
  scopeKey,
  sourceLabel,
}: {
  readonly reportId: string | null;
  readonly auditId: string | null;
  readonly scopeKey: string | null;
  readonly sourceLabel: string;
}) {
  const targetKey = reportId ? `run:${reportId}` : auditId ? `audit:${auditId}` : null;

  const [history, setHistory] = useState<{
    readonly scopeKey: string;
    readonly diagnoses: readonly DiagnosisSummary[];
    readonly availability: DiagnosisAvailability;
  } | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly targetKey: string;
    readonly diagnosis: Diagnosis;
    readonly staleSources: StaleSources | null;
  } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!scopeKey) return;
    let cancelled = false;
    fetchDiagnoses(scopeKey)
      .then((response) => {
        if (!cancelled) setHistory({ scopeKey, ...response });
      })
      .catch(() => {
        // The panel degrades to "try it and see"; a failed history read is not an error state.
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!targetKey || !history || history.scopeKey !== scopeKey) return;
    const summary = history.diagnoses.find(
      (entry) => (reportId !== null && entry.reportId === reportId) || (auditId !== null && entry.auditId === auditId),
    );
    if (!summary) return;
    let cancelled = false;
    fetchDiagnosis(summary.id)
      .then((response) => {
        if (!cancelled) {
          setLoaded({ targetKey, diagnosis: response.diagnosis, staleSources: response.staleSources ?? null });
        }
      })
      .catch(() => {
        /* the stored diagnosis stays hidden rather than showing something stale */
      });
    return () => {
      cancelled = true;
    };
  }, [targetKey, history, scopeKey, reportId, auditId]);

  const diagnosis = loaded?.targetKey === targetKey ? loaded.diagnosis : null;
  const staleSources = loaded?.targetKey === targetKey ? loaded.staleSources : null;
  const availability = history?.availability ?? null;

  const handleDiagnose = useCallback(async () => {
    if (!targetKey) return;
    setIsRunning(true);
    setError(null);
    setAnnouncement(`Asking the configured model to explain ${sourceLabel}.`);
    try {
      const response = await createDiagnosis(reportId ? { reportId } : { auditId: auditId ?? "" });
      setLoaded({ targetKey, diagnosis: response.diagnosis, staleSources: null });
      setAnnouncement("Diagnosis stored. It does not change any verdict.");
    } catch (caught) {
      setError(messageOf(caught, "The diagnosis could not be produced."));
      setAnnouncement("The diagnosis could not be produced.");
    } finally {
      setIsRunning(false);
    }
  }, [auditId, reportId, sourceLabel, targetKey]);

  if (!targetKey) return null;

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <section
        aria-label="AI diagnosis"
        className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5"
      >
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="label-caps">AI diagnosis</h2>
            <Badge variant="neutral">
              <Sparkles />
              optional
            </Badge>
          </div>
          <p className="max-w-prose text-[13px] leading-relaxed text-ink-soft">
            Asks a configured model to explain the measurements above, using the source files it read
            from the registered directory. Every citation is checked against what the model was actually
            shown, and nothing here changes a verdict.
          </p>
        </header>

        {availability && !availability.configured ? (
          <Alert variant="attention">
            <TriangleAlert />
            <div className="flex flex-col gap-1">
              <AlertTitle>No model is configured</AlertTitle>
              <AlertDescription>
                {availability.reason ??
                  "Set UIPROOF_AI_API_KEY, UIPROOF_AI_BASE_URL and UIPROOF_AI_MODEL to enable AI diagnosis."}
                {availability.sourceRegistration === "missing"
                  ? ' The project also needs a "sourceDir" in uiproof.config.json before code can be investigated.'
                  : ""}
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="accent"
            onClick={handleDiagnose}
            disabled={isRunning || availability?.configured === false}
          >
            {isRunning ? (
              <>
                <LoaderCircle className="animate-spin" />
                Asking the model…
              </>
            ) : (
              <>
                <Sparkles />
                {diagnosis ? "Diagnose again" : "Explain this failure"}
              </>
            )}
          </Button>
          {availability?.configured ? (
            <span className="font-mono text-[11px] text-ink-faint">
              {availability.model} @ {availability.endpointHost}
            </span>
          ) : null}
        </div>

        {error ? (
          <Alert variant="regress">
            <TriangleAlert />
            <div className="flex flex-col gap-1">
              <AlertTitle>Diagnosis unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </div>
          </Alert>
        ) : null}

        {diagnosis ? (
          <div className="flex flex-col gap-5">
            {staleSources && (staleSources.stale.length > 0 || staleSources.missing.length > 0 || staleSources.reason) ? (
              <Alert variant="attention">
                <TriangleAlert />
                <div className="flex flex-col gap-1">
                  <AlertTitle>The source moved since this diagnosis</AlertTitle>
                  <AlertDescription>
                    {staleSources.reason ??
                      `${staleSources.stale.length} cited file(s) changed and ${staleSources.missing.length} can no longer be read. ` +
                        "The line numbers below refer to the bytes UIProof saw at the time, not to the file as it is now."}
                  </AlertDescription>
                </div>
              </Alert>
            ) : null}
            <dl className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted/40 p-3 lg:max-w-[420px]">
              <MetaRow label="Diagnosis" value={shortId(diagnosis.id)} />
              <MetaRow label="Model" value={`${diagnosis.model.model} @ ${diagnosis.model.endpointHost}`} />
              <MetaRow label="Asked" value={`${formatRelativeTime(diagnosis.createdAt)} · ${diagnosis.model.latencyMs} ms`} />
              <MetaRow
                label="Source read"
                value={`${diagnosis.filesRead.length} of ${diagnosis.filesScanned} file(s) in the registered directory`}
                mono={false}
              />
              <MetaRow label="Prompt" value={`${diagnosis.model.promptChars.toLocaleString("en-US")} characters`} />
            </dl>

            {diagnosis.issues.map((issue) => (
              <article key={issue.key} className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="label-caps">Measured</span>
                    <span className="text-[12px] font-medium">{issue.title}</span>
                  </div>
                  <MeasuredFacts issue={issue} />
                </div>
                <ModelAnswer issue={issue} />
              </article>
            ))}

            {diagnosis.warnings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="label-caps">The diagnosis says what it did not cover</span>
                <ul className="flex flex-col gap-0.5">
                  {diagnosis.warnings.map((warning) => (
                    <li key={warning} className="text-[11px] leading-relaxed text-ink-faint">
                      · {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-[11px] leading-relaxed text-ink-faint">
              Stored separately from the report it explains, in <code className="font-mono">diagnoses/</code>.
              Deleting it would not change a single pass or fail, and the model was shown only excerpts
              from the registered source directory — never another path on this machine.
            </p>
          </div>
        ) : null}
      </section>
    </>
  );
}
