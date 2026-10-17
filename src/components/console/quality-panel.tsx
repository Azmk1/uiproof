import { CircleCheckBig, CircleHelp, ExternalLink, ShieldQuestion, TriangleAlert } from "lucide-react";
import { MetaRow, MetricTile } from "@/components/console/verdict-panel";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/compare/metrics";
import { formatClockTime, formatDuration, formatRelativeTime } from "@/lib/format-time";
import { describePolicy } from "@/lib/quality/policy";
import { groupFindingsByImpact } from "@/lib/quality/presentation";
import type {
  FindingRow,
  ImpactGroup,
  QualityPanelEntry,
  QualityPanelModel,
} from "@/lib/quality/presentation";
import type { AxeImpact, ResponsiveFinding } from "@/lib/quality/types";
import { cn, shortId } from "@/lib/utils";

/**
 * The quality section of the dashboard: the measurements of one audit, laid out the way
 * the console lays out a run.
 *
 * Findings are grouped by impact (most severe first), layout results are grouped by the
 * viewport they were measured at, and every block links to the screenshot the numbers came
 * from. Everything on screen is a count of something the runner produced — there is no
 * score, and "needs review" results are shown as questions, never folded into the verdict.
 */

const IMPACT_LABELS: Record<AxeImpact | "unknown", string> = {
  critical: "Critical",
  serious: "Serious",
  moderate: "Moderate",
  minor: "Minor",
  unknown: "Unstated impact",
};

const SEVERE_IMPACTS: readonly (AxeImpact | "unknown")[] = ["critical", "serious"];

function countOf(violations: readonly ImpactGroup[], impact: AxeImpact | "unknown"): number {
  return violations.find((group) => group.impact === impact)?.rows.length ?? 0;
}

function engineLine(engine: QualityPanelModel["engine"]): string {
  if (!engine) return "—";
  const browser = engine.browser ?? "browser";
  return engine.totalMs === null ? browser : `${browser} · ${formatDuration(engine.totalMs)}`;
}

/** Viewport ids appear in findings; the panel shows the human label. */
function viewportLabelMap(entries: readonly QualityPanelEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.viewport.id, entry.viewport.label]));
}

