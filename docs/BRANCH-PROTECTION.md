# Branch protection and the trust boundary

A workflow cannot protect itself. Everything in this document is a repository setting that has to be
configured by hand in GitHub — the workflows, scripts and tests in this repository *depend* on these
settings being in place, and without them both gates are signals rather than blocks. The settings are
short; the reasoning behind them is the rest of this file, because "which check do I require?" is
only answerable once you know what each job proves and what it does not.

## What to configure

**Settings → Branches → Branch protection rule for `main` (and any other base branch the gates run
on):**

| Setting | Value | Why |
| ------- | ----- | --- |
| Require status checks to pass | `gate · trusted baseline` **and** `gate · accessibility and layout` | These are the two job names that actually decide something. A red check must block the merge instead of merely being visible. |
| Require branches to be up to date before merging | on | The checker and the reference are read from the base branch. A stale branch is judged against a base revision that no longer exists. |
| Require a pull request before merging | on | Direct pushes to `main` skip review of the very files in this document. |
| Require review from Code Owners | on | Turns [CODEOWNERS](../.github/CODEOWNERS) from routing into a requirement. |
| Dismiss stale pull request approvals when new commits are pushed | on | An approval of an earlier revision is not an approval of the checker change that followed it. |
| Restrict who can push to matching branches | maintainers only | The base branch is the trust anchor; anything that can write to it can write the verdict. |
| Do not allow bypassing the above settings | on | Administrators included. The exception is what makes every other line optional in practice. |
| Require conversation resolution before merging | optional | Useful, not load-bearing. |

**Settings → Actions → General:**

| Setting | Value | Why |
| ------- | ----- | --- |
| Workflow permissions | Read repository contents | Both gates already declare `permissions: contents: read`; this makes it the ceiling. |
| Allow GitHub Actions to create and approve pull requests | off | Nothing here needs it, and it is the shortest path to a workflow approving its own change. |

The baseline **update** workflow (`baseline-update.yml`) is `workflow_dispatch`-only for the same
reason: it produces a bundle for a human to review and commit, and it cannot be reached from a pull
request.

## What each gate actually protects

### `visual-regression.yml` — `gate · trusted baseline`

- Reference: the approved bundle at `examples/uiproof-baselines`, extracted with `git archive` from
  the pull request's base branch. The pull request's own copy is compared to it, reported, and
  ignored.
- Application under test: the pull request's working tree, started with a scrubbed environment
  (`env -i`), bound to loopback.
- Verdict: the comparison's own exit code. `0` passes; `1` (a real visual difference) and `2`
  (missing or tampered baseline, unreachable application, browser failure) both fail the job.
- It never captures and never approves — a unit test asserts that the workflow contains neither.

### `quality-gate.yml` — `gate · accessibility and layout`

- Reference line: the same trusted bundle from the base branch, when the base commit has one. Its
  accessibility snapshots become the "new / known / resolved" reference. Without one the full policy
  runs and the report states that no reference exists.
- Application under test: the pull request's working tree at `/support`, audited at desktop, tablet
  and mobile with real Chromium and real axe-core.
- Verdict: `uiproof audit`'s exit code, mapped by `scripts/ci/audit-gate.sh`. `0` passes; `1` (an
  accessibility violation at `serious` or above, or layout escaping the viewport) fails; `2` (the
  scanner could not run, the browser could not start, the store failed) fails as infrastructure. A
  gate can never be green because the check did not run.
- It never approves anything, and it refuses `--new-only` unless a trusted bundle actually imported
  an accessibility reference in that run.
- The audit JSON, one screenshot per viewport, the failure evidence and the application log are
  uploaded whether the audit passed or failed.

## The trust boundary, stated precisely

When `quality-gate.yml` runs, two revisions are live at once:

| | Revision | Trust |
| --- | --- | --- |
| Application under test | the pull request's working tree | untrusted by design — that is what is being reviewed. Runs with `env -i`, no secrets, loopback only. |
| Checker: `src/`, `scripts/`, the registration file | extracted from the base branch by `scripts/ci/trusted-checker.sh` (`git archive`) and run from there via `UIPROOF_CLI_DIR` | trusted — a pull request cannot edit the policy engine, the scanner wrapper, the gate script or the route list that judges it. |
| Pinned rendering environment | `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a…` | pinned by tag **and** digest; checked by `src/lib/ci/pinned-environment.test.ts`. |
| Installed dependencies (`node_modules`) | installed from the pull request's lockfile | **inside the trust boundary.** The extracted checker resolves its dependencies from the workspace. |
| `.github/workflows/`, `scripts/`, `src/`, `package.json`, `pnpm-lock.yaml`, `examples/uiproof-baselines/` | — | review-routed by CODEOWNERS; they change the checker or the reference line. |

### What that does *not* buy you

- **Dependency changes.** A pull request that edits `pnpm-lock.yaml` can change the code the checker
  runs — `axe-core`, `playwright`, `pixelmatch`, `pngjs` and everything else are resolved from the
  workspace. CODEOWNERS routes those files to review; a fully hermetic answer is a separate install
  of the base revision's lockfile, which is the next step rather than a claim this build makes.
  The provenance file `trusted-checker.txt` says so in the run's own artifacts.
- **A compromised runner or container registry.** The digest pins the bytes; who publishes them is
  outside this repository's control.
- **The application under test.** It is pull request code. It is sandboxed (scrubbed environment,
  loopback origins, captured network restricted to registered origins) but it is not interpreted by
  a security boundary — a page can still consume time, memory and CPU on the runner.
- **Anything reached outside the workflow.** Both gates hold `contents: read` and use no secrets, but
  a repository that adds one to another workflow is on its own for that workflow.

## How to verify the boundary is doing something

Reproduce it, rather than trusting this document:

```bash
# Extract the checker from a ref and look at what the gate will run.
bash scripts/ci/trusted-checker.sh --from-ref HEAD --into /tmp/uiproof-checker \
  --link-node-modules "$PWD/node_modules" --provenance /tmp/trusted-checker.txt
cat /tmp/trusted-checker.txt

# Run the audit gate from that copy, against the scratch application.
UIPROOF_CLI_DIR=/tmp/uiproof-checker \
  bash /tmp/uiproof-checker/scripts/ci/audit-gate.sh \
  --store /tmp/uiproof-store --artifacts /tmp/uiproof-artifacts \
  --config examples/ci/uiproof.config.json \
  --project example-app --route support --no-app   # if the app is already running

# Every documented answer, in order, with real Chromium and axe-core.
bash scripts/ci/quality-walkthrough.sh
```

The walkthrough asserts the clean pass, the introduced violation, the introduced mobile overflow, the
desktop-only approval that does not authorise mobile, the exported/imported reference, the
68-finding page whose serious violation sorts past the display cap, the scanner-refusing page that is
an infrastructure failure, and the restore — see `scripts/ci/quality-walkthrough.sh`.

## Related documents

- [BASELINE-UPDATES.md](BASELINE-UPDATES.md) — how an approved baseline is produced, reviewed and
  committed, and the provenance a bundle carries.
- [GOAL.md](GOAL.md) — the mission this gate exists to serve.
