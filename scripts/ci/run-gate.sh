#!/usr/bin/env bash
#
# The pull-request gate: compare the application under test with a trusted approved baseline
# and fail when they differ.
#
# What this deliberately does NOT do
#
#   * It never captures a baseline. `capture` — and with it `--approve` — is not called
#     anywhere in this file, and the gate job has no step that does. A job that approves the
#     thing it is about to test can never fail; that defect is the reason this script exists.
#   * It never reads the baseline out of the working tree. The bundle is passed in with
#     `--bundle`, and the workflow extracts that directory from the pull request's *base*
#     branch, so a pull request cannot authorise its own visual change by editing
#     `examples/uiproof-baselines` in the same pull request. Whatever the working tree holds
#     is compared and reported by `trusted-baseline.sh`, then ignored.
#
# Loading the trusted bundle is not an approval: the images in it were approved before, by
# whoever ran the update process, and `--activate` only selects the version the bundle already
# records as active. No screenshot is taken of the application under test except the one the
# check compares — and that one is never allowed to become a reference.
#
# Usage
#   run-gate.sh --bundle <dir> [--store <dir>] [--artifacts <dir>] [--config <file>]
#               [--project <id>] [--route <id>] [--viewport <id>] [--tolerance <pct>]
#               [--app-cmd <cmd>] [--app-health <url>] [--app-env <KEY=VALUE>]
#               [--app-log <file>] [--no-app]
#
# Exit
#   the CLI's own code, because a CI job is the interface here:
#   0  the comparison passed        → the job succeeds
#   1  a visual regression          → the job fails
#   2  baseline, configuration, browser or infrastructure error → the job fails
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
run-gate.sh — gate the application under test against a trusted approved baseline

Usage
  run-gate.sh --bundle <dir> [options]

