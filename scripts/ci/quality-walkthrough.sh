#!/usr/bin/env bash
#
# The quality walkthrough: every answer the accessibility and layout gate is supposed to give,
# asserted in the pinned rendering environment against the example application.
#
# This is a *demonstration and an integration test*, not the gate. The gate is
# `audit-gate.sh`, which lets a real defect fail the job. Here a nonzero exit code is the
# expected result that gets checked — the right thing for a walkthrough and the wrong thing
# for a gate — which is why the two are separate files and separate workflows.
#
# What it proves, in order:
#
#   1  a clean page passes at desktop, tablet and mobile, with a screenshot per viewport
#   2  a newly introduced serious accessibility violation fails the check
#   3  a newly introduced mobile overflow fails the check (and is named as a mobile failure)
#   4  an approval made at desktop does **not** authorise the same finding on mobile or
#      tablet: with `--new-only`, the mobile findings are still new, while a desktop-only
#      audit of the same page passes
#   5  those desktop approvals survive export, a wiped store and import: the portable
#      reference classifies exactly as the local one did
#   6  more violations than the report's display cap: the failure decision still sees the
#      serious finding that sorted past the cap, and the report says it was truncated
#   7  a page that refuses the scanner is an infrastructure failure (2) — never a pass, and
#      never a report claiming a clean scan
#   8  restoring the page passes again
#
# The application under test is a scratch copy (`EXAMPLE_APP_DIR`), so the walkthrough edits
# the page the way a developer would and never touches the repository.
#
# Usage
#   quality-walkthrough.sh [--bundle <dir>] [--artifacts <dir>] [--stores <dir>]
#                          [--config <file>] [--project <id>] [--app-cmd <cmd>]
#                          [--app-health <url>] [--app-port <port>]
#
# Exit
#   0  every scenario produced the answer it was supposed to
#   1  at least one scenario did not (the log names it)
#   2  the walkthrough itself could not run
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
quality-walkthrough.sh — assert every accessibility and layout answer, end to end

Usage
  quality-walkthrough.sh [options]

Options
  --bundle <dir>       Trusted portable bundle to check references against (optional; the
                       portable-reference scenario builds and exports its own)
  --artifacts <dir>    Where audit JSON, logs and summaries land (default: .uiproof/ci-artifacts)
  --stores <dir>       Parent of the scratch stores                  (default: .uiproof/ci-stores)
  --config <file>      Registration file                             (default: examples/ci/uiproof.config.json)
  --project <id>       Registered project                            (default: example-app)
  --app-cmd <cmd>      Command that starts the application under test
  --app-health <url>   Endpoint that answers when it is ready
  --app-port <port>    Port the scratch application listens on       (default: 4173)
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
ARTIFACTS=""
STORES=""
CONFIG="$UIPROOF_CONFIG_DEFAULT"
PROJECT="$UIPROOF_PROJECT_DEFAULT"
APP_CMD="$UIPROOF_APP_CMD_DEFAULT"
APP_HEALTH=""
APP_PORT="$UIPROOF_APP_PORT_DEFAULT"

ci_parse_args "quality-walkthrough.sh" \
  "--bundle:BUNDLE" \
  "--artifacts:ARTIFACTS" \
  "--stores:STORES" \
  "--config:CONFIG" \
  "--project:PROJECT" \
  "--app-cmd:APP_CMD" \
  "--app-health:APP_HEALTH" \
  "--app-port:APP_PORT" \
  -- "$@"

ARTIFACTS="${ARTIFACTS:-.uiproof/ci-artifacts}"
STORES="${STORES:-.uiproof/ci-stores}"
APP_HEALTH="${APP_HEALTH:-http://127.0.0.1:${APP_PORT}/healthz}"

[ -f "$CONFIG" ] || ci_fail "quality-walkthrough.sh: the registration file $CONFIG does not exist."
[ -f examples/example-app/views/quality.changed.html ] ||
  ci_fail "quality-walkthrough.sh: the defective twin of the support view is missing."

rm -rf "$STORES"
mkdir -p "$STORES" "$ARTIFACTS"

