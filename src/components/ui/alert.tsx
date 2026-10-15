import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("flex gap-3 rounded-xl border p-4 text-sm [&>svg]:size-4 [&>svg]:shrink-0", {
  variants: {
    variant: {
      default: "border-line bg-surface text-ink",
      regress: "border-regress/30 bg-regress-soft text-regress",
      attention: "border-attention/40 bg-attention-soft text-attention",
      accent: "border-accent/30 bg-accent-soft text-accent-strong",
    },
  },
  defaultVariants: { variant: "default" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div role="alert" data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("font-semibold tracking-[-0.01em]", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-description" className={cn("text-ink-soft", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
