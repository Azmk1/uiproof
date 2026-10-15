import { CreditCard, Lock, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export type FixtureVariant = "baseline" | "current";

const LINE_ITEMS = [
  { label: "Platform subscription", detail: "Oct 2026 · 12 seats", amount: "$960.00" },
  { label: "Usage overage", detail: "42.6k extra events", amount: "$180.00" },
  { label: "Priority support", detail: "Monthly add-on", amount: "$100.00" },
] as const;

/**
 * The screen under test. Both fixtures render this exact component; only the
 * `variant` prop differs, which guarantees the pixel diff contains nothing but
 * the deliberate regressions.
 */
function InvoiceSurface({ variant }: { readonly variant: FixtureVariant }) {
  const isCurrent = variant === "current";

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-6">
        {isCurrent ? (
          <span className="absolute top-0 right-0 rounded-bl-lg bg-attention-soft px-3 py-1 font-mono text-[11px] tracking-wide text-attention uppercase">
            Save 10%
          </span>
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className={isCurrent ? "text-2xl font-semibold tracking-tight" : "text-xl font-medium"}>
              Invoice summary
            </h1>
            <p className="mt-1.5 text-[13px] text-ink-soft">Invoice #INV-2049 · Due 12 Nov 2026</p>
          </div>
          <span className="shrink-0 rounded-md bg-surface-muted px-2 py-1 font-mono text-[11px] tracking-wide text-ink-soft uppercase">
            Draft
          </span>
        </div>

        <Separator className="my-5" />

        <ul className="flex flex-col gap-3.5">
          {LINE_ITEMS.map((item) => (
            <li key={item.label} className="flex items-baseline justify-between gap-4">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs text-ink-faint">{item.detail}</span>
              </span>
              <span className="tabular font-mono text-sm">{item.amount}</span>
            </li>
          ))}
        </ul>

        <Separator className="my-5" />

        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-soft">Total due</span>
          <span className="tabular font-mono text-2xl font-medium tracking-tight">
            {isCurrent ? "$1,204.00" : "$1,240.00"}
          </span>
        </div>

        <Button
          size="lg"
          className={
            isCurrent
              ? "mt-6 w-full rounded-xl bg-[oklch(0.45_0.19_275)] py-6 text-sm hover:bg-[oklch(0.4_0.19_275)]"
              : "mt-6 w-full rounded-xl bg-accent py-6 text-sm hover:bg-accent-strong"
          }
        >
          {isCurrent ? "Continue to payment" : "Continue"}
        </Button>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-ink-faint">
          <Lock className="size-3" />
          Encrypted with 256-bit TLS
        </p>
      </section>

      <aside className="flex flex-col gap-4">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
            <CreditCard className="size-3.5 text-ink-faint" />
            Payment method
          </h2>
          <dl className="mt-4 flex flex-col gap-3 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-soft">Card</dt>
              <dd className="font-mono">Visa •••• 4242</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-soft">Billing period</dt>
              <dd className="font-mono">Monthly</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-soft">Next charge</dt>
              <dd className="font-mono">12 Nov 2026</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-line bg-surface-muted p-5">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
            <Receipt className="size-3.5 text-ink-faint" />
            Need a copy?
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Receipts are emailed automatically after each charge and stay available for seven years.
          </p>
        </div>
      </aside>
    </div>
  );
}

export { InvoiceSurface };
