import type { Metadata } from "next";
import { FixtureShell } from "@/components/demo/fixture-shell";
import { InvoiceSurface } from "@/components/demo/invoice-surface";

export const metadata: Metadata = {
  title: "Fixture · current",
  description: "The same Acme Billing screen with deliberate visual regressions.",
};

export default function CurrentFixturePage() {
  return (
    <FixtureShell variant="current">
      <InvoiceSurface variant="current" />
    </FixtureShell>
  );
}