Options
  --bundle <dir>       Trusted approved baseline bundle to load (required)
  --store <dir>        Where the store is built      (default: .uiproof/ci-store)
  --artifacts <dir>    Where reports for the build  (default: .uiproof/ci-artifacts)
  --config <file>      Registration file             (default: examples/ci/uiproof.config.json)
  --project <id>       Registered project            (default: example-app)
  --route <id>         Registered route              (default: home)
  --viewport <id>      desktop | tablet | mobile     (default: desktop)
  --tolerance <pct>    Share of the viewport allowed to change (default: the CLI's 0.1)
  --app-cmd <cmd>      Command that starts the application under test
  --app-health <url>   Endpoint that answers when it is ready
  --app-env <K=V>      Extra environment for the application (repeatable, scrubbed by default)
  --app-log <file>     Where to keep the application's output
  --no-app             Do not start the application (a caller already did)
  --help               Show this help

Exit codes
  0  the comparison passed
  1  a visual regression was detected
  2  the check could not be answered
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

BUNDLE=""
STORE=""
ARTIFACTS=""
CONFIG="$UIPROOF_CONFIG_DEFAULT"
PROJECT="$UIPROOF_PROJECT_DEFAULT"
ROUTE=""
VIEWPORT="$UIPROOF_VIEWPORT_DEFAULT"
TOLERANCE=""
APP_CMD="$UIPROOF_APP_CMD_DEFAULT"
APP_HEALTH="$UIPROOF_APP_HEALTH_DEFAULT"
APP_ENV=""
APP_LOG=""
NO_APP=""

ci_parse_args "run-gate.sh" \
  "--bundle:BUNDLE" \
  "--store:STORE" \
  "--artifacts:ARTIFACTS" \
  "--config:CONFIG" \
  "--project:PROJECT" \
  "--route:ROUTE" \
  "--viewport:VIEWPORT" \
  "--tolerance:TOLERANCE" \
  "--app-cmd:APP_CMD" \
  "--app-health:APP_HEALTH" \
  "--app-env:APP_ENV*" \
  "--app-log:APP_LOG" \
  "--no-app:NO_APP!" \
  -- "$@"

[ -n "$BUNDLE" ] || ci_fail "run-gate.sh: --bundle <trusted bundle directory> is required."
[ -d "$BUNDLE" ] || ci_fail "run-gate.sh: the trusted bundle directory $BUNDLE does not exist."
[ -n "$ROUTE" ] || ROUTE="$UIPROOF_ROUTE_DEFAULT"
STORE="${STORE:-.uiproof/ci-store}"
ARTIFACTS="${ARTIFACTS:-.uiproof/ci-artifacts}"
export UIPROOF_APP_ENV="$APP_ENV"
export UIPROOF_APP_LOG="${APP_LOG:-$ARTIFACTS/app.log}"
export UIPROOF_APP_CMD="$APP_CMD"
export UIPROOF_APP_HEALTH="$APP_HEALTH"
export UIPROOF_GATE_PROJECT="$PROJECT"
export UIPROOF_GATE_ROUTE="$ROUTE"
export UIPROOF_GATE_VIEWPORT="$VIEWPORT"

# The store is rebuilt from the trusted bundle every time. Nothing that a previous run — or
# a pull request — could have left in it is allowed to reach this comparison.
rm -rf "$STORE"
mkdir -p "$STORE" "$ARTIFACTS"

trap 'ci_stop_app' EXIT

ci_heading "Rendering environment"
ci_info "image:      $UIPROOF_IMAGE"
ci_info "node:       $(node -v)"
ci_info "playwright: $(node -e 'process.stdout.write(require("playwright/package.json").version)')"
ci_info "chromium:   revision $UIPROOF_CHROMIUM_REVISION (from the image, $(fc-match -f '%{family}' system-ui 2>/dev/null || echo 'fonts unavailable') resolves system-ui)"

ci_heading "Gate"
ci_info "project:  $PROJECT · route $ROUTE · viewport $VIEWPORT"
ci_info "config:   $CONFIG"
ci_info "trusted:  $BUNDLE"
ci_info "store:    $STORE"

# ── 1 · The trusted reference ────────────────────────────────────────────────────────────
ci_heading "1 · Load the trusted approved baseline"
MANIFEST="$BUNDLE/uiproof-baselines.json"
[ -f "$MANIFEST" ] || ci_fail "run-gate.sh: $BUNDLE has no $(basename "$MANIFEST"); it is not a portable baseline bundle."
TRUSTED_VERSION="$(ci_bundle_active_version "$MANIFEST" "$PROJECT" "$ROUTE" "$VIEWPORT")"
[ -n "$TRUSTED_VERSION" ] ||
  ci_fail "run-gate.sh: the trusted bundle has no approved baseline for project \"$PROJECT\" route \"$ROUTE\" at $VIEWPORT."
ci_info "the bundle records $TRUSTED_VERSION as the approved reference for this scope"

IMPORT_STATUS=0
ci_run_capture "$ARTIFACTS/import.json" "$ARTIFACTS/import.log" \
  ci_uiproof baselines import --from "$BUNDLE" --activate \
  --config "$CONFIG" --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --storage "$STORE" --json || IMPORT_STATUS=$?
cat "$ARTIFACTS/import.log"
if [ "$IMPORT_STATUS" -ne 0 ]; then
  ci_error "the trusted baseline could not be loaded (exit $IMPORT_STATUS) — a tampered, missing or unreadable bundle stops the gate instead of passing it"
  cat "$ARTIFACTS/import.json"
  exit "$CI_INFRASTRUCTURE"
fi

IMPORTED_ADDED="$(ci_json_get "$ARTIFACTS/import.json" added)"
IMPORTED_ACTIVE="$(ci_json_get "$ARTIFACTS/import.json" scopes.0.activeVersionId)"
if [ "$IMPORTED_ACTIVE" != "$TRUSTED_VERSION" ]; then
  ci_error "the store activated $IMPORTED_ACTIVE, but the trusted bundle records $TRUSTED_VERSION — refusing to compare against an unknown reference"
  exit "$CI_INFRASTRUCTURE"
fi
ci_ok "loaded $IMPORTED_ADDED version(s); the active reference is $IMPORTED_ACTIVE (from the trusted bundle)"

# ── 2 · The application under test ───────────────────────────────────────────────────────
if [ -n "$NO_APP" ]; then
  ci_heading "2 · The application under test (started by the caller)"
  ci_info "assuming it is serving at $APP_HEALTH"
else
  ci_heading "2 · The application under test"
  ci_start_app
fi

# ── 3 · The check ────────────────────────────────────────────────────────────────────────
ci_heading "3 · The check"
CHECK_ARGS=(check --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" --config "$CONFIG" --storage "$STORE" --json)
if [ -n "$TOLERANCE" ]; then
  CHECK_ARGS+=(--tolerance "$TOLERANCE")
fi

STATUS=0
ci_run_capture "$ARTIFACTS/check.json" "$ARTIFACTS/check.log" ci_uiproof "${CHECK_ARGS[@]}" || STATUS=$?
cat "$ARTIFACTS/check.log"
ci_info "stdout (the one JSON document --json promises):"
sed 's/^/       /' "$ARTIFACTS/check.json"

REFERENCE="$(ci_json_get "$ARTIFACTS/check.json" baseline.versionId)"
CHANGE="$(ci_json_get "$ARTIFACTS/check.json" report.metrics.changePercentage)"
REPORT_PATH="$(ci_json_get "$ARTIFACTS/check.json" reportPath)"
REPORT_ID="$(ci_json_get "$ARTIFACTS/check.json" report.id)"

if [ "$REFERENCE" != "$TRUSTED_VERSION" ]; then
  ci_error "the run compared against ${REFERENCE:-nothing}, not the trusted reference $TRUSTED_VERSION — the gate cannot vouch for this result"
  exit "$CI_INFRASTRUCTURE"
fi
ci_ok "the run used the trusted reference $REFERENCE"

if [ -n "$CHANGE" ]; then
  ci_info "changed: ${CHANGE}% of the viewport (tolerance $(ci_json_get "$ARTIFACTS/check.json" tolerance)%)"
fi
if [ -n "$REPORT_PATH" ]; then
  ci_info "report:  $REPORT_PATH (baseline.png, current.png, diff.png, report.json)"
fi

# ── 4 · The verdict ──────────────────────────────────────────────────────────────────────
ci_heading "4 · Verdict"
VERDICT="$(ci_explain_code "$STATUS")"
case "$STATUS" in
  "$CI_PASS") ci_ok "exit $STATUS — $VERDICT" ;;
  "$CI_REGRESSION") ci_error "exit $STATUS — $VERDICT" ;;
  "$CI_INFRASTRUCTURE") ci_error "exit $STATUS — $VERDICT" ;;
  *) ci_error "exit $STATUS — the CLI reported a code this gate does not know" ;;
