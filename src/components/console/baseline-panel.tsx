"use client";

import { useState } from "react";
import {
  Check,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/compare/metrics";
import type { BaselineManifest, BaselineVersion } from "@/lib/compare/types";
import { formatRelativeTime } from "@/lib/format-time";
import { cn, shortId } from "@/lib/utils";

export interface BaselineCandidate {
  readonly id: string;
  readonly createdAt: string;
}

interface BaselinePanelProps {
  readonly targetLabel: string;
  readonly viewportLabel: string;
  readonly state: "loading" | "ready" | "error";
  readonly error: string | null;
  readonly manifest: BaselineManifest | null;
  /** The run currently on screen, when it belongs to the selected target and viewport. */
  readonly candidate: BaselineCandidate | null;
  readonly busy: boolean;
  readonly busyVersionId: string | null;
  readonly notice: string | null;
  readonly onRetry: () => void;
  readonly onApprove: (reportId: string) => void;
  readonly onActivate: (versionId: string) => void;
}

function MetaRow({ label, value, mono = true }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="label-caps">{label}</dt>
      <dd className={cn("truncate text-[12px] text-ink-soft", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}

const MAX_VISIBLE_VERSIONS = 6;

export function BaselinePanel({
  targetLabel,
  viewportLabel,
  state,
  error,
  manifest,
  candidate,
  busy,
  busyVersionId,
  notice,
  onRetry,
  onApprove,
  onActivate,
}: BaselinePanelProps) {
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [confirmingVersionId, setConfirmingVersionId] = useState<string | null>(null);

  const active: BaselineVersion | null =
    manifest?.versions.find((version) => version.id === manifest.activeVersionId) ?? null;
  const versions = manifest ? [...manifest.versions].reverse() : [];
  const visibleVersions = versions.slice(0, MAX_VISIBLE_VERSIONS);

  return (
    <section
      aria-label="Approved baseline"
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="label-caps">Approved baseline</h2>
        <span className="font-mono text-[11px] text-ink-faint">
          {state === "loading" ? "loading…" : manifest ? `${manifest.versions.length} version${manifest.versions.length === 1 ? "" : "s"}` : "none"}
        </span>
      </header>

      {state === "loading" ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : null}

      {state === "error" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-regress/30 bg-regress-soft/60 p-3">
          <p className="flex items-start gap-2 text-[12px] text-ink">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-regress" />
            <span>{error ?? "The baseline store could not be read."}</span>
          </p>
          <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            <RotateCcw />
            Try again
          </Button>
        </div>
      ) : null}

      {state === "ready" && !manifest ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-line-strong bg-surface-muted/50 p-3">
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-ink">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
            <span>
              Nothing has been approved for {targetLabel} at {viewportLabel} yet. Drift detection needs a
              known-good reference: run a comparison, then approve its capture as the baseline.
            </span>
          </p>
        </div>
      ) : null}

      {state === "ready" && active ? (
        <div className="flex flex-col gap-3">
          <a
            href={active.imageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="checkerboard group relative block overflow-hidden rounded-lg border border-line"
            aria-label={`Open approved baseline image ${active.id} in a new tab`}
          >
            {/* Approved baselines are immutable PNGs served from the local API. */}
            <img
              src={active.imageUrl}
              alt={`Approved baseline of ${targetLabel} at ${viewportLabel}`}
              width={active.width}
              height={active.height}
              className="block h-auto w-full"
            />
            <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md border border-line bg-surface/95 px-1.5 py-1 font-mono text-[11px] text-ink-soft">
              <ExternalLink aria-hidden="true" className="size-3" />
              1×
            </span>
          </a>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent">
              <Check />
              active
            </Badge>
            <span className="font-mono text-[11px] text-ink-faint" title={active.id}>
              {shortId(active.id)}
            </span>
          </div>

          <dl className="flex flex-col gap-3">
            <MetaRow label="Approved" value={`${formatRelativeTime(active.approvedAt)} · ${active.approvedAt.slice(11, 19)} UTC`} />
            <MetaRow label="Source run" value={active.sourceReportId} />
            <MetaRow label="Captured" value={active.capturedRoute} />
            <MetaRow label="Image" value={`${active.width}×${active.height} · ${formatBytes(active.bytes)}`} />
          </dl>

          {active.note ? (
            <p className="rounded-md border border-line bg-surface-muted/60 px-2 py-1.5 text-[11px] text-ink-soft">
              {active.note}
            </p>
          ) : null}
        </div>
      ) : null}

      {state === "ready" ? (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          {confirmingApprove && candidate ? (
            <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft/50 p-3">
              <p className="text-[12px] leading-relaxed text-ink">
                Approve run {candidate.id} as a new baseline version for {targetLabel} at {viewportLabel}?
                {active ? " The current version stays in the history." : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="accent"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingApprove(false);
                    onApprove(candidate.id);
                  }}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
                  Yes, approve it
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingApprove(false)}>
                  <X />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                variant={active ? "outline" : "accent"}
                size="sm"
                className="w-full"
                disabled={busy || !candidate}
                onClick={() => setConfirmingApprove(true)}
              >
                {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
                {active ? "Approve this run as a new version" : "Approve this run as the baseline"}
              </Button>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {candidate
                  ? "Approval is explicit and versioned: nothing is overwritten, and a regression never approves itself."
                  : `Run a comparison of ${targetLabel} at ${viewportLabel} first — a baseline is always taken from a stored run.`}
              </p>
            </div>
          )}

          {notice ? (
            <p role="status" className="rounded-md border border-pass/30 bg-pass-soft/60 px-2 py-1.5 text-[11px] text-ink">
              {notice}
            </p>
          ) : null}

          {versions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="label-caps">Version history</h3>
              <ul role="list" className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
                {visibleVersions.map((version) => {
                  const isActive = version.id === manifest?.activeVersionId;
                  const isConfirming = confirmingVersionId === version.id;
                  const isBusy = busyVersionId === version.id;
                  return (
                    <li
                      key={version.id}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border px-2.5 py-2",
                        isActive ? "border-accent/40 bg-accent-soft/40" : "border-line bg-surface",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-ink-soft" title={version.id}>
                          {shortId(version.id)}
                        </span>
                        {isActive ? (
                          <Badge variant="accent">active</Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmingVersionId(isConfirming ? null : version.id)}
                          >
                            <RotateCcw />
                            Restore
                          </Button>
                        )}
                      </div>
                      <p className="font-mono text-[11px] text-ink-faint">
                        {formatRelativeTime(version.approvedAt)} · {version.width}×{version.height} ·{" "}
                        {formatBytes(version.bytes)}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-faint" title={version.capturedRoute}>
                        {version.capturedRoute} · from {version.sourceReportId}
                      </p>
                      {isConfirming ? (
                        <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-surface p-2">
                          <p className="text-[11px] leading-relaxed text-ink">
                            Compare new runs against this version again? Every run until the next change
                            will be diffed against it.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="accent"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setConfirmingVersionId(null);
                                onActivate(version.id);
                              }}
                            >
                              {isBusy ? <LoaderCircle className="animate-spin" /> : <Check />}
                              Restore it
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmingVersionId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {versions.length > MAX_VISIBLE_VERSIONS ? (
                <p className="text-[11px] text-ink-faint">
                  Showing the {MAX_VISIBLE_VERSIONS} newest of {versions.length} versions.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
