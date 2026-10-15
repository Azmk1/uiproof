import { cn } from "@/lib/utils";

function Separator({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="separator" data-slot="separator" className={cn("h-px w-full bg-line", className)} {...props} />;
}

export { Separator };