esac

node -e '
  const fs = require("node:fs");
  const [file, status, verdict, reference, change, reportId, reportPath] = process.argv.slice(1);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        gate: "uiproof-visual-regression",
        exitCode: Number(status),
        verdict,
        trustedReference: reference,
        changePercentage: change === "" ? null : Number(change),
        reportId,
        reportPath,
        renderingImage: process.env.UIPROOF_IMAGE ?? null,
        project: process.env.UIPROOF_GATE_PROJECT ?? null,
        route: process.env.UIPROOF_GATE_ROUTE ?? null,
        viewport: process.env.UIPROOF_GATE_VIEWPORT ?? null,
      },
      null,
      2,
    ) + "\n",
  );
' "$ARTIFACTS/gate-summary.json" "$STATUS" "$VERDICT" "$REFERENCE" "$CHANGE" "$REPORT_ID" "$REPORT_PATH"

ci_info "summary: $ARTIFACTS/gate-summary.json"

# A reviewer should be able to read the verdict without opening a log.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '## Visual regression gate — %s\n\n' "$(ci_explain_code "$STATUS")"
    printf '| | |\n| --- | --- |\n'
    printf '| exit code | `%s` — %s |\n' "$STATUS" "$(ci_explain_code "$STATUS")"
    printf '| reference | `%s` (from the trusted approved baseline) |\n' "$REFERENCE"
    printf '| changed | %s%% of the viewport (tolerance %s%%) |\n' "${CHANGE:-n/a}" "$(ci_json_get "$ARTIFACTS/check.json" tolerance)"
    printf '| run | `%s` — %s |\n' "$REPORT_ID" "$REPORT_PATH"
    printf '| rendered by | `%s` |\n\n' "$UIPROOF_IMAGE"
    printf 'Screenshots, diff and the comparison report are attached to this run as the `uiproof-gate` artifact.\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi

case "$STATUS" in
  "$CI_PASS" | "$CI_REGRESSION" | "$CI_INFRASTRUCTURE") exit "$STATUS" ;;
  *) exit "$CI_INFRASTRUCTURE" ;;
esac
