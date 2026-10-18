/**
 * The support page. It carries the fixture's two deliberate defects, and both are the kind
 * of thing a real review catches rather than a contrived marker:
 *
 *  1. the email field has visible text next to it that was never associated with it, which
 *     axe reports as a `label` violation on `#support-email` — the classic "the label is
 *     there, it just is not a label" defect;
 *  2. the activity log is a fixed 640px wide panel, which overflows the viewport at the
 *     mobile preset.
 *
 * `tests/markup.test.mjs` fails while either one is present, so the fixture's own test
 * command is a real gate over the patched source rather than a marker check.
 */
export function Home() {
  return (
    <main>
      <h1>Contact support</h1>
      <p>Tell us what happened and we will reply within one working day.</p>

      <form className="card">
        <label htmlFor="subject">Subject</label>
        <input id="subject" name="subject" type="text" />
        <span className="field-name">Email</span>
        <input id="support-email" name="email" type="email" />
        <button type="submit">Send</button>
      </form>

      <section className="log" aria-labelledby="log-heading">
        <h2 id="log-heading">Recent activity</h2>
        <table>
          <caption>Requests handled in the last hour</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Status</th>
              <th scope="col">Agent</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>SUP-1041</td>
              <td>Waiting on customer</td>
              <td>Ada</td>
            </tr>
            <tr>
              <td>SUP-1042</td>
              <td>Resolved</td>
              <td>Grace</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
}
