#!/usr/bin/env bash
#
# The walkthrough: every answer the CLI is supposed to give, asserted in the pinned rendering
# environment, with real captures of the example application.
#
# This is a *demonstration and an integration test*, not the quality gate. The gate is
# `run-gate.sh`, which is a real gate: it lets a regression fail the job. Here a nonzero exit
# code is an expected result that the script checks, which is exactly what you want from a
# walkthrough and exactly what you must never have in a gate. The two are deliberately
# separate files (and separate workflows) so that neither can be mistaken for the other.
#
# What it proves, in order:
#
#   1  an unchanged application passes with 0
#   2  a real change to the application's view fails with 1
#   3  a pull request cannot authorise its own change: with the repository's own bundle
#      rewritten to match the changed UI — capture, approve and export, the full self-service
#      path — the gate still answers 1, against the committed reference
#   4  restoring the view passes again with 0
#   5  a missing approved baseline is 2, not a pass and not a regression
#   6  a tampered baseline image is 2: integrity is checked, not trusted
#   7  an unreachable application is 2: the gate reports what it could not do
#
# Usage
#   walkthrough.sh --bundle <trusted bundle dir> [--trusted-ref <ref>] [options]
#
# Exit
#   0  every scenario produced the answer it was supposed to
#   1  at least one scenario did not (the log names it)
#   2  the walkthrough itself could not run
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
walkthrough.sh — assert every CLI exit code against the example application

Usage
  walkthrough.sh --bundle <dir> [options]

Options
  --bundle <dir>       Trusted bundle to compare against (required)
  --trusted-ref <ref>  Re-extract that bundle from this git commit for scenario 3, to show
                       the committed tree is what a gate reads. Without it, --bundle is used.
  --artifacts <dir>    Where reports and logs land   (default: .uiproof/ci-artifacts)
  --stores <dir>       Parent of the scratch stores  (default: .uiproof/ci-stores)
  --config <file>      Registration file             (default: examples/ci/uiproof.config.json)
  --project <id>       Registered project            (default: example-app)
  --route <id>         Registered route              (default: home)
  --viewport <id>      desktop | tablet | mobile     (default: desktop)
  --view <file>        The application's view for the route (default: views/home.html)
  --changed-view <f>   The changed version of that view (default: views/home.changed.html)
  --bundle-path <dir>  The repository's own bundle, rewritten in scenario 3
                       (default: examples/uiproof-baselines)
  --app-cmd <cmd>      Command that starts the application under test
  --app-health <url>   Endpoint that answers when it is ready
  --help               Show this help

Exit codes
  0  every scenario matched · 1 a scenario did not · 2 the walkthrough could not run
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

BUNDLE=""
TRUSTED_REF=""
ARTIFACTS=""
STORES=""
CONFIG="$UIPROOF_CONFIG_DEFAULT"
PROJECT="$UIPROOF_PROJECT_DEFAULT"
ROUTE=""
VIEWPORT="$UIPROOF_VIEWPORT_DEFAULT"
VIEW="examples/example-app/views/home.html"
CHANGED_VIEW="examples/example-app/views/home.changed.html"
BUNDLE_PATH="$UIPROOF_BUNDLE_PATH_DEFAULT"
APP_CMD="$UIPROOF_APP_CMD_DEFAULT"
APP_HEALTH="$UIPROOF_APP_HEALTH_DEFAULT"

ci_parse_args "walkthrough.sh" \
  "--bundle:BUNDLE" \
  "--trusted-ref:TRUSTED_REF" \
  "--artifacts:ARTIFACTS" \
  "--stores:STORES" \
  "--config:CONFIG" \
  "--project:PROJECT" \
  "--route:ROUTE" \
  "--viewport:VIEWPORT" \
  "--view:VIEW" \
  "--changed-view:CHANGED_VIEW" \
  "--bundle-path:BUNDLE_PATH" \
  "--app-cmd:APP_CMD" \
  "--app-health:APP_HEALTH" \
  -- "$@"

