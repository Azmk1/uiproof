"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FlaskConical,
  LoaderCircle,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";
import { MetaRow } from "@/components/console/verdict-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchRepair, fetchRepairs, createRepair } from "@/lib/api-client";
import { formatDuration, formatRelativeTime } from "@/lib/format-time";
import type {
  RepairAttempt,
  RepairAvailability,
  RepairMeasurement,
  RepairPageMeasurement,
  RepairRun,
  RepairSummary,
  RepairVerification,
  RepairVerdict,
} from "@/lib/repair/types";
import { cn, shortId } from "@/lib/utils";

/**
 * The AI repair experiment for one failed run or audit.
 *
 * The layout keeps the three things this feature must never conflate visibly apart:
 *
 *  · **The proposal** — model output, labelled, with its own uncertainty.
 *  · **The measurements** — before and after, produced by the same audit engine the rest
 *    of the console uses; these are the only numbers on screen.
 *  · **The verdict** — `verified`, `partially-improved`, `rejected` or `unverified`,
 *    computed from those measurements. It is shown in the repair panel and nowhere else:
 *    no comparison status and no accessibility verdict changes because of a repair.
 *
 * Every attempt is shown, including the rejected ones and their evidence. A verified patch
 * is offered as a download for manual review; nothing is merged, committed or approved.
 */

const VERDICT_LABEL: Record<RepairVerdict, string> = {
  verified: "verified",
  "partially-improved": "partially improved",
  rejected: "rejected",
  unverified: "unable to verify",
};

