"use client";

import { useState } from "react";
import { Download, ExternalLink, Image, Layers, ScanEye } from "lucide-react";
import { DiffLegend } from "@/components/console/verdict-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes } from "@/lib/compare/metrics";
import type { ArtifactName, ComparisonReport } from "@/lib/compare/types";
import { cn } from "@/lib/utils";

const TABS = [
  { name: "baseline", label: "Baseline", icon: Image },
  { name: "current", label: "Current", icon: Layers },
  { name: "diff", label: "Difference", icon: ScanEye },
] as const;

const ALT_TEXT: Record<ArtifactName, string> = {
  baseline: "Baseline capture",
  current: "Current capture",
  diff: "Difference image",
};

export function ArtifactViewer({ report }: { readonly report: ComparisonReport }) {
  const [tab, setTab] = useState<ArtifactName>("diff");
  const [zoom, setZoom] = useState<"fit" | "full">("fit");

  const artifact = report.artifacts[tab];

  return (
    <section aria-label="Captured artifacts" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="label-caps">Screenshots</h2>
          <p className="tabular font-mono text-[11px] text-ink-faint">
            {artifact.width} × {artifact.height} · {formatBytes(artifact.bytes)} ·{" "}
            {artifact.url.split("/").slice(-1)[0]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Zoom"
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-muted p-1"
          >
            {(["fit", "full"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setZoom(option)}
                aria-pressed={zoom === option}
                className={cn(
                  // 11px type and a 24px-tall hit box: the previous 10px/py-1 pair sat 1px under
                  // the WCAG 2.2 target-size minimum.
                  "rounded-md px-2 py-1.5 font-mono text-[11px] tracking-wide uppercase transition-colors",
                  zoom === option ? "bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]" : "text-ink-soft hover:text-ink",
                )}
              >
                {option === "fit" ? "fit" : "1×"}
              </button>
            ))}
          </div>
          <a
            href={artifact.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex size-7 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
            aria-label={`Open ${ALT_TEXT[tab]} in a new tab`}
          >
            <ExternalLink className="size-3.5" />
          </a>
          <a
            href={artifact.url}
            download={artifact.url.split("/").slice(-1)[0]}
            className="inline-flex size-7 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
            aria-label={`Download ${ALT_TEXT[tab]}`}
          >
            <Download className="size-3.5" />
          </a>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ArtifactName)}>
        <TabsList aria-label="Screenshot to inspect">
          {TABS.map((item) => (
            <TabsTrigger key={item.name} value={item.name}>
              <item.icon />
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((item) => {
          const current = report.artifacts[item.name];
          return (
            <TabsContent key={item.name} value={item.name}>
              <div
                className={cn(
                  "checkerboard overflow-auto rounded-xl border border-line",
                  zoom === "fit" ? "max-h-[70vh]" : "max-h-[70vh]",
                )}
              >
                {/* Artifacts are dynamic, run-scoped PNGs served from the local API — next/image
                    optimisation would add no value here. */}
                <img
                  src={current.url}
                  alt={`${ALT_TEXT[item.name]} of ${report.target.label} at ${report.viewport.label} ${report.viewport.width}×${report.viewport.height}`}
                  width={current.width}
                  height={current.height}
                  className={cn("block h-auto", zoom === "fit" ? "w-full" : "max-w-none")}
                />
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      {tab === "diff" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted/60 p-3">
          <p className="text-[11px] leading-relaxed text-ink-soft">
            The difference image is generated by pixelmatch: changed pixels are painted red over a
            dimmed copy of the baseline so you can see both the change and its context.
          </p>
          <DiffLegend />
        </div>
      ) : (
        <p className="font-mono text-[11px] text-ink-faint">
          {tab === "baseline"
            ? `Source: ${report.target.baselinePath}`
            : `Source: ${report.target.currentPath}`}
        </p>
      )}
    </section>
  );
}
