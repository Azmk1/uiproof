import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FixtureVariant } from "@/components/demo/invoice-surface";

const NAV_ITEMS = ["Overview", "Invoices", "Payment methods", "Docs"] as const;

/**
 * Application frame shared by both fixtures. Everything here is identical
 * between the two versions except the deliberate differences listed in
 * `COMPARISON_TARGETS` — today that is the dropped "Docs" navigation item.
 */
function FixtureShell({
  variant,
  children,
}: {
  readonly variant: FixtureVariant;
  readonly children: React.ReactNode;
}) {
  const isCurrent = variant === "current";
  const navItems = isCurrent ? NAV_ITEMS.filter((item) => item !== "Docs") : NAV_ITEMS;

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-6 px-6">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-ink" />
            Acme Billing
          </span>
          <nav aria-label="Fixture navigation" className="hidden items-center gap-5 text-[13px] sm:flex">
            {navItems.map((item, index) => (
              <span
                key={item}
                className={cn(index === 1 ? "font-medium text-ink" : "text-ink-soft")}
                aria-current={index === 1 ? "page" : undefined}
              >
                {item}
              </span>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-ink-faint sm:inline">Jordan Reyes</span>
            <span aria-hidden="true" className="size-7 rounded-full bg-surface-muted ring-1 ring-line-strong" />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] flex-1 px-6 py-7">{children}</main>

      <footer className="mx-auto flex w-full max-w-[1120px] items-center gap-3 px-6 pb-6 text-[11px] text-ink-faint">
        <span className="font-mono">acme-billing · demo fixture</span>
        <Link
          href="/"
          className="ml-auto inline-flex items-center gap-1 text-ink-soft underline-offset-2 hover:underline"
        >
          <ArrowLeft className="size-3" />
          Back to UIProof
        </Link>
      </footer>
    </div>
  );
}

export { FixtureShell };