# A scratch copy of the application: the walkthrough edits the page it serves, and the
# repository stays untouched.
APP_DIR="$STORES/app"
cp -a examples/example-app "$APP_DIR"
APP_VIEW="$APP_DIR/views/quality.html"
CLEAN_VIEW="$APP_DIR/views/quality.clean.html"
cp "$APP_VIEW" "$CLEAN_VIEW"
DEFECTIVE_VIEW="$APP_DIR/views/quality.changed.html"

export UIPROOF_APP_CMD="$APP_CMD"
export UIPROOF_APP_HEALTH="$APP_HEALTH"
export UIPROOF_APP_PORT="$APP_PORT"
export UIPROOF_APP_LOG="$ARTIFACTS/app.log"
export UIPROOF_APP_HOST="$UIPROOF_APP_HOST_DEFAULT"
export UIPROOF_APP_ENV="EXAMPLE_APP_DIR=$APP_DIR"
export UIPROOF_GATE_PROJECT="$PROJECT"

trap 'ci_stop_app' EXIT

RESULTS="$ARTIFACTS/quality-walkthrough.tsv"
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

# Evaluates a small JavaScript expression against a CLI JSON document, with the parsed
# document in scope as `doc`, the audit report as `report`, the closure's `approved` and the
# import result's `scopes`. The expression comes from this file; nothing from the page or the
# bundle is ever evaluated.
q_eval() { # <json file> <expression>
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const report = doc.report ?? {};
    const approved = doc.approved ?? null;
    const scopes = doc.scopes ?? [];
    // eslint-disable-next-line no-eval
    const value = eval(process.argv[2]);
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1" "$2"
}

# One audit run. Sets AUDIT_STATUS and leaves the JSON and human log behind under <name>.
AUDIT_STATUS=0
run_audit() { # <store> <name> <route> [extra args...]
  local store="$1" name="$2" route="$3"
  shift 3
  AUDIT_STATUS=0
  ci_run_capture "$ARTIFACTS/$name.json" "$ARTIFACTS/$name.log" \
    ci_uiproof audit --project "$PROJECT" --route "$route" --config "$CONFIG" \
    --storage "$store" --json "$@" || AUDIT_STATUS=$?
}

if command -v git >/dev/null 2>&1; then
  ci_trust_the_workspace
fi

ci_heading "The quality walkthrough"
ci_info "image:   $UIPROOF_IMAGE"
ci_info "checker: ${UIPROOF_CLI_DIR:-the working tree}"
ci_info "app:     $APP_DIR (scratch copy; the repository is untouched)"
ci_info "config:  $CONFIG"

ci_start_app || exit "$CI_INFRASTRUCTURE"

# ── 1 · a clean page ─────────────────────────────────────────────────────────────────────
ci_heading "Scenario 1 · A clean page at every viewport"
STORE_CLEAN="$STORES/clean"
mkdir -p "$STORE_CLEAN"
run_audit "$STORE_CLEAN" "scenario-1" "support" --fail-on serious
expect_eq "1·clean-page" "$CI_PASS" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "1·verdict" "pass" "$(q_eval "$ARTIFACTS/scenario-1.json" 'report.verdict.status')"
expect_eq "1·viewports" "3" "$(q_eval "$ARTIFACTS/scenario-1.json" 'report.viewports.map((v) => v.viewport.id).sort().join(",") === "desktop,mobile,tablet" ? 3 : -1')" "desktop, tablet and mobile were all measured"
expect_eq "1·no-findings" "true" "$(q_eval "$ARTIFACTS/scenario-1.json" 'report.viewports.every((v) => v.accessibility.totalFindings === 0)')"
expect_eq "1·no-overflow" "true" "$(q_eval "$ARTIFACTS/scenario-1.json" 'report.viewports.every((v) => v.responsive.documentOverflowPx === 0 && v.responsive.findings.length === 0)')"
REPORT_ID="$(q_eval "$ARTIFACTS/scenario-1.json" 'report.id')"
expect_eq "1·screenshots-persisted" "3" "$(ls "$STORE_CLEAN/audits/$REPORT_ID"/*.png 2>/dev/null | wc -l | tr -d ' ')" "one screenshot per viewport"
expect_eq "1·reference-honesty" "true" "$(q_eval "$ARTIFACTS/scenario-1.json" 'report.references.length === 0 ? report.verdict.notes.some((n) => n.includes("No approved baseline records an accessibility snapshot")) : true')"

