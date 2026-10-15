import { cn } from "@/lib/utils";

interface BrandMarkProps {
  readonly className?: string;
}

/**
 * Nine-pixel grid: seven "unchanged" pixels and two highlighted ones, echoing
 * the difference images the engine produces.
 */
const CELLS = [1, 1, 1, 1, 0, 1, 1, 1, 2] as const;

const CELL_STYLES: Record<(typeof CELLS)[number], string> = {
  0: "bg-paper",
  1: "bg-paper/45",
  2: "bg-attention",
};

function BrandMark({ className }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-6 shrink-0 grid-cols-3 grid-rows-3 gap-px rounded-[6px] bg-ink p-[3px]", className)}
    >
      {CELLS.map((cell, index) => (
        <span key={index} className={cn("rounded-[1px]", CELL_STYLES[cell])} />
      ))}
    </span>
  );
}

export { BrandMark };
