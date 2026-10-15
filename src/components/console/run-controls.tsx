"use client";

import { Ruler } from "lucide-react";
import type { ComparisonTarget, ViewportPreset } from "@/lib/compare/types";
import { cn } from "@/lib/utils";

interface TargetPickerProps {
  readonly targets: readonly ComparisonTarget[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}

export function TargetPicker({ targets, selectedId, onSelect, disabled = false }: TargetPickerProps) {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2 disabled:opacity-70">
      <legend className="label-caps">Target</legend>
      <div className="mt-1 flex flex-col gap-2">
        {targets.map((target) => {
          const selected = target.id === selectedId;
          return (
            <label
              key={target.id}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                selected
                  ? "border-accent bg-accent-soft/60"
                  : "border-line bg-surface hover:border-line-strong hover:bg-surface-muted",
              )}
            >
              <input
                type="radio"
                name="uiproof-target"
                value={target.id}
                checked={selected}
                onChange={() => onSelect(target.id)}
                className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[13px] font-medium">{target.label}</span>
                <span className="truncate font-mono text-[11px] text-ink-faint">
                  {target.baseline.path} → {target.current.path}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

interface ViewportPickerProps {
  readonly viewports: readonly ViewportPreset[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}

export function ViewportPicker({ viewports, selectedId, onSelect, disabled = false }: ViewportPickerProps) {
  const selected = viewports.find((preset) => preset.id === selectedId);

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="label-caps">Viewport</legend>
      <div className="mt-1 flex rounded-lg border border-line bg-surface-muted p-1">
        {viewports.map((preset) => {
          const isSelected = preset.id === selectedId;
          return (
            <label
              key={preset.id}
              className={cn(
                "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] tracking-wide uppercase transition-colors",
                isSelected
                  ? "bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
                  : "text-ink-soft hover:text-ink",
              )}
            >
              <input
                type="radio"
                name="uiproof-viewport"
                value={preset.id}
                checked={isSelected}
                onChange={() => onSelect(preset.id)}
                className="sr-only"
              />
              {preset.label}
            </label>
          );
        })}
      </div>
      {selected ? (
        <p className="tabular flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
          <Ruler className="size-3" />
          {selected.width} × {selected.height} · dpr {selected.deviceScaleFactor}
        </p>
      ) : null}
    </fieldset>
  );
}

interface ToleranceControlProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
}

export function ToleranceControl({ value, onChange, disabled = false }: ToleranceControlProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="uiproof-tolerance" className="label-caps">
          Tolerance
        </label>
        <output htmlFor="uiproof-tolerance" className="tabular font-mono text-[12px] text-ink">
          {value.toFixed(2)}%
        </output>
      </div>
      <input
        id="uiproof-tolerance"
        type="range"
        min={0}
        max={5}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        aria-describedby="uiproof-tolerance-hint"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line accent-[var(--accent)] disabled:cursor-not-allowed"
      />
      <p id="uiproof-tolerance-hint" className="text-[11px] leading-relaxed text-ink-faint">
        Changed pixels at or below this share of the viewport still pass. Anything above is reported
        as a regression.
      </p>
    </div>
  );
}