# ── 2 · a newly introduced serious violation ─────────────────────────────────────────────
ci_heading "Scenario 2 · A newly introduced serious accessibility violation"
cp "$DEFECTIVE_VIEW" "$APP_VIEW"
ci_info "replaced the support view with its deliberately defective twin:"
diff -u "$CLEAN_VIEW" "$APP_VIEW" | sed 's/^/       /' | head -30 || true
STORE_DEFECTS="$STORES/defects"
mkdir -p "$STORE_DEFECTS"
run_audit "$STORE_DEFECTS" "scenario-2" "support" --fail-on serious
expect_eq "2·serious-violation" "$CI_REGRESSION" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "2·verdict" "fail" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.verdict.status')"
expect_eq "2·failure-names-an-accessibility-band" "true" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.verdict.failures.some((f) => f.kind === "accessibility")')"
expect_eq "2·evidence-fingerprints" "true" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.verdict.failures.filter((f) => f.kind === "accessibility").every((f) => f.count === f.evidence.length && f.count > 0)')" "every counted failure carries exactly that many fingerprints"
expect_eq "2·stderr-says-fail" "true" "$(grep -q 'QUALITY FAIL' "$ARTIFACTS/scenario-2.log" && echo true || echo false)"

# ── 3 · a newly introduced mobile overflow ───────────────────────────────────────────────
ci_heading "Scenario 3 · A newly introduced mobile overflow"
expect_eq "3·overflow-named-at-mobile" "true" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.verdict.failures.some((f) => f.code.startsWith("responsive.") && f.message.includes("mobile"))')" "the failure names the viewport the overflow was measured at"
expect_eq "3·overflow-measured-at-mobile" "true" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.viewports.find((v) => v.viewport.id === "mobile").responsive.documentOverflowPx > 1')"
expect_eq "3·desktop-not-accused" "true" "$(q_eval "$ARTIFACTS/scenario-2.json" 'report.viewports.find((v) => v.viewport.id === "desktop").responsive.documentOverflowPx <= 1')" "the same page does not overflow at desktop"

# ── 4 · an approval at desktop is not an approval at mobile ──────────────────────────────
ci_heading "Scenario 4 · An approval made at desktop does not authorise mobile"
STORE_DESKTOP="$STORES/desktop-approval"
mkdir -p "$STORE_DESKTOP"
APPROVE_STATUS=0
ci_run_capture "$ARTIFACTS/scenario-4-approve.json" "$ARTIFACTS/scenario-4-approve.log" \
  ci_uiproof capture --project "$PROJECT" --route "support" --viewport desktop \
  --config "$CONFIG" --storage "$STORE_DESKTOP" --quality --approve \
  --note "the deliberately defective page, approved at desktop by the walkthrough" --json || APPROVE_STATUS=$?
if [ "$APPROVE_STATUS" -ne 0 ]; then
  ci_error "the desktop approval could not be made (exit $APPROVE_STATUS)"
  cat "$ARTIFACTS/scenario-4-approve.json" || true
  exit "$CI_INFRASTRUCTURE"
fi
DESKTOP_VERSION="$(q_eval "$ARTIFACTS/scenario-4-approve.json" 'approved?.id ?? ""')"
DESKTOP_FINGERPRINTS="$(q_eval "$ARTIFACTS/scenario-4-approve.json" '(report.quality?.accessibility?.violations ?? []).length')"
[ -n "$DESKTOP_VERSION" ] || ci_fail "quality-walkthrough.sh: the desktop approval reported no version id."
[ "$DESKTOP_FINGERPRINTS" -gt 0 ] || ci_fail "quality-walkthrough.sh: the desktop approval recorded no violation fingerprints, so scenario 4 would prove nothing."
ci_info "approved $DESKTOP_VERSION with $DESKTOP_FINGERPRINTS violation fingerprint(s) recorded"