[ -n "$BUNDLE" ] || ci_fail "walkthrough.sh: --bundle <trusted bundle directory> is required."
[ -d "$BUNDLE" ] || ci_fail "walkthrough.sh: the bundle directory $BUNDLE does not exist."
[ -f "$VIEW" ] || ci_fail "walkthrough.sh: the view $VIEW does not exist."
[ -f "$CHANGED_VIEW" ] || ci_fail "walkthrough.sh: the changed view $CHANGED_VIEW does not exist."
[ -n "$ROUTE" ] || ROUTE="$UIPROOF_ROUTE_DEFAULT"
ARTIFACTS="${ARTIFACTS:-.uiproof/ci-artifacts}"
STORES="${STORES:-.uiproof/ci-stores}"

export UIPROOF_APP_CMD="$APP_CMD"
export UIPROOF_APP_HEALTH="$APP_HEALTH"
export UIPROOF_APP_LOG="$ARTIFACTS/app.log"

rm -rf "$STORES"
mkdir -p "$STORES" "$ARTIFACTS"

# Scenario 3 rewrites the repository's own bundle and scenario 2/4 edit the application's
# view. Both are restored on the way out, including when a scenario fails: a walkthrough
# must not leave a checkout dirty, or the next thing to read it will.
VIEW_BACKUP="$(mktemp)"
cp "$VIEW" "$VIEW_BACKUP"
BUNDLE_BACKUP="$(mktemp -d)"
BUNDLE_EXISTED="no"
if [ -d "$BUNDLE_PATH" ]; then
  BUNDLE_EXISTED="yes"
  cp -a "$BUNDLE_PATH/." "$BUNDLE_BACKUP/"
fi

restore_worktree() {
  cp "$VIEW_BACKUP" "$VIEW"
  if [ "$BUNDLE_EXISTED" = "yes" ] && [ -d "$BUNDLE_BACKUP" ]; then
    rm -rf "$BUNDLE_PATH"
    mkdir -p "$BUNDLE_PATH"
    cp -a "$BUNDLE_BACKUP/." "$BUNDLE_PATH/"
  fi
  rm -f "$VIEW_BACKUP"
  rm -rf "$BUNDLE_BACKUP"
}

# The trusted bundle is copied out of wherever it was handed to us first, so that nothing in
# this script — including scenario 3 rewriting the repository's copy — can disturb it.
TRUSTED_BUNDLE="$STORES/trusted-bundle"
mkdir -p "$TRUSTED_BUNDLE"
cp -a "$BUNDLE/." "$TRUSTED_BUNDLE/"
BUNDLE="$TRUSTED_BUNDLE"
trap 'ci_stop_app; restore_worktree' EXIT

RESULTS="$ARTIFACTS/walkthrough.tsv"
: >"$RESULTS"
FAILURES=0

record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >>"$RESULTS"; }

expect_eq() { # <name> <expected> <actual> [detail]
  if [ "$2" = "$3" ]; then
    ci_ok "$1 — got $3, expected $2${4:+ · $4}"
    record "$1" "$2" "$3" "matched" "${4:-}"
  else
    FAILURES=$((FAILURES + 1))
    ci_error "$1 — expected $2, got $3${4:+ · $4}"
    record "$1" "$2" "$3" "different" "${4:-}"
  fi
}

# One check against one store. Sets CHECK_STATUS and leaves the JSON and the human log behind.
CHECK_STATUS=0
run_check() { # <store> <name> [extra args...]
  local store="$1" name="$2"
  shift 2
  CHECK_STATUS=0
  ci_run_capture "$ARTIFACTS/$name.json" "$ARTIFACTS/$name.log" \
    ci_uiproof check --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
    --config "$CONFIG" --storage "$store" --json "$@" || CHECK_STATUS=$?
}

if command -v git >/dev/null 2>&1; then
  ci_trust_the_workspace
fi

TRUSTED_VERSION="$(ci_bundle_active_version "$BUNDLE/uiproof-baselines.json" "$PROJECT" "$ROUTE" "$VIEWPORT")"
[ -n "$TRUSTED_VERSION" ] ||
  ci_fail "walkthrough.sh: the trusted bundle has no approved baseline for $PROJECT/$ROUTE at $VIEWPORT."

ci_heading "The walkthrough"
ci_info "image:            $UIPROOF_IMAGE"
ci_info "trusted baseline: $TRUSTED_VERSION (from $BUNDLE)"
ci_info "scope:            project:$PROJECT/$ROUTE @ $VIEWPORT"

