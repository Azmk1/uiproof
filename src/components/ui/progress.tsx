import { cn } from "@/lib/utils";

export interface ProgressProps extends React.ComponentProps<"div"> {
  /** 0–100. Omit for an indeterminate bar. */
  readonly value?: number;
  readonly label?: string;
}

/**
 * Thin progress meter. Renders a determinate bar when `value` is provided and
 * an animated indeterminate bar otherwise, keeping screen-reader semantics
 * intact in both modes.
 */
function Progress({ value, label, className, ...props }: ProgressProps) {
  const isDeterminate = typeof value === "number" && Number.isFinite(value);
  const clamped = isDeterminate ? Math.min(Math.max(value, 0), 100) : 0;

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={isDeterminate ? Math.round(clamped) : undefined}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-line", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-500 ease-out",
          !isDeterminate && "w-1/3 animate-[uiproof-slide_1.4s_ease-in-out_infinite]",
        )}
        style={isDeterminate ? { width: `${clamped}%` } : undefined}
      />
    </div>
  );
}

export { Progress };