run_audit "$STORE_DESKTOP" "scenario-4-all" "support" --fail-on serious --new-only
expect_eq "4·mobile-finding-is-not-authorised-by-desktop" "$CI_REGRESSION" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "4·partial-coverage-is-stated" "true" "$(q_eval "$ARTIFACTS/scenario-4-all.json" 'report.verdict.notes.some((n) => n.includes("No approved accessibility snapshot exists for mobile"))')" "the verdict says mobile has no reference rather than assuming one"
expect_eq "4·mobile-findings-are-new" "true" "$(q_eval "$ARTIFACTS/scenario-4-all.json" 'report.newFindingFingerprints.length > 0')"
expect_eq "4·one-reference-used" "1" "$(q_eval "$ARTIFACTS/scenario-4-all.json" 'report.references.length')"

run_audit "$STORE_DESKTOP" "scenario-4-desktop" "support" --fail-on serious --new-only --viewport desktop
expect_eq "4·desktop-only-audit-passes" "$CI_PASS" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "4·desktop-findings-are-known" "true" "$(q_eval "$ARTIFACTS/scenario-4-desktop.json" 'report.newFindingFingerprints.length === 0 && report.knownFindingFingerprints.length > 0')"

# ── 5 · the portable reference ───────────────────────────────────────────────────────────
ci_heading "Scenario 5 · Approved accessibility references survive export and import"
BUNDLE_OUT="$STORES/exported-bundle"
EXPORT_STATUS=0
ci_run_capture "$ARTIFACTS/scenario-5-export.json" "$ARTIFACTS/scenario-5-export.log" \
  ci_uiproof baselines export --project "$PROJECT" --route "support" --viewport desktop \
  --config "$CONFIG" --storage "$STORE_DESKTOP" --out "$BUNDLE_OUT" --json || EXPORT_STATUS=$?
if [ "$EXPORT_STATUS" -ne 0 ]; then
  ci_error "the bundle could not be exported (exit $EXPORT_STATUS)"
  cat "$ARTIFACTS/scenario-5-export.json" || true
  exit "$CI_INFRASTRUCTURE"
fi
BUNDLED_SNAPSHOT="$(ci_json_get "$BUNDLE_OUT/uiproof-baselines.json" scopes.0.versions.0.quality.violationCount)"
[ "$BUNDLED_SNAPSHOT" = "$DESKTOP_FINGERPRINTS" ] ||
  ci_fail "quality-walkthrough.sh: the bundle records $BUNDLED_SNAPSHOT fingerprint(s), but the approval measured $DESKTOP_FINGERPRINTS."
ci_ok "the exported bundle carries the approved snapshot: $BUNDLED_SNAPSHOT fingerprint(s), same as the approval"
expect_eq "5·snapshot-is-there" "1" "$(node -e '
  const fs = require("node:fs");
  const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const version = bundle.scopes?.[0]?.versions?.[0];
  process.stdout.write(version && version.quality && Array.isArray(version.quality.fingerprints) ? "1" : "0");
' "$BUNDLE_OUT/uiproof-baselines.json")"

STORE_PORTABLE="$STORES/portable"
mkdir -p "$STORE_PORTABLE"
IMPORT_STATUS=0
ci_run_capture "$ARTIFACTS/scenario-5-import.json" "$ARTIFACTS/scenario-5-import.log" \
  ci_uiproof baselines import --from "$BUNDLE_OUT" --activate \
  --config "$CONFIG" --project "$PROJECT" --route "support" --viewport desktop \
  --storage "$STORE_PORTABLE" --json || IMPORT_STATUS=$?
expect_eq "5·import-loads-a-reference" "0" "$IMPORT_STATUS" "$(ci_explain_code "$IMPORT_STATUS")"
expect_eq "5·import-reports-the-snapshot" "1" "$(ci_json_get "$ARTIFACTS/scenario-5-import.json" accessibilitySnapshots)"

