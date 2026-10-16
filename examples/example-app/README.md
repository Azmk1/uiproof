# Example application

A small web application that UIProof did not write: it is the "somebody else's app" the
Phase 3 integration test points UIProof at. It has no dependencies beyond Node, so it
starts in a second and can be read end to end in a minute.

```bash
node examples/example-app/server.mjs        # http://127.0.0.1:4173
PORT=4273 node examples/example-app/server.mjs
```

| Route       | What it is                                              |
| ----------- | ------------------------------------------------------- |
| `/`         | Overview: three metrics and a table of recent invoices   |
| `/settings` | A form with a billing contact and payment terms          |
| `/pricing`  | Two plan cards                                           |
| `/healthz`  | `{"ok":true}` — used to wait for the server to be ready  |
| `/moved`    | A 302 to `https://example.com/` — a deliberate redirect that leaves the registered origin |

Views and assets are read from disk on **every** request, so editing a file in `views/`
changes what the application renders on the next request. `views/home.changed.html` is a
deliberately modified overview screen (different revenue figures, a recoloured header
rule, two status changes); the integration test swaps it in and out to produce a real
visual regression and then a real recovery.

## Registering it with UIProof

Copy [`../uiproof.config.example.json`](../uiproof.config.example.json) to
`uiproof.config.json` in the repository root (or point `UIPROOF_PROJECTS_FILE` at it),
then start UIProof and pick the route in the console. The full walkthrough, including
what each field means and what is refused, is in the main
[README](../../README.md#testing-your-own-local-application).
