/**
 * The inbox page. Its deliberate defect is a contrast failure: the summary line is rendered
 * in `#9aa0a6` on white, which axe reports as a `color-contrast` violation. The fix is a
 * colour the page can actually be read in — not a structural change, which is why this is a
 * useful second defect class for the repair benchmark.
 */
export function Inbox() {
  return (
    <main>
      <h1>Inbox</h1>
      <p className="muted">3 conversations are waiting for a first reply.</p>

      <ul className="threads">
        <li>
          <strong>SUP-1050</strong> — Refund not received
        </li>
        <li>
          <strong>SUP-1051</strong> — Cannot reset password
        </li>
        <li>
          <strong>SUP-1052</strong> — Invoice address change
        </li>
      </ul>
    </main>
  );
}
