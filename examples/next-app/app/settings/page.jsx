/**
 * The guard route: measured before and after every candidate so a patch on the contact page
 * cannot quietly break a second screen. It is deliberately clean.
 */
export default function SettingsPage() {
  return (
    <main>
      <h1>Billing settings</h1>
      <p>Invoices are raised at the end of each month.</p>

      <form className="card">
        <fieldset>
          <legend>Notify me</legend>
          <label htmlFor="monthly">
            <input id="monthly" name="monthly" type="checkbox" defaultChecked />
            When an invoice is raised
          </label>
          <label htmlFor="overdue">
            <input id="overdue" name="overdue" type="checkbox" />
            When an invoice goes overdue
          </label>
        </fieldset>
        <button type="submit">Save</button>
      </form>
    </main>
  );
}