ci_heading "Loading the trusted baseline and starting the application"
TRUSTED_STORE="$STORES/trusted"
mkdir -p "$TRUSTED_STORE"
IMPORT_STATUS=0
ci_run_capture "$ARTIFACTS/import.json" "$ARTIFACTS/import.log" \
  ci_uiproof baselines import --from "$BUNDLE" --activate \
  --config "$CONFIG" --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --storage "$TRUSTED_STORE" --json || IMPORT_STATUS=$?
cat "$ARTIFACTS/import.log"
if [ "$IMPORT_STATUS" -ne 0 ]; then
  ci_error "the trusted bundle could not be loaded (exit $IMPORT_STATUS)"
  cat "$ARTIFACTS/import.json"
  exit "$CI_INFRASTRUCTURE"
fi
expect_eq "trusted-bundle-import" "0" "$IMPORT_STATUS" "the approved baseline loads on a clean machine"
expect_eq "trusted-bundle-active-version" "$TRUSTED_VERSION" "$(ci_json_get "$ARTIFACTS/import.json" scopes.0.activeVersionId)"

ci_start_app || exit "$CI_INFRASTRUCTURE"

# ── 1 · unchanged ────────────────────────────────────────────────────────────────────────
ci_heading "Scenario 1 · The application is unchanged"
run_check "$TRUSTED_STORE" "scenario-1"
expect_eq "1·unchanged-application" "$CI_PASS" "$CHECK_STATUS" "$(ci_explain_code "$CHECK_STATUS")"
expect_eq "1·status" "pass" "$(ci_json_get "$ARTIFACTS/scenario-1.json" report.status)"
expect_eq "1·reference-is-trusted" "$TRUSTED_VERSION" "$(ci_json_get "$ARTIFACTS/scenario-1.json" baseline.versionId)"
ci_info "changed: $(ci_json_get "$ARTIFACTS/scenario-1.json" report.metrics.changePercentage)% of the viewport"

# ── 2 · a real change to the application's view ──────────────────────────────────────────
ci_heading "Scenario 2 · A real change to the application's view"
cp "$CHANGED_VIEW" "$VIEW"
ci_info "replaced $VIEW with the changed version shipped next to it:"
diff -u "$VIEW_BACKUP" "$VIEW" | sed 's/^/       /' | head -40 || true
run_check "$TRUSTED_STORE" "scenario-2"
expect_eq "2·real-ui-change" "$CI_REGRESSION" "$CHECK_STATUS" "$(ci_explain_code "$CHECK_STATUS")"
expect_eq "2·status" "regression" "$(ci_json_get "$ARTIFACTS/scenario-2.json" report.status)"
ci_info "changed: $(ci_json_get "$ARTIFACTS/scenario-2.json" report.metrics.changePercentage)% of the viewport, tolerance $(ci_json_get "$ARTIFACTS/scenario-2.json" tolerance)%"

# ── 3 · the application approves itself, and the gate ignores it ─────────────────────────
ci_heading "Scenario 3 · A pull request rewrites the baseline it is judged against"
SELF_STORE="$STORES/self-approved"
SELF_BUNDLE="$STORES/self-approved-bundle"
mkdir -p "$SELF_STORE"
ci_info "the application is still changed; approving the changed UI exactly as \"update the baseline\" tells you to:"
ci_run_capture "$ARTIFACTS/scenario-3-capture.json" "$ARTIFACTS/scenario-3-capture.log" \
  ci_uiproof capture --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --config "$CONFIG" --storage "$SELF_STORE" --approve --note "self-approved in scenario 3" --json ||
  expect_eq "3·capture-approve" "0" "$?" "the self-service approval path must work"
cat "$ARTIFACTS/scenario-3-capture.log"
SELF_VERSION="$(ci_json_get "$ARTIFACTS/scenario-3-capture.json" approved.id)"
ci_info "approved $SELF_VERSION from the changed page"
EXPORT_STATUS=0
ci_run_capture "$ARTIFACTS/scenario-3-export.json" "$ARTIFACTS/scenario-3-export.log" \
  ci_uiproof baselines export --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --config "$CONFIG" --storage "$SELF_STORE" --out "$SELF_BUNDLE" --json || EXPORT_STATUS=$?