function FindingItem({
  row,
  viewportLabel,
  isNew,
}: {
  readonly row: FindingRow;
  readonly viewportLabel: (id: string) => string;
  readonly isNew: boolean;
}) {
  return (
    <li className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <code className="rounded border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {row.finding.rule}
        </code>
        {isNew ? (
          <Badge variant="attention">
            <TriangleAlert />
            new
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {row.viewportIds.map(viewportLabel).join(" · ")}
        </span>
      </div>
      <p className="max-w-prose text-[12px] leading-relaxed text-ink-soft">
        {row.finding.summary.length > 0 ? row.finding.summary : row.finding.description}
      </p>
      <div className="flex flex-col gap-0.5 font-mono text-[11px] break-all text-ink-faint">
        <p>{row.finding.selector}</p>
        <p>{row.finding.html}</p>
      </div>
      <p className="text-[11px] text-ink-faint">
        <a
          href={row.finding.helpUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline-offset-2 hover:underline"
        >
          {row.finding.help}
        </a>
      </p>
    </li>
  );
}

function ImpactHeading({ group }: { readonly group: ImpactGroup }) {
  const severe = SEVERE_IMPACTS.includes(group.impact);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className={cn("size-2.5 rounded-[2px]", severe ? "bg-regress" : "bg-attention")} />
      <h4 className="font-mono text-[11px] tracking-wide uppercase text-ink">
        {IMPACT_LABELS[group.impact]} · {group.rows.length}
        <span className="text-ink-faint">{group.rows.length === 1 ? " finding" : " findings"}</span>
      </h4>
    </div>
  );
}

function EscapedRow({
  finding,
  contained,
}: {
  readonly finding: ResponsiveFinding;
  readonly contained: boolean;
}) {
  const side = finding.rect.x < 0 ? "left" : "right";
  return (
    <li className="flex flex-col gap-0.5 border-t border-line py-1.5 first:border-t-0">
      <p className="font-mono text-[11px] break-all text-ink-soft">{finding.selector}</p>
      <p className="text-[11px] text-ink-faint">
        {finding.overflowPx} px past the {side} edge
        {contained ? ` — inside ${finding.scrollContainer ?? "a deliberate scroller"}` : ""}
      </p>
    </li>
  );
}

function ViewportBlock({ entry }: { readonly entry: QualityPanelEntry }) {
  const { responsive, screenshot } = entry;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="font-mono text-[11px] tracking-wide uppercase text-ink">{entry.viewport.label}</h4>
        <span className="tabular font-mono text-[11px] text-ink-faint">
          {entry.viewport.width}×{entry.viewport.height}
        </span>
        {screenshot ? (
          <span className="tabular font-mono text-[11px] text-ink-faint">
            {formatBytes(screenshot.bytes)} screenshot
          </span>
        ) : null}
        {screenshot ? (
          <a
            href={screenshot.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex size-7 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
            aria-label={`Open the ${entry.viewport.label} screenshot this audit measured in a new tab`}
          >
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>

      <dl className="flex flex-col gap-1">
        <MetaRow label="Document overflow" value={`${responsive.documentOverflowPx} px`} />
        <MetaRow label="Elements measured" value={responsive.elementsMeasured.toLocaleString("en-US")} />
      </dl>

      {responsive.findings.length > 0 ? (
        <ul className="flex flex-col">
          {responsive.findings.map((finding) => (
            <EscapedRow key={`${finding.selector}-${finding.overflowPx}`} finding={finding} contained={false} />
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-faint">No element escapes this viewport.</p>
      )}

      {responsive.contained.length > 0 ? (
        <ul className="flex flex-col">
          {responsive.contained.map((finding) => (
            <EscapedRow key={`${finding.selector}-${finding.overflowPx}`} finding={finding} contained />
          ))}
        </ul>
      ) : null}

      {responsive.scrollableRegions.length > 0 ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {responsive.scrollableRegions.length} deliberate horizontal scroller
          {responsive.scrollableRegions.length === 1 ? "" : "s"} on this page — overflow inside
          one is a design decision, not a defect.
        </p>
      ) : null}
    </li>
  );
}

/**
 * One audit's measurements, for one page at one moment. A pass means this rule set found
 * nothing here — the panel says so, next to the verdict, so the number is never read as a
 * certificate.
 */
export function QualityPanel({ model }: { readonly model: QualityPanelModel }) {
  const { violations, review } = groupFindingsByImpact(model.entries);
  const viewportLabel = viewportLabelMap(model.entries);
  const labelFor = (id: string) => viewportLabel.get(id) ?? id;
  const layoutDefects = model.entries.reduce((total, entry) => total + entry.responsive.findings.length, 0);
  const hasReferences = model.references.length > 0;
  const isPass = model.verdict.status === "pass";
  const isFail = model.verdict.status === "fail";

  return (
    <section aria-label="Accessibility and layout" className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="label-caps">Accessibility &amp; layout</h2>
            {isPass ? (
              <Badge variant="pass">
                <CircleCheckBig />
                pass
              </Badge>
            ) : isFail ? (
              <Badge variant="regress">
                <TriangleAlert />
                fail
              </Badge>
            ) : (
              <Badge variant="neutral">
                <CircleHelp />
                not evaluated
              </Badge>
            )}
          </div>

          <p className="max-w-prose text-[13px] leading-relaxed text-ink-soft">{describePolicy(model.policy)}</p>

          {model.verdict.failures.length > 0 ? (
            <ul className="flex flex-col gap-1.5 rounded-lg border border-regress/30 bg-regress-soft/60 p-3">
              {model.verdict.failures.map((failure) => (
                <li key={failure.code} className="flex flex-col gap-0.5">
                  <p className="text-[12px] leading-relaxed text-ink">{failure.message}</p>
                  <p className="tabular text-[11px] text-ink-faint">{failure.count} finding(s) behind it</p>
                </li>
              ))}
            </ul>
          ) : null}

          {model.verdict.notes.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {model.verdict.notes.map((note) => (
                <li key={note}>
                  <p className="text-[11px] leading-relaxed text-ink-faint">{note}</p>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="flex max-w-prose items-start gap-2 text-[11px] leading-relaxed text-ink-faint">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              A clean scan is not a certification: it is what this rule set found, on this page, in this
              browser, at this moment.
            </span>
          </p>
        </div>

        <dl className="flex w-full shrink-0 flex-col gap-2 lg:w-[290px]">
          <MetaRow
            label="Rules"
            value={`axe-core ${model.engine?.axeVersion ?? ""} · ${(model.engine?.ruleSets ?? []).join(", ")}`}
            mono={false}
          />
          <MetaRow
            label="Viewports"
            value={model.entries.map((entry) => entry.viewport.label).join(", ")}
            mono={false}
          />
          <MetaRow label="Engine" value={engineLine(model.engine)} mono={false} />
          <MetaRow label={model.id ? "Audit" : "Run"} value={model.id ? shortId(model.id) : "this report"} />
          {model.createdAt ? (
            <MetaRow
              label="Audited"
              value={`${formatRelativeTime(model.createdAt)} · ${formatClockTime(model.createdAt)}`}
            />
          ) : null}
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-y-1 border-t border-line bg-surface-muted/60 px-5 sm:grid-cols-3 sm:divide-x sm:divide-line lg:grid-cols-6">
        <MetricTile
          label="Critical"
          value={countOf(violations, "critical").toLocaleString("en-US")}
          tone={countOf(violations, "critical") > 0 ? "regress" : "default"}
          hint="distinct findings"
        />
        <MetricTile
          label="Serious"
          value={countOf(violations, "serious").toLocaleString("en-US")}
          tone={countOf(violations, "serious") > 0 ? "regress" : "default"}
          hint="distinct findings"
        />
        <MetricTile
          label="Moderate"
          value={countOf(violations, "moderate").toLocaleString("en-US")}
          hint="distinct findings"
        />
        <MetricTile
          label="Minor"
          value={countOf(violations, "minor").toLocaleString("en-US")}
          hint="distinct findings"
        />
        <MetricTile
          label="Needs review"
          value={review.length.toLocaleString("en-US")}
          tone={review.length > 0 ? "attention" : "default"}
          hint="questions, not failures"
        />
        <MetricTile
          label="Layout defects"
          value={layoutDefects.toLocaleString("en-US")}
          tone={layoutDefects > 0 ? "attention" : "default"}
          hint="escaping the viewport"
        />
      </div>

      <div className="flex flex-col gap-6 p-5">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[13px] font-medium">Findings by impact</h3>
            <span className="text-[11px] text-ink-faint">
              one entry per rule and element, deduplicated across {model.entries.length}{" "}
              {model.entries.length === 1 ? "viewport" : "viewports"}
            </span>
          </div>

          {violations.length > 0 ? (
            <ul className="flex flex-col gap-4">
              {violations.map((group) => (
                <li key={group.impact} className="flex flex-col gap-1">
                  <ImpactHeading group={group} />
                  <ul className="flex flex-col">
                    {group.rows.map((row) => (
                      <FindingItem
                        key={row.fingerprint}
                        row={row}
                        viewportLabel={labelFor}
                        isNew={model.newFindingFingerprints.includes(row.fingerprint)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="max-w-prose rounded-lg border border-dashed border-line-strong bg-surface-muted/50 p-3 text-[12px] leading-relaxed text-ink-soft">
              This scan found nothing — which is not a certification. What it proves is that this rule
              set found nothing on this page, in this browser, at this moment.
            </p>
          )}
        </div>

        {review.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-[13px] font-medium">Needs a human look</h3>
              <span className="text-[11px] text-ink-faint">
                the runner could not decide these — they are never counted as failures
              </span>
            </div>
            <ul className="flex flex-col">
              {review.map((row) => (
                <FindingItem
                  key={row.fingerprint}
                  row={row}
                  viewportLabel={labelFor}
                  isNew={model.newFindingFingerprints.includes(row.fingerprint)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[13px] font-medium">Layout by viewport</h3>
            <span className="text-[11px] text-ink-faint">
              document overflow allowed up to {model.policy.maxDocumentOverflowPx} px, elements up to{" "}
              {model.policy.maxElementOverflowPx} px
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {model.entries.map((entry) => (
              <ViewportBlock key={entry.viewport.id} entry={entry} />
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <h3 className="label-caps">Baseline references</h3>
          {hasReferences ? (
            <p className="max-w-prose text-[11px] leading-relaxed text-ink-soft">
              Compared against {model.references.length} approved snapshot
              {model.references.length === 1 ? "" : "s"}: {model.newFindingFingerprints.length} new ·{" "}
              {model.knownFindingFingerprints.length} known · {model.resolvedFindingFingerprints.length}{" "}
              resolved.
            </p>
          ) : (
            <p className="max-w-prose text-[11px] leading-relaxed text-ink-soft">
              No approved baseline snapshot for this source, so which findings are new cannot be said
              here. Approve a baseline from a run and the next audit will mark new, known and resolved
              findings.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
