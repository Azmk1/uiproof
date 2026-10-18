/**
 * The guard route: a second screen that is measured before and after every candidate so a
 * patch on the support page cannot quietly break something else. It is deliberately clean —
 * no accessibility findings, no overflow — so any change here is a regression the repair
 * should be rejected for.
 */
export function Settings() {
  return (
    <main>
      <h1>Notification settings</h1>
      <p>These apply to everybody on the support rota.</p>

      <form className="card">
        <fieldset>
          <legend>Email me when</legend>
          <label htmlFor="mentioned">
            <input id="mentioned" name="mentioned" type="checkbox" defaultChecked />
            I am mentioned in a ticket
          </label>
          <label htmlFor="handover">
            <input id="handover" name="handover" type="checkbox" />
            A ticket is handed to me
          </label>
        </fieldset>
        <button type="submit">Save settings</button>
      </form>
    </main>
  );
}