if [ "$EXPORT_STATUS" -ne 0 ]; then
  ci_error "the self-approved bundle could not be exported (exit $EXPORT_STATUS)"
  cat "$ARTIFACTS/scenario-3-export.json"
  exit "$CI_INFRASTRUCTURE"
fi
cp -a "$SELF_BUNDLE/." "$BUNDLE_PATH/"
ci_info "the repository's own bundle now holds that approval:"
git -C "$PWD" status --porcelain -- "$BUNDLE_PATH" 2>/dev/null | sed 's/^/       /' || true
SELF_IMAGE_FILE="$(node -e '
  const fs = require("node:fs");
  const [file, versionId] = process.argv.slice(1);
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const scope of bundle.scopes ?? []) {
    const version = (scope.versions ?? []).find((entry) => entry.id === versionId);
    if (version) process.stdout.write(version.file);
  }
' "$BUNDLE_PATH/uiproof-baselines.json" "$SELF_VERSION")"
ci_info "the rewritten bundle's image is $(ci_sha256 "$BUNDLE_PATH/$SELF_IMAGE_FILE")"

GATE_BUNDLE="$BUNDLE"
if [ -n "$TRUSTED_REF" ]; then
  GATE_BUNDLE="$STORES/gate-trusted"
  bash scripts/ci/trusted-baseline.sh --from-ref "$TRUSTED_REF" --into "$GATE_BUNDLE" \
    --path "$BUNDLE_PATH" --provenance "$ARTIFACTS/scenario-3-provenance.txt"
fi

ci_info "now running the gate itself, while that rewritten bundle sits in the working tree:"
GATE_STATUS=0
set +e
bash scripts/ci/run-gate.sh --bundle "$GATE_BUNDLE" --no-app \
  --store "$STORES/gate" --artifacts "$ARTIFACTS/scenario-3-gate" \
  --config "$CONFIG" --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --app-cmd "$APP_CMD" --app-health "$APP_HEALTH"
GATE_STATUS=$?
set -e
expect_eq "3·gate-ignores-the-pull-requests-bundle" "$CI_REGRESSION" "$GATE_STATUS" "$(ci_explain_code "$GATE_STATUS")"
expect_eq "3·gate-reference" "$TRUSTED_VERSION" "$(ci_json_get "$ARTIFACTS/scenario-3-gate/gate-summary.json" trustedReference)" "the reference came from the committed bundle, not the working tree"
if [ "$SELF_VERSION" = "$TRUSTED_VERSION" ]; then
  ci_error "the self-approval reused the trusted version id $TRUSTED_VERSION, so scenario 3 proved nothing"
  record "3·self-approval-produced-a-new-version" "different from $TRUSTED_VERSION" "the same version" "different"
  FAILURES=$((FAILURES + 1))
else
  ci_ok "the application approved $SELF_VERSION while the gate compared against $TRUSTED_VERSION"
  record "3·self-approval-produced-a-new-version" "different" "different" "matched" "$SELF_VERSION vs $TRUSTED_VERSION"
fi

# ── 4 · restored ─────────────────────────────────────────────────────────────────────────
ci_heading "Scenario 4 · The change is reverted"
cp "$VIEW_BACKUP" "$VIEW"
ci_info "restored $VIEW from the copy taken before the walkthrough started"
run_check "$TRUSTED_STORE" "scenario-4"
expect_eq "4·ui-restored" "$CI_PASS" "$CHECK_STATUS" "$(ci_explain_code "$CHECK_STATUS")"

# ── 5 · no approved baseline ─────────────────────────────────────────────────────────────
ci_heading "Scenario 5 · There is no approved baseline"
EMPTY_STORE="$STORES/empty"
mkdir -p "$EMPTY_STORE"
run_check "$EMPTY_STORE" "scenario-5"
expect_eq "5·missing-baseline" "$CI_INFRASTRUCTURE" "$CHECK_STATUS" "$(ci_explain_code "$CHECK_STATUS")"
expect_eq "5·error-code" "baseline_not_found" "$(ci_json_get "$ARTIFACTS/scenario-5.json" error.code)"
ci_info "$(ci_json_get "$ARTIFACTS/scenario-5.json" error.message)"