run_audit "$STORE_PORTABLE" "scenario-5-audit" "support" --fail-on serious --new-only --viewport desktop
expect_eq "5·classification-survives-the-round-trip" "$CI_PASS" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "5·same-known-findings" "$(q_eval "$ARTIFACTS/scenario-4-desktop.json" 'report.knownFindingFingerprints.length')" "$(q_eval "$ARTIFACTS/scenario-5-audit.json" 'report.knownFindingFingerprints.length')" "the imported reference classifies exactly as the local one did"
expect_eq "5·nothing-read-as-new" "true" "$(q_eval "$ARTIFACTS/scenario-5-audit.json" 'report.newFindingFingerprints.length === 0')"

# ── 6 · more findings than the report cap ────────────────────────────────────────────────
ci_heading "Scenario 6 · More violations than the report's display cap"
STORE_FLOOD="$STORES/flood"
mkdir -p "$STORE_FLOOD"
run_audit "$STORE_FLOOD" "scenario-6" "support-flood" --fail-on serious --viewport desktop
expect_eq "6·flood-page-fails" "$CI_REGRESSION" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "6·more-than-the-cap" "true" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.viewports[0].accessibility.totalFindings > 60')" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.viewports[0].accessibility.totalFindings') findings were measured"
expect_eq "6·report-says-truncated" "true" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.viewports[0].accessibility.truncated === true && report.viewports[0].accessibility.findings.length === 60')" "the readable list is capped at 60; the count above it is not"
expect_eq "6·verdict-evaluated-the-complete-set" "true" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.viewports[0].accessibility.violations.length > 60')"
expect_eq "6·serious-beyond-the-cap-fails" "true" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.verdict.failures.some((f) => f.kind === "accessibility" && f.evidence.some((e) => e.startsWith("svg-img-alt@")))')" "the serious violation that sorted past the cap is in the verdict's evidence"
expect_eq "6·verdict-explains-the-cap" "true" "$(q_eval "$ARTIFACTS/scenario-6.json" 'report.verdict.notes.some((n) => n.includes("the verdict evaluated all"))')"

# ── 7 · a page that refuses the scanner ──────────────────────────────────────────────────
ci_heading "Scenario 7 · The scanner cannot run"
STORE_CSP="$STORES/scanner-unavailable"
mkdir -p "$STORE_CSP"
run_audit "$STORE_CSP" "scenario-7" "support-csp" --fail-on serious --viewport desktop
expect_eq "7·scanner-refused" "$CI_INFRASTRUCTURE" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "7·error-code" "quality_unavailable" "$(ci_json_get "$ARTIFACTS/scenario-7.json" error.code)"
expect_eq "7·no-report-claiming-a-clean-scan" "true" "$( [ ! -d "$STORE_CSP/audits" ] && echo true )" "an audit that never scanned persists nothing"
ci_info "$(ci_json_get "$ARTIFACTS/scenario-7.json" error.message)"

# ── 8 · restored ─────────────────────────────────────────────────────────────────────────
ci_heading "Scenario 8 · The page is restored"
cp "$CLEAN_VIEW" "$APP_VIEW"
run_audit "$STORE_CLEAN" "scenario-8" "support" --fail-on serious
expect_eq "8·restored-page" "$CI_PASS" "$AUDIT_STATUS" "$(ci_explain_code "$AUDIT_STATUS")"
expect_eq "8·verdict" "pass" "$(q_eval "$ARTIFACTS/scenario-8.json" 'report.verdict.status')"

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
' "$RESULTS" "$ARTIFACTS/quality-walkthrough-summary.json"

ci_info "summary: $ARTIFACTS/quality-walkthrough-summary.json"
ci_info "every audit report and screenshot is under $STORES"

if [ -n "$BUNDLE" ]; then
  ci_info "a trusted bundle was supplied: $BUNDLE (its references are exercised by the gate, not here)"
fi

if [ "$FAILURES" -ne 0 ]; then
  ci_error "$FAILURES walkthrough assertion(s) did not match; see the log above and $ARTIFACTS/quality-walkthrough-summary.json"
  exit "$CI_REGRESSION"
fi

ci_ok "the quality walkthrough reproduced every documented answer"
