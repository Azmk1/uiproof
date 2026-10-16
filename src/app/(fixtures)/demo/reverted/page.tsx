import type { Metadata } from "next";
import { FixtureShell } from "@/components/demo/fixture-shell";
import { InvoiceSurface } from "@/components/demo/invoice-surface";

export const metadata: Metadata = {
  title: "Fixture · reverted",
  description: "The invoice screen with the deliberate regressions reverted.",
};

/**
 * The invoice screen once the shipped changes are reverted.
 *
 * It exists so a drift walkthrough — and the browser test suite — can change what the
 * page under test renders without editing source: approve a baseline from `/demo/current`,
 * switch the page state to `/demo/reverted`, and the next run reports a real regression.
 * Both routes are static, so each state captures identically run to run.
 */
export default function RevertedFixturePage() {
  return (
    <FixtureShell variant="baseline">
      <InvoiceSurface variant="baseline" />
    </FixtureShell>
  );
}
