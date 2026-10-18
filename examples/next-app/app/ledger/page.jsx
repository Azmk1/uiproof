/**
 * The ledger page. Its deliberate defect is a contrast failure: the summary line uses
 * `#9aa0a6` on white, which axe reports as a `color-contrast` violation on the page. This is
 * the second defect class the Next.js fixture contributes to the repair benchmark — a fix
 * that is a colour, not a structure.
 */
export default function LedgerPage() {
  return (
    <main>
      <h1>Ledger</h1>
      <p className="muted">Two invoices were raised this week.</p>

      <ul className="entries">
        <li>
          <strong>INV-2001</strong> — £1,240.00 — paid
        </li>
        <li>
          <strong>INV-2002</strong> — £318.50 — awaiting payment
        </li>
      </ul>
    </main>
  );
}