const VERDICT_TONE: Record<RepairVerdict, "pass" | "attention" | "regress" | "neutral"> = {
  verified: "pass",
  "partially-improved": "attention",
  rejected: "regress",
  unverified: "neutral",
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function measurementLine(measurement: RepairMeasurement): string {
  return measurement.pages
    .map(
      (page) =>
        `${page.routeId}@${page.viewportId}: ${page.accessibility.violations} violation(s), ` +
        `${page.accessibility.serious + page.accessibility.critical} serious/critical, ` +
        `${page.layout.documentOverflowPx}px overflow` +
        (page.visual.status === "no-baseline" ? "" : `, ${page.visual.changePercentage}% vs baseline`),
    )
    .join(" · ");
}

function Diff({ text }: { readonly text: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-muted/60 p-3 font-mono text-[11px] leading-relaxed">
      <code>
        {text.split("\n").map((line, index) => (
          <span
            key={`${index}-${line.slice(0, 12)}`}
            className={cn(
              "block whitespace-pre",
              line.startsWith("+++") || line.startsWith("---")
                ? "text-ink-faint"
                : line.startsWith("+")
                  ? "text-pass"
                  : line.startsWith("-")
                    ? "text-regress"
                    : line.startsWith("@@")
                      ? "text-attention"
                      : "text-ink-soft",
            )}
          >
            {line.length === 0 ? " " : line}
          </span>
        ))}
      </code>
    </pre>
  );
}

function Checks({ verification }: { readonly verification: RepairVerification }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="label-caps">Deterministic verification</span>
      <ul className="flex flex-col gap-1">
        {verification.targets.map((target) => (
          <li key={target.issueKey} className="text-[11px] leading-relaxed">
            <span className="font-mono text-ink">{target.issueKey}</span>{" "}
            <span
              className={cn(
                target.status === "fixed" ? "text-pass" : target.status === "improved" ? "text-attention" : "text-ink-soft",
              )}
            >
              {target.status}
            </span>{" "}
            <span className="text-ink-faint">
              — {target.before} → {target.after}
            </span>
          </li>
        ))}
        {verification.regressions
          .filter((check) => check.status !== "clear")
          .map((check) => (
            <li key={`${check.kind}:${check.id}`} className="text-[11px] leading-relaxed">
              <span className="font-mono text-ink">{check.kind}</span>{" "}
              <span className={check.status === "regression" ? "text-regress" : "text-attention"}>{check.status}</span>{" "}
              <span className="text-ink-faint">— {check.detail}</span>
            </li>
          ))}
        {verification.build.map((command) => (
          <li key={command.name} className="text-[11px] leading-relaxed">
            <span className="font-mono text-ink">{command.name}</span>{" "}
            <span className={cn(command.status === "passed" ? "text-pass" : command.status === "failed" ? "text-regress" : "text-attention")}>
              {command.status}
            </span>{" "}
            <span className="text-ink-faint">
              — {command.command.length > 0 ? command.command.join(" ") : "not configured"}
              {command.reason ? ` (${command.reason})` : ""}
            </span>
          </li>
        ))}
      </ul>
      {verification.reasons.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {verification.reasons.map((reason) => (
            <li key={reason} className="text-[11px] leading-relaxed text-ink-soft">
              · {reason}
            </li>
          ))}
        </ul>
      ) : null}
      {verification.notes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {verification.notes.map((note) => (
            <li key={note} className="text-[11px] leading-relaxed text-ink-faint">
              · {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function pageKey(page: RepairPageMeasurement): string {
  return `${page.routeId}@${page.viewportId}`;
}

function Screenshots({ repair, attempt }: { readonly repair: RepairRun; readonly attempt: RepairAttempt }) {
  const after = attempt.verification?.after;
  if (!after) return null;
  const beforeByKey = new Map(repair.before.pages.map((page) => [pageKey(page), page] as const));
  const pages = after.pages.slice(0, 3);

  return (
    <div className="flex flex-col gap-2">
      <span className="label-caps">Before and after, measured in the sandbox</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {pages.map((page) => {
          const before = beforeByKey.get(pageKey(page));
          return (
            <figure key={pageKey(page)} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-muted/40 p-2">
              <figcaption className="font-mono text-[11px] text-ink-soft">
                {page.routeId} · {page.viewportLabel}
              </figcaption>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wide text-ink-faint uppercase">Before</span>
                  {before?.screenshot ? (
                    <img
                      src={`/api/repairs/${encodeURIComponent(repair.id)}/artifacts/${encodeURIComponent(before.screenshot)}`}
                      alt={`${page.routeId} at ${page.viewportLabel} before the patch`}
                      className="w-full rounded border border-line bg-white"
                    />
                  ) : null}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wide text-ink-faint uppercase">After</span>
                  {page.screenshot ? (
                    <img
                      src={`/api/repairs/${encodeURIComponent(repair.id)}/artifacts/${encodeURIComponent(page.screenshot)}`}
                      alt={`${page.routeId} at ${page.viewportLabel} after the patch`}
                      className="w-full rounded border border-line bg-white"
                    />
                  ) : null}
                </div>
              </div>
              {page.diff ? (
                <img
                  src={`/api/repairs/${encodeURIComponent(repair.id)}/artifacts/${encodeURIComponent(page.diff)}`}
                  alt={`Difference against the approved baseline for ${page.routeId} at ${page.viewportLabel}`}
                  className="w-full rounded border border-line bg-white"
                />
              ) : null}
            </figure>
          );
        })}
      </div>
    </div>
  );
}

function AttemptCard({ repair, attempt }: { readonly repair: RepairRun; readonly attempt: RepairAttempt }) {
  const proposal = attempt.proposal;
  return (
    <article className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-caps">Attempt {attempt.attempt}</span>
        <Badge variant={VERDICT_TONE[attempt.verdict]}>{VERDICT_LABEL[attempt.verdict]}</Badge>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {attempt.model ? `${attempt.model.latencyMs} ms model · ` : ""}
          {formatDuration(attempt.durationMs)}
        </span>
      </div>

      {attempt.rejection ? (
        <p className="rounded-lg border border-regress/30 bg-regress-soft/40 px-3 py-2 text-[11px] leading-relaxed text-regress">
          Refused before a verdict: {attempt.rejection}
        </p>
      ) : null}

      {proposal ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-[11px] text-ink">{proposal.issueKey}</span>
            <span className="text-[12px] font-medium">{proposal.title}</span>
            <Badge variant="attention">model-generated</Badge>
            <Badge variant="neutral">{proposal.confidence} confidence</Badge>
          </div>
          <p className="max-w-prose text-[12px] leading-relaxed text-ink">{proposal.summary}</p>
          <p className="max-w-prose text-[11px] leading-relaxed text-ink-soft">{proposal.explanation}</p>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Expected: {proposal.expectedImprovement}
            {proposal.uncertainty ? ` · Uncertainty it stated: ${proposal.uncertainty}` : ""}
          </p>
          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-ink-soft">
            {proposal.files.map((file) => (
              <span key={file.path} className="rounded border border-line bg-surface-muted px-1.5 py-0.5">
                {file.path} +{file.additions}/−{file.deletions}
              </span>
            ))}
          </div>
          <Diff text={proposal.patch} />
          {attempt.patchArtifact ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a
                  href={`/api/repairs/${encodeURIComponent(repair.id)}/patch?attempt=${attempt.attempt}`}
                  download={`uiproof-${repair.id}-attempt-${attempt.attempt}.patch`}
                >
                  <Download />
                  Download this attempt&apos;s patch
                </a>
              </Button>
              <span className="text-[11px] text-ink-faint">
                {attempt.verdict === "verified"
                  ? "Verified by measurement; review it and apply it yourself."
                  : "Kept as evidence. It was rejected and is not a recommended change."}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {attempt.verification ? (
        <>
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-muted/40 p-3">
            <span className="label-caps">Measured</span>
            <p className="font-mono text-[11px] leading-relaxed text-ink-soft">before: {measurementLine(attempt.verification.before)}</p>
            {attempt.verification.after ? (
              <p className="font-mono text-[11px] leading-relaxed text-ink-soft">after: {measurementLine(attempt.verification.after)}</p>
            ) : null}
          </div>
          <Checks verification={attempt.verification} />
          <Screenshots repair={repair} attempt={attempt} />
        </>
      ) : null}
    </article>
  );
}

export function RepairPanel({
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
  const targetKind = reportId ? "report" : "audit";
  const targetId = reportId ?? auditId;
  const targetKey = targetId ? `${targetKind}:${targetId}` : null;

  const [history, setHistory] = useState<{
    readonly scopeKey: string;
    readonly repairs: readonly RepairSummary[];
    readonly availability: RepairAvailability;
  } | null>(null);
  const [loaded, setLoaded] = useState<{ readonly targetKey: string; readonly repair: RepairRun } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState<1 | 2>(2);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!scopeKey) return;
    let cancelled = false;
    fetchRepairs(scopeKey)
      .then((response) => {
        if (!cancelled) setHistory({ scopeKey, ...response });
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!targetId || !history || history.scopeKey !== scopeKey) return;
    const summary = history.repairs.find(
      (entry) => entry.targetKind === targetKind && entry.targetId === targetId,
    );
    if (!summary) return;
    let cancelled = false;
    fetchRepair(summary.id)
      .then((response) => {
        if (!cancelled) setLoaded({ targetKey: targetKey ?? summary.id, repair: response.repair });
      })
      .catch(() => {
        /* the stored repair stays hidden rather than showing something stale */
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, targetKind, targetKey, history, scopeKey]);

  const repair = loaded?.targetKey === targetKey ? loaded.repair : null;
  const availability = history?.availability ?? null;

  const handleRepair = useCallback(async () => {
    if (!targetId) return;
    setIsRunning(true);
    setError(null);
    setAnnouncement(`Proposing a repair for ${sourceLabel}. It runs only in an isolated copy.`);
    try {
      const response = await createRepair({
        ...(reportId ? { reportId } : { auditId: auditId ?? "" }),
        maxAttempts,
      });
      setLoaded({ targetKey: targetKey ?? response.repair.id, repair: response.repair });
      const verified = response.repair.status === "verified";
      setAnnouncement(
        verified
          ? "A patch was verified by measurement. It is available for review; nothing was applied to your source."
          : `The repair was ${VERDICT_LABEL[response.repair.status]}. Every attempt is recorded.`,
      );
      fetchRepairs(scopeKey ?? undefined)
        .then((next) => setHistory({ scopeKey: scopeKey ?? "", ...next }))
        .catch(() => undefined);
    } catch (caught) {
      setError(messageOf(caught, "The repair could not be run."));
      setAnnouncement("The repair could not be run.");
    } finally {
      setIsRunning(false);
    }
  }, [auditId, maxAttempts, reportId, scopeKey, sourceLabel, targetId, targetKey]);

  if (!targetKey) return null;

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <section aria-label="AI repair" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="label-caps">AI repair</h2>
            <Badge variant="neutral">
              <FlaskConical />
              isolated experiment
            </Badge>
            <Badge variant="outline">
              <ShieldCheck />
              never applied to your tree
            </Badge>
          </div>
          <p className="max-w-prose text-[13px] leading-relaxed text-ink-soft">
            Asks a configured model for a narrowly scoped patch, applies it to a disposable copy of the
            registered source, and re-runs the same accessibility, layout and visual measurements plus the
            project&apos;s build and tests. A patch is only called verified when those measurements say so — and
            this panel never changes the comparison or audit verdict above.
          </p>
        </header>

        {availability && !availability.configured ? (
          <Alert variant="attention">
            <TriangleAlert />
            <div className="flex flex-col gap-1">
              <AlertTitle>Repair is not configured</AlertTitle>
              <AlertDescription>
                {availability.reason ??
                  "A repair needs a model, a source directory, and a sandbox with build and test commands."}
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" onClick={handleRepair} disabled={isRunning || availability?.configured === false}>
            {isRunning ? (
              <>
                <LoaderCircle className="animate-spin" />
                Patching an isolated copy…
              </>
            ) : (
              <>
                <FlaskConical />
                {repair ? "Try another repair" : "Propose and verify a repair"}
              </>
            )}
          </Button>
          <label className="flex items-center gap-2 text-[11px] text-ink-soft">
            Attempts
            <select
              value={maxAttempts}
              onChange={(event) => setMaxAttempts(event.target.value === "1" ? 1 : 2)}
              disabled={isRunning}
              className="h-8 rounded-md border border-line-strong bg-surface px-2 font-mono text-[11px]"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
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
              <AlertTitle>Repair unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </div>
          </Alert>
        ) : null}

        {isRunning ? (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong bg-surface-muted/40 p-3 text-[11px] leading-relaxed text-ink-soft">
            <p>
              Copying the registered source into a temporary checkout, measuring the unmodified page, then
              measuring the candidate. The original directory is read-only during this.
            </p>
            <p className="flex items-center gap-1.5 text-ink-faint">
              <LoaderCircle className="size-3 animate-spin" />
              Chromium is capturing the sandbox; this can take a minute.
            </p>
          </div>
        ) : null}

        {repair ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={VERDICT_TONE[repair.status]}>
                <ShieldQuestion />
                {VERDICT_LABEL[repair.status]}
              </Badge>
              {repair.status === "verified" ? (
                <span className="text-[11px] text-pass">
                  Safe to review: every target defect disappeared, nothing measured regressed, and build and tests passed.
                </span>
              ) : (
                <span className="text-[11px] text-ink-faint">
                  No verified patch. Every attempt below is kept with its measured evidence.
                </span>
              )}
            </div>

            <dl className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted/40 p-3 lg:max-w-[520px]">
              <MetaRow label="Repair" value={shortId(repair.id)} />
              <MetaRow label="Asked" value={formatRelativeTime(repair.createdAt)} />
              <MetaRow
                label="Revision"
                value={
                  repair.revision.commitSha
                    ? `${repair.revision.commitSha.slice(0, 12)}${repair.revision.dirty ? " (dirty)" : ""}`
                    : "no Git repository"
                }
              />
              <MetaRow label="Pinned files" value={`${repair.revision.digestFiles} file(s), digest ${repair.revision.digest.slice(0, 12)}…`} />
              <MetaRow
                label="Original tree"
                value={repair.originalUnchanged ? "unchanged — digest identical after the run" : "CHANGED during the run"}
                mono={false}
              />
              <MetaRow label="Attempts" value={`${repair.attempts.length} of ${repair.limits.maxAttempts} allowed`} />
              {repair.model ? <MetaRow label="Model" value={`${repair.model.model} @ ${repair.model.endpointHost}`} /> : null}
            </dl>

            {repair.warnings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="label-caps">What this run says it did not cover</span>
                <ul className="flex flex-col gap-0.5">
                  {repair.warnings.map((warning) => (
                    <li key={warning} className="text-[11px] leading-relaxed text-ink-faint">
                      · {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-muted/40 p-3">
              <span className="label-caps">Baseline measured before any proposal</span>
              <p className="font-mono text-[11px] leading-relaxed text-ink-soft">{measurementLine(repair.before)}</p>
            </div>

            <div className="flex flex-col gap-4">
              {repair.attempts.map((attempt) => (
                <AttemptCard key={attempt.attempt} repair={repair} attempt={attempt} />
              ))}
            </div>

            <p className="text-[11px] leading-relaxed text-ink-faint">
              Stored in <code className="font-mono">repairs/</code>: the record, every attempt&apos;s patch and the
              before/after screenshots. The sandbox is deleted when the run ends. Applying a verified patch is a
              manual action — UIProof never merges, commits or approves a baseline from here.
            </p>
          </div>
        ) : null}
      </section>
    </>
  );
}
