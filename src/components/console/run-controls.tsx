"use client";

import { FolderGit2, Ruler, TriangleAlert } from "lucide-react";
import type { SourceGroup } from "@/lib/compare/source-selection";
import type { ViewportPreset } from "@/lib/compare/types";
import { cn } from "@/lib/utils";

interface SourcePickerProps {
  readonly groups: readonly SourceGroup[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
  /** Absolute path of the local registration file, or `null` when there is none. */
  readonly configPath: string | null;
  /** Set when the file exists but could not be used. */
  readonly configError: string | null;
}

/**
 * What to capture: the compiled demo fixtures, plus every route of every application
 * registered in the local configuration file. Both live in one radio group, so choosing
 * a source always changes exactly one thing, and the highlighted row is the one a run
 * would capture. Nothing here is free text: the console only ever sends an id from this
 * list back to the API, which resolves it against the same catalogue.
 */
export function SourcePicker({
  groups,
  selectedId,
  onSelect,
  disabled = false,
  configPath,
  configError,
}: SourcePickerProps) {
  const projectCount = groups.filter((group) => group.key !== "demo").length;

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2 disabled:opacity-70">
      <legend className="label-caps">Source</legend>
      <div className="mt-1 flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">{group.label}</span>
              {group.note ? (
                <span className="truncate font-mono text-[11px] text-ink-faint" title={group.note}>
                  {group.note}
                </span>
              ) : null}
            </div>
            {group.options.map((option) => {
              const selected = option.id === selectedId;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                    selected
                      ? "border-accent bg-accent-soft/60"
                      : "border-line bg-surface hover:border-line-strong hover:bg-surface-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="uiproof-source"
                    value={option.id}
                    checked={selected}
                    onChange={() => onSelect(option.id)}
                    className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-[13px] font-medium">{option.label}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint" title={option.hint}>
                      {option.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>

      {configError ? (
        <p className="flex items-start gap-2 rounded-lg border border-attention/30 bg-attention-soft/50 p-3 text-[11px] leading-relaxed text-ink">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
          <span>
            The project configuration could not be used, so no registered application can be captured:{' '}
            {configError}
          </span>
        </p>
      ) : null}

      {!configError && projectCount === 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface-muted/50 p-3 text-[11px] leading-relaxed text-ink-soft">
          <FolderGit2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
          <span>
            No local application is registered yet.{' '}
            {configPath ? (
              <>
                Add one to <span className="font-mono">{configPath}</span> and it appears here.
              </>
            ) : (
              <>Create a registration file and it appears here — the demo fixtures keep working.</>
            )}
          </span>
        </p>
      ) : null}
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
        /* h-6 + py-[9px] keeps a 24px pointer target (WCAG 2.2 target size) while
           bg-clip-content paints only the 6px track inside it, so the visible slider
           stays a hairline. */
        className="h-6 w-full cursor-pointer appearance-none rounded-full bg-line bg-clip-content py-[9px] accent-[var(--accent)] disabled:cursor-not-allowed"
      />
      <p id="uiproof-tolerance-hint" className="text-[11px] leading-relaxed text-ink-faint">
        Changed pixels at or below this share of the viewport still pass. Anything above is reported
        as a regression.
      </p>
    </div>
  );
}