# ── 6 · a tampered baseline image ────────────────────────────────────────────────────────
ci_heading "Scenario 6 · The baseline image does not match its manifest"
TAMPERED_BUNDLE="$STORES/tampered-bundle"
cp -a "$BUNDLE" "$TAMPERED_BUNDLE"
TAMPERED_IMAGE="$TAMPERED_BUNDLE/$(node -e '
  const fs = require("node:fs");
  const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const scope of bundle.scopes ?? []) {
    const version = (scope.versions ?? []).find((entry) => entry.id === scope.activeVersionId) ?? (scope.versions ?? [])[0];
    if (version) {
      process.stdout.write(version.file);
      break;
    }
  }
' "$TAMPERED_BUNDLE/uiproof-baselines.json")"
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const png = fs.readFileSync(file);
  const at = Math.floor(png.length / 2);
  png[at] = png[at] ^ 0xff;
  fs.writeFileSync(file, png);
  console.log(`flipped one byte at offset ${at} of ${png.length} in ${file}`);
' "$TAMPERED_IMAGE"
TAMPER_STORE="$STORES/tampered"
mkdir -p "$TAMPER_STORE"
TAMPER_STATUS=0
ci_run_capture "$ARTIFACTS/scenario-6-import.json" "$ARTIFACTS/scenario-6-import.log" \
  ci_uiproof baselines import --from "$TAMPERED_BUNDLE" --activate \
  --config "$CONFIG" --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --storage "$TAMPER_STORE" --json || TAMPER_STATUS=$?
cat "$ARTIFACTS/scenario-6-import.log"
expect_eq "6·tampered-baseline-image" "$CI_INFRASTRUCTURE" "$TAMPER_STATUS" "$(ci_explain_code "$TAMPER_STATUS")"
expect_eq "6·error-code" "baseline_integrity_failed" "$(ci_json_get "$ARTIFACTS/scenario-6-import.json" error.code)"
ci_info "$(ci_json_get "$ARTIFACTS/scenario-6-import.json" error.message)"

# ── 7 · the application is not running ───────────────────────────────────────────────────
ci_heading "Scenario 7 · The application is unreachable"
ci_stop_app
run_check "$TRUSTED_STORE" "scenario-7"
expect_eq "7·unreachable-application" "$CI_INFRASTRUCTURE" "$CHECK_STATUS" "$(ci_explain_code "$CHECK_STATUS")"
expect_eq "7·error-code" "project_unreachable" "$(ci_json_get "$ARTIFACTS/scenario-7.json" error.code)"
ci_info "$(ci_json_get "$ARTIFACTS/scenario-7.json" error.message)"

# ── Summary ──────────────────────────────────────────────────────────────────────────────
ci_heading "Summary"
node -e '
  const fs = require("node:fs");
  const [source, destination] = process.argv.slice(1);
  const rows = fs
    .readFileSync(source, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, expected, actual, verdict, detail] = line.split("\t");
      return { name, expected, actual, verdict, detail: detail || null };
    });
  const failed = rows.filter((row) => row.verdict !== "matched");
  const summary = { scenarios: rows.length, matched: rows.length - failed.length, failed: failed.length, checks: rows };
  fs.writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`);
  const width = Math.max(...rows.map((row) => row.name.length), 4);
  for (const row of rows) {
    console.log(`  ${row.name.padEnd(width)}  expected ${row.expected.padEnd(11)} got ${row.actual.padEnd(11)} ${row.verdict}`);
  }
  console.log(`\n  ${summary.matched}/${summary.scenarios} assertions matched`);
' "$RESULTS" "$ARTIFACTS/walkthrough-summary.json"

ci_info "summary: $ARTIFACTS/walkthrough-summary.json"
ci_info "every run's report, screenshot and diff is under $STORES"

if [ "$FAILURES" -ne 0 ]; then
  ci_error "$FAILURES walkthrough assertion(s) did not match; see the log above and $ARTIFACTS/walkthrough-summary.json"
  exit "$CI_REGRESSION"
fi

ci_ok "the walkthrough reproduced every documented answer"
