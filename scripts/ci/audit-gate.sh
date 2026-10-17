#!/usr/bin/env bash
#
# The pull-request quality gate: audit the application under test and fail when accessibility
# or layout policy fails.
#
# This is the accessibility/layout sibling of `run-gate.sh` and it is built the same way:
#
#   * **It never approves anything.** `audit` has no `--approve` and this script never calls
#     `capture`. A gate that approves the page it is about to test cannot fail; that defect is
#     why these scripts exist.
#   * **`--new-only` is refused without a trustworthy reference.** The flag only means
#     something when an approved accessibility snapshot has actually been imported in this
#     run. Without one, `--new-only` would count every finding (fail closed, but confusing);
#     this script treats the combination as an infrastructure error instead, so a gate can
#     never *appear* to be comparing against a reference it does not have.
#   * **An infrastructure failure is never a pass.** If the scanner cannot run — the page
#     refuses axe-core's injection, Chromium fails to start, the report is missing — the exit
#     code is 2 and the job fails.
#   * **Evidence is always written down.** The audit JSON and one screenshot per viewport
#     land under `--artifacts`, whether the audit passed or failed, so a failure is
#     reviewable from the artifacts alone.
#
# The checker it runs is whatever `ci_uiproof` points at. In the workflow that is the
# *extracted base revision* (`UIPROOF_CLI_DIR`, see `trusted-checker.sh`), so a pull request
# cannot rewrite the policy engine judging it; the application under test is the pull
# request's code, started with a scrubbed environment.
#
# Usage
#   audit-gate.sh [--bundle <dir>] [--store <dir>] [--artifacts <dir>] [--config <file>]
#                 [--project <id>] [--route <id>] [--viewport <id>]... [--fail-on <impact>]
#                 [--new-only] [--max-document-overflow <px>] [--max-element-overflow <px>]
#                 [--no-wcag-best-practice] [--app-cmd <cmd>] [--app-health <url>]
#                 [--app-env <KEY=VALUE>] [--app-log <file>] [--no-app]
#
# Exit
#   the CLI's own code, because a CI job is the interface here:
#   0  the policy passed            → the job succeeds
#   1  the policy failed            → the job fails
#   2  the audit could not be answered (scanner, browser, storage, missing reference) → the
#      job fails
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
audit-gate.sh — gate the application under test on accessibility and responsive layout

Usage
  audit-gate.sh [options]

