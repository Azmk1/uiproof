import type { Metadata } from "next";
import { FixtureShell } from "@/components/demo/fixture-shell";
import { InvoiceSurface } from "@/components/demo/invoice-surface";

export const metadata: Metadata = {
  title: "Fixture · baseline",
  description: "The reference version of the Acme Billing invoice screen.",
};

export default function BaselineFixturePage() {
  return (
    <FixtureShell variant="baseline">
      <InvoiceSurface variant="baseline" />
    </FixtureShell>
  );
}
