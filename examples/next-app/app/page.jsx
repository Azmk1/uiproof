/**
 * The contact page. Its deliberate defect is the one this fixture is repaired for: the email
 * field has visible text beside it that was never associated with it, which axe reports as a
 * `label` violation on `#contact-email`. Everything else is a page somebody would actually
 * ship, so the repair has to be a real edit rather than a marker swap.
 *
 * The transaction table is also wider than a phone: a second, independent defect at the
 * mobile preset.
 */
export default function Page() {
  return (
    <main>
      <h1>Contact us</h1>
      <p>Send us a message and the team will get back to you.</p>

      <form className="card">
        <label htmlFor="contact-subject">Subject</label>
        <input id="contact-subject" name="subject" type="text" />
        <span className="field-name">Email</span>
        <input id="contact-email" name="email" type="email" />
        <button type="submit">Send message</button>
      </form>

      <section className="ledger" aria-labelledby="ledger-heading">
        <h2 id="ledger-heading">Recent transactions</h2>
        <table>
          <caption>Invoices raised this week</caption>
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>INV-2001</td>
              <td>£1,240.00</td>
              <td>Paid</td>
            </tr>
            <tr>
              <td>INV-2002</td>
              <td>£318.50</td>
              <td>Awaiting payment</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
}