Options
  --bundle <dir>              Trusted portable bundle to load references from (optional:
                              without it the gate runs the full policy, which never needs a
                              reference, and says so)
  --store <dir>               Where the audit store is built   (default: .uiproof/ci-store)
  --artifacts <dir>           Where audit JSON, logs and screenshots land
                                                               (default: .uiproof/ci-artifacts)
  --config <file>             Registration file                (default: examples/ci/uiproof.config.json)
  --project <id>              Registered project               (default: example-app)
  --route <id>                Registered route                 (default: home)
  --viewport <id>             desktop | tablet | mobile. Repeat for several; omit for every
                              preset, which is what the gate does
  --fail-on <impact>          minor | moderate | serious | critical | none (default: serious)
  --new-only                  Fail only on findings absent from an imported reference.
                              Requires --bundle with an accessibility snapshot; without one
                              the gate answers 2 instead of pretending
  --no-wcag-best-practice     Count only rules that carry a WCAG tag
  --max-document-overflow <px>  Allowed document-level horizontal overflow (default: CLI's)
  --max-element-overflow <px>   Allowed element overflow (default: CLI's)
  --app-cmd <cmd>             Command that starts the application under test
  --app-health <url>          Endpoint that answers when it is ready
  --app-env <K=V>             Extra environment for the application (repeatable, scrubbed)
  --app-log <file>            Where to keep the application's output
  --no-app                    Do not start the application (a caller already did)
  --help                      Show this help

Policy
  The documented default policy: fail on serious or higher accessibility findings, count
  best-practice rules, and allow at most the CLI's tolerance of horizontal overflow. Nothing
  here is silent: the policy in force is printed by `uiproof audit` and stored in the report.

Exit codes
  0  the policy passed
  1  the policy failed
  2  the audit could not be answered
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
VIEWPORTS=""
FAIL_ON="serious"
NEW_ONLY=""
BEST_PRACTICE=""
MAX_DOCUMENT_OVERFLOW=""
MAX_ELEMENT_OVERFLOW=""
APP_CMD="$UIPROOF_APP_CMD_DEFAULT"
APP_HEALTH="$UIPROOF_APP_HEALTH_DEFAULT"
APP_ENV=""
APP_LOG=""
NO_APP=""

ci_parse_args "audit-gate.sh" \
  "--bundle:BUNDLE" \
  "--store:STORE" \
  "--artifacts:ARTIFACTS" \
  "--config:CONFIG" \
  "--project:PROJECT" \
  "--route:ROUTE" \
  "--viewport:VIEWPORTS*" \
  "--fail-on:FAIL_ON" \
  "--new-only:NEW_ONLY!" \
  "--no-wcag-best-practice:BEST_PRACTICE!" \
  "--max-document-overflow:MAX_DOCUMENT_OVERFLOW" \
  "--max-element-overflow:MAX_ELEMENT_OVERFLOW" \
  "--app-cmd:APP_CMD" \
  "--app-health:APP_HEALTH" \
  "--app-env:APP_ENV*" \
  "--app-log:APP_LOG" \
  "--no-app:NO_APP!" \
  -- "$@"

[ -n "$ROUTE" ] || ROUTE="$UIPROOF_ROUTE_DEFAULT"
STORE="${STORE:-.uiproof/ci-store}"
ARTIFACTS="${ARTIFACTS:-.uiproof/ci-artifacts}"
export UIPROOF_APP_ENV="$APP_ENV"
export UIPROOF_APP_LOG="${APP_LOG:-$ARTIFACTS/app.log}"
export UIPROOF_APP_CMD="$APP_CMD"
export UIPROOF_APP_HEALTH="$APP_HEALTH"
export UIPROOF_GATE_PROJECT="$PROJECT"
export UIPROOF_GATE_ROUTE="$ROUTE"
export UIPROOF_GATE_VIEWPORTS="${VIEWPORTS:-every preset}"

# The store is rebuilt every time. Nothing that a previous run — or the code under test —
# could have left in it is allowed to reach this audit; the only thing that enters it is the
# trusted bundle loaded in step 1.
rm -rf "$STORE"
mkdir -p "$STORE" "$ARTIFACTS"

trap 'ci_stop_app' EXIT

ci_heading "Rendering environment"
ci_info "image:      $UIPROOF_IMAGE"
ci_info "node:       $(node -v)"
ci_info "playwright: $(node -e 'process.stdout.write(require("playwright/package.json").version)' 2>/dev/null || echo unknown)"
ci_info "checker:    ${UIPROOF_CLI_DIR:-the working tree}"
ci_info "chromium:   revision $UIPROOF_CHROMIUM_REVISION (from the image)"

ci_heading "Quality gate"
ci_info "project:  $PROJECT · route $ROUTE · viewports ${VIEWPORTS:-all presets}"
ci_info "config:   $CONFIG"
ci_info "policy:   fail on $FAIL_ON${BEST_PRACTICE:+ · WCAG-tagged rules only}${NEW_ONLY:+ · new findings only}"
ci_info "store:    $STORE"
ci_info "evidence: $ARTIFACTS"

# ── 1 · The trusted reference, when there is one ─────────────────────────────────────────
#
# The whole bundle is loaded, not one selected scope: a bundle that covers other routes is a
# valid bundle, and whether the *audited* route has a reference is answered by the audit's own
# `references` list in step 3. A malformed, tampered or unreadable bundle still stops the gate
# here — that is the distinction that has to survive.
ci_heading "1 · The trusted reference"
if [ -n "$BUNDLE" ]; then
  [ -d "$BUNDLE" ] || ci_fail "audit-gate.sh: the trusted bundle directory $BUNDLE does not exist."
  IMPORT_STATUS=0
  ci_run_capture "$ARTIFACTS/import.json" "$ARTIFACTS/import.log" \
    ci_uiproof baselines import --from "$BUNDLE" --activate \
    --config "$CONFIG" --storage "$STORE" --json || IMPORT_STATUS=$?
  cat "$ARTIFACTS/import.log"
  if [ "$IMPORT_STATUS" -ne 0 ]; then
    ci_error "the trusted bundle could not be loaded (exit $IMPORT_STATUS) — an unreadable or tampered bundle stops the gate instead of passing it"
    cat "$ARTIFACTS/import.json" || true
    exit "$CI_INFRASTRUCTURE"
  fi
  ci_ok "loaded the trusted bundle: $(ci_json_get "$ARTIFACTS/import.json" added) version(s), $(ci_json_get "$ARTIFACTS/import.json" accessibilitySnapshots) carrying an accessibility snapshot"
  ci_info "whether $PROJECT/$ROUTE itself has a reference is decided by the audit below, per viewport"
else
  ci_info "no --bundle was given: the full policy runs, which needs no reference, and the report will say no reference exists"
fi

# ── 2 · The application under test ───────────────────────────────────────────────────────
if [ -n "$NO_APP" ]; then
  ci_heading "2 · The application under test (started by the caller)"
  ci_info "assuming it is serving at $APP_HEALTH"
else
  ci_heading "2 · The application under test"
  ci_start_app
fi

# ── 3 · The audit ────────────────────────────────────────────────────────────────────────
ci_heading "3 · The audit"
AUDIT_ARGS=(audit --project "$PROJECT" --route "$ROUTE" --config "$CONFIG" --storage "$STORE" --json)
for viewport in $VIEWPORTS; do
  AUDIT_ARGS+=(--viewport "$viewport")
done
AUDIT_ARGS+=(--fail-on "$FAIL_ON")
[ -n "$NEW_ONLY" ] && AUDIT_ARGS+=(--new-only)
[ -n "$BEST_PRACTICE" ] && AUDIT_ARGS+=(--wcag-only)
[ -n "$MAX_DOCUMENT_OVERFLOW" ] && AUDIT_ARGS+=(--max-document-overflow "$MAX_DOCUMENT_OVERFLOW")
[ -n "$MAX_ELEMENT_OVERFLOW" ] && AUDIT_ARGS+=(--max-element-overflow "$MAX_ELEMENT_OVERFLOW")

STATUS=0
ci_run_capture "$ARTIFACTS/audit.json" "$ARTIFACTS/audit.log" ci_uiproof "${AUDIT_ARGS[@]}" || STATUS=$?
cat "$ARTIFACTS/audit.log"

REPORT_STATUS="$(ci_json_get "$ARTIFACTS/audit.json" status)"
REPORT_PATH="$(ci_json_get "$ARTIFACTS/audit.json" reportPath)"
REPORT_ID="$(ci_json_get "$ARTIFACTS/audit.json" report.id)"
EXIT_CODE_FIELD="$(ci_json_get "$ARTIFACTS/audit.json" exitCode)"
TOTAL_FINDINGS="$(ci_json_get "$ARTIFACTS/audit.json" report.viewports.0.accessibility.totalFindings)"
# How many audited viewports actually had a reference: the audit resolves one per viewport, so
# this is the only number that means "this run could classify findings as new".
REFERENCES="$(ci_json_get "$ARTIFACTS/audit.json" report.references.length)"
REFERENCES="${REFERENCES:-0}"

if [ -n "$NEW_ONLY" ] && [ "$REFERENCES" -eq 0 ]; then
  ci_error "--new-only was asked for, but the audit used no accessibility reference for $PROJECT/$ROUTE: there was nothing trustworthy to compare against"
  exit "$CI_INFRASTRUCTURE"
fi

# ── 4 · Evidence ─────────────────────────────────────────────────────────────────────────
ci_heading "4 · Evidence"
EVIDENCE_DIR="$ARTIFACTS/evidence"
mkdir -p "$EVIDENCE_DIR"
SCREENSHOTS=0
if [ -n "$REPORT_PATH" ] && [ -f "$STORE/$REPORT_PATH" ]; then
  cp "$STORE/$REPORT_PATH" "$EVIDENCE_DIR/audit.json"
  SCREENSHOT_DIR="$(dirname "$STORE/$REPORT_PATH")"
  for screenshot in "$SCREENSHOT_DIR"/*.png; do
    [ -f "$screenshot" ] || continue
    cp "$screenshot" "$EVIDENCE_DIR/"
    SCREENSHOTS=$((SCREENSHOTS + 1))
  done
  ci_ok "copied the audit report and $SCREENSHOTS screenshot(s) to $EVIDENCE_DIR"
else
  if [ "$STATUS" = "$CI_INFRASTRUCTURE" ]; then
    ci_info "no audit was persisted — the run failed before it produced a report (this is the honest outcome, not a missing step)"
  else
    ci_error "the audit answered $STATUS but persisted no report at $REPORT_PATH"
    STATUS="$CI_INFRASTRUCTURE"
  fi
fi

# ── 5 · Verdict ──────────────────────────────────────────────────────────────────────────
ci_heading "5 · Verdict"
case "$STATUS" in
  "$CI_PASS")
    if [ "$REPORT_STATUS" != "pass" ]; then
      ci_error "the process exited 0 but the report says \"${REPORT_STATUS:-nothing}\" — refusing to call that a pass"
      STATUS="$CI_INFRASTRUCTURE"
    else
      ci_ok "exit 0 — the policy passed"
      ci_info "violations across $UIPROOF_GATE_VIEWPORTS: ${TOTAL_FINDINGS:-0} at the first viewport, more per viewport in the report"
    fi
    ;;
  "$CI_REGRESSION")
    if [ "$REPORT_STATUS" != "fail" ]; then
      ci_error "the process exited 1 but the report says \"${REPORT_STATUS:-nothing}\" — refusing to call that a policy failure"
      STATUS="$CI_INFRASTRUCTURE"
    else
      ci_error "exit 1 — the policy failed (the report above names every failure, its evidence and the measured numbers)"
    fi
    ;;
  "$CI_INFRASTRUCTURE")
    ci_error "exit 2 — the audit could not be answered; this is an infrastructure failure, never a pass"
    ;;
  *)
    ci_error "exit $STATUS — the CLI reported a code this gate does not know"
    STATUS="$CI_INFRASTRUCTURE"
    ;;
esac

if [ -n "$EXIT_CODE_FIELD" ] && [ "$EXIT_CODE_FIELD" != "$STATUS" ] && [ "$STATUS" != "$CI_INFRASTRUCTURE" ]; then
  # The JSON document carries the exit code the CLI meant to return; the process status is
  # the one that counts. A disagreement is worth stopping for.
  ci_error "the report declares exitCode $EXIT_CODE_FIELD but the process exited $STATUS"
  STATUS="$CI_INFRASTRUCTURE"
fi

node -e '
  const fs = require("node:fs");
  const [file, status, reportStatus, references, screenshots, reportId, reportPath, checker] = process.argv.slice(1);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        gate: "uiproof-quality",
        exitCode: Number(status),
        reportStatus: reportStatus || null,
        referenceViewports: references === "" ? 0 : Number(references),
        screenshotsCopied: Number(screenshots),
        reportId: reportId || null,
        reportPath: reportPath || null,
        checker: checker || "working tree",
        renderingImage: process.env.UIPROOF_IMAGE ?? null,
        project: process.env.UIPROOF_GATE_PROJECT ?? null,
        route: process.env.UIPROOF_GATE_ROUTE ?? null,
        viewports: process.env.UIPROOF_GATE_VIEWPORTS ?? null,
      },
      null,
      2,
    ) + "\n",
  );
'  "$ARTIFACTS/audit-gate-summary.json" "$STATUS" "$REPORT_STATUS" "$REFERENCES" "$SCREENSHOTS" "$REPORT_ID" "$REPORT_PATH" "${UIPROOF_CLI_DIR:-}"

ci_info "summary: $ARTIFACTS/audit-gate-summary.json"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    if [ "$STATUS" = "$CI_PASS" ]; then
      printf '## Accessibility and layout gate — the policy passed\n\n'
    else
      printf '## Accessibility and layout gate — %s\n\n' "$(ci_explain_code "$STATUS")"
    fi
    printf '| | |\n| --- | --- |\n'
    printf '| exit code | `%s` — %s |\n' "$STATUS" "$(ci_explain_code "$STATUS")"
    printf '| audit report | `%s` |\n' "${REPORT_ID:-none}"
    printf '| reference viewports | %s |\n' "$REFERENCES"
    printf '| screenshots | %s |\n' "$SCREENSHOTS"
    printf '| checker | `%s` |\n' "${UIPROOF_CLI_DIR:-the working tree}"
    printf '| viewed by | `%s` |\n\n' "$UIPROOF_IMAGE"
    printf 'Policy: fail on `%s` accessibility findings%s; responsive overflow past the configured limits.\n' \
      "$FAIL_ON" "${NEW_ONLY:+; new findings only (against the imported reference)}"
    printf 'The audit JSON, one screenshot per viewport and the failure evidence are attached to this run.\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi

case "$STATUS" in
  "$CI_PASS" | "$CI_REGRESSION" | "$CI_INFRASTRUCTURE") exit "$STATUS" ;;
  *) exit "$CI_INFRASTRUCTURE" ;;
esac
