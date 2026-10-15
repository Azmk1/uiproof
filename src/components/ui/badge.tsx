import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-line bg-surface-muted text-ink-soft",
        outline: "border-line-strong bg-transparent text-ink-soft",
        accent: "border-transparent bg-accent-soft text-accent-strong",
        pass: "border-transparent bg-pass-soft text-pass",
        regress: "border-transparent bg-regress-soft text-regress",
        attention: "border-transparent bg-attention-soft text-attention",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
