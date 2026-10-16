"use client";

import { GitCompareArrows, ShieldCheck } from "lucide-react";
import type { ComparisonMode, ComparisonTarget, FixtureVariantOption } from "@/lib/compare/types";
import { cn } from "@/lib/utils";

const MODE_COPY: Record<ComparisonMode, { label: string; description: string; icon: typeof ShieldCheck }> = {
  fixture: {
    label: "Fixture pair",
    description: "Capture the paired baseline route and the page under test, then diff the two fixtures.",
    icon: GitCompareArrows,
  },
  baseline: {
    label: "Approved baseline",
    description: "Capture the page under test and diff it against the baseline you approved — drift detection.",
    icon: ShieldCheck,
  },
};

interface ModePickerProps {
  readonly target: ComparisonTarget;
  readonly selected: ComparisonMode;
  readonly onSelect: (mode: ComparisonMode) => void;
  readonly disabled?: boolean;
  /** Set when the selected mode cannot run yet, e.g. no approved baseline for this pair. */
  readonly blockedReason?: string | null;
}

export function ModePicker({ target, selected, onSelect, disabled = false, blockedReason = null }: ModePickerProps) {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2 disabled:opacity-70">
      <legend className="label-caps">Comparison mode</legend>
      <div className="mt-1 flex flex-col gap-2">
        {target.modes.map((mode) => {
          const copy = MODE_COPY[mode];
          const isSelected = mode === selected;
          const isBlocked = isSelected && blockedReason !== null;
          return (
            <label
              key={mode}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                isSelected
                  ? "border-accent bg-accent-soft/60"
                  : "border-line bg-surface hover:border-line-strong hover:bg-surface-muted",
              )}
            >
              <input
                type="radio"
                name="uiproof-mode"
                value={mode}
                checked={isSelected}
                onChange={() => onSelect(mode)}
                className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  <copy.icon aria-hidden="true" className="size-3.5 text-ink-faint" />
                  {copy.label}
                </span>
                <span className="text-[11px] leading-relaxed text-ink-faint">{copy.description}</span>
                {isBlocked ? (
                  <span className="text-[11px] leading-relaxed text-attention">{blockedReason}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

interface VariantPickerProps {
  readonly variants: readonly FixtureVariantOption[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}

/**
 * Page state. Each state is a separate allow-listed route, so switching it is how a
 * deliberate page change (and the revert) is reproduced without editing source.
 */
export function VariantPicker({ variants, selectedId, onSelect, disabled = false }: VariantPickerProps) {
  if (variants.length < 2) return null;

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="label-caps">Page state</legend>
      <div className="mt-1 flex flex-col gap-2">
        {variants.map((variant) => {
          const isSelected = variant.id === selectedId;
          return (
            <label
              key={variant.id}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                isSelected
                  ? "border-accent bg-accent-soft/60"
                  : "border-line bg-surface hover:border-line-strong hover:bg-surface-muted",
              )}
            >
              <input
                type="radio"
                name="uiproof-variant"
                value={variant.id}
                checked={isSelected}
                onChange={() => onSelect(variant.id)}
                className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[13px] font-medium">{variant.label}</span>
                <span className="truncate font-mono text-[11px] text-ink-faint">{variant.route}</span>
                <span className="text-[11px] leading-relaxed text-ink-faint">{variant.summary}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
