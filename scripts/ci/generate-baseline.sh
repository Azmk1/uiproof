#!/usr/bin/env bash
#
# Produces an approved baseline for the example application inside the pinned rendering
# environment, exports it as a portable bundle, and writes down everything a reviewer needs
# to judge it.
#
# This is the *only* place in the repository that approves anything, and it is run
# deliberately: by `workflow_dispatch` (.github/workflows/baseline-update.yml) or by hand
# (`scripts/ci/in-container.sh generate-baseline.sh`). It is never part of a gate. The
# workflow does not commit what this produces; a human reviews the bundle, sees the image
# hash and the run it came from, and commits it. That separation is the whole point — a
# baseline that approves itself during a check cannot protect anything.
#
# Usage
#   generate-baseline.sh --out <bundle dir> [--store <dir>] [--artifacts <dir>]
#                        [--config <file>] [--project <id>] [--route <id>]
#                        [--viewport <id>] [--note <text>]
#                        [--app-cmd <cmd>] [--app-health <url>]
#
# Exit
#   0  the bundle was written (and nothing in the repository was changed)
#   2  the capture, approval or export failed
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
generate-baseline.sh — approve a baseline in the pinned environment and export a bundle

Usage
  generate-baseline.sh --out <bundle dir> [options]

Options
  --out <dir>          Bundle directory to write (required; must not already hold a
                       different image for the same version)
  --store <dir>        Scratch store to build   (default: .uiproof/ci-store)
  --artifacts <dir>    Where logs land          (default: .uiproof/ci-artifacts)
  --config <file>      Registration file        (default: examples/ci/uiproof.config.json)
  --project <id>       Registered project       (default: example-app)
  --route <id>         Registered route         (default: home)
  --viewport <id>      desktop | tablet | mobile(default: desktop)
  --note <text>        Note recorded on the approved version
  --app-cmd <cmd>      Command that starts the application under test
  --app-health <url>   Endpoint that answers when it is ready
  --help               Show this help

Exit codes
  0  the bundle was written
  2  the capture, approval or export failed
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

OUT=""
STORE=""
ARTIFACTS=""
CONFIG="$UIPROOF_CONFIG_DEFAULT"
PROJECT="$UIPROOF_PROJECT_DEFAULT"
ROUTE=""
VIEWPORT="$UIPROOF_VIEWPORT_DEFAULT"
NOTE=""
APP_CMD="$UIPROOF_APP_CMD_DEFAULT"
APP_HEALTH="$UIPROOF_APP_HEALTH_DEFAULT"

ci_parse_args "generate-baseline.sh" \
  "--out:OUT" \
  "--store:STORE" \
  "--artifacts:ARTIFACTS" \
  "--config:CONFIG" \
  "--project:PROJECT" \
  "--route:ROUTE" \
  "--viewport:VIEWPORT" \
  "--note:NOTE" \
  "--app-cmd:APP_CMD" \
  "--app-health:APP_HEALTH" \
  -- "$@"

[ -n "$OUT" ] || ci_fail "generate-baseline.sh: --out <bundle directory> is required."
[ -n "$ROUTE" ] || ROUTE="$UIPROOF_ROUTE_DEFAULT"
if [ -z "$NOTE" ]; then
  NOTE="approved in the pinned rendering environment ($UIPROOF_IMAGE_TAG)"
fi

STORE="${STORE:-.uiproof/ci-store}"
ARTIFACTS="${ARTIFACTS:-.uiproof/ci-artifacts}"
export UIPROOF_APP_CMD="$APP_CMD"
export UIPROOF_APP_HEALTH="$APP_HEALTH"
export UIPROOF_APP_LOG="$ARTIFACTS/app.log"

rm -rf "$STORE"
mkdir -p "$STORE" "$ARTIFACTS"

trap 'ci_stop_app' EXIT

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "not a git checkout")"
DIRTY="$(git status --porcelain -- examples/example-app 2>/dev/null || true)"

ci_heading "Generating an approved baseline"
ci_info "image:      $UIPROOF_IMAGE"
ci_info "node:       $(node -v)"
ci_info "playwright: $(node -e 'process.stdout.write(require("playwright/package.json").version)')"
ci_info "chromium:   revision $UIPROOF_CHROMIUM_REVISION"
ci_info "fonts:      system-ui resolves to $(fc-match -f '%{family}' system-ui 2>/dev/null || echo 'unknown')"
ci_info "commit:     $COMMIT"
ci_info "scope:      $PROJECT · route $ROUTE · viewport $VIEWPORT"
if [ -n "$DIRTY" ]; then
  ci_warn "the application source has uncommitted changes; a baseline is only trustworthy if you commit the exact tree it was rendered from:"
  printf '%s\n' "$DIRTY" | sed 's/^/       /'
fi

ci_heading "1 · Capture and approve"
ci_start_app

CAPTURE_STATUS=0
ci_run_capture "$ARTIFACTS/capture.json" "$ARTIFACTS/capture.log" \
  ci_uiproof capture --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --config "$CONFIG" --storage "$STORE" --approve --note "$NOTE" --json || CAPTURE_STATUS=$?
cat "$ARTIFACTS/capture.log"
if [ "$CAPTURE_STATUS" -ne 0 ]; then
  ci_error "the capture or the approval failed (exit $CAPTURE_STATUS)"
  cat "$ARTIFACTS/capture.json"
  exit "$CI_INFRASTRUCTURE"
fi

VERSION_ID="$(ci_json_get "$ARTIFACTS/capture.json" approved.id)"
REPORT_ID="$(ci_json_get "$ARTIFACTS/capture.json" report.id)"
REPORT_PATH="$(ci_json_get "$ARTIFACTS/capture.json" reportPath)"
[ -n "$VERSION_ID" ] || ci_fail "generate-baseline.sh: the capture reported no approved version."
ci_ok "approved $VERSION_ID (from run $REPORT_ID)"
ci_info "the raw capture is kept in the run's report: $REPORT_PATH"

ci_heading "2 · The store, as the approval left it"
ci_uiproof baselines status --config "$CONFIG" --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --storage "$STORE" | tee "$ARTIFACTS/baselines-status.txt"

ci_heading "3 · Export the portable bundle"
EXPORT_STATUS=0
ci_run_capture "$ARTIFACTS/export.json" "$ARTIFACTS/export.log" \
  ci_uiproof baselines export --project "$PROJECT" --route "$ROUTE" --viewport "$VIEWPORT" \
  --config "$CONFIG" --storage "$STORE" --out "$OUT" --json || EXPORT_STATUS=$?
cat "$ARTIFACTS/export.log"
if [ "$EXPORT_STATUS" -ne 0 ]; then
  ci_error "the bundle could not be exported (exit $EXPORT_STATUS) — an existing bundle is never rewritten with different content"
  cat "$ARTIFACTS/export.json"
  exit "$CI_INFRASTRUCTURE"
fi

MANIFEST="$OUT/uiproof-baselines.json"
[ -f "$MANIFEST" ] || ci_fail "generate-baseline.sh: the export reported success but $MANIFEST does not exist."

IMAGE_FILE="$(node -e '
  const fs = require("node:fs");
  const [file, versionId] = process.argv.slice(1);
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const scope of bundle.scopes ?? []) {
    const version = (scope.versions ?? []).find((entry) => entry.id === versionId);
    if (version) {
      process.stdout.write(version.file);
      break;
    }
  }
' "$MANIFEST" "$VERSION_ID")"
[ -n "$IMAGE_FILE" ] || ci_fail "generate-baseline.sh: the exported bundle does not list $VERSION_ID."
IMAGE_SHA="$(ci_sha256 "$OUT/$IMAGE_FILE")"
IMAGE_BYTES="$(wc -c <"$OUT/$IMAGE_FILE" | tr -d ' ')"
MANIFEST_SHA="$(ci_sha256 "$MANIFEST")"

ci_ok "bundle written to $OUT"
ci_info "manifest sha256: $MANIFEST_SHA"
ci_info "image:           $IMAGE_FILE"
ci_info "image sha256:    $IMAGE_SHA ($IMAGE_BYTES bytes)"

ci_heading "4 · Provenance"
PROVENANCE="$ARTIFACTS/provenance.txt"
{
  printf 'uiproof approved baseline\n'
  printf 'generated:      %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'rendering image: %s\n' "$UIPROOF_IMAGE"
  printf 'image digest:    %s\n' "$UIPROOF_IMAGE_DIGEST"
  printf 'chromium:        revision %s\n' "$UIPROOF_CHROMIUM_REVISION"
  printf 'playwright:      %s\n' "$(node -e 'process.stdout.write(require("playwright/package.json").version)')"
  printf 'node:            %s\n' "$(node -v)"
  printf 'fc-match system-ui: %s\n' "$(fc-match -f '%{family}' system-ui 2>/dev/null || echo unknown)"
  printf 'repository:      %s\n' "$COMMIT"
  printf 'app dirty:       %s\n' "${DIRTY:-no}"
  printf 'config:          %s\n' "$CONFIG"
  printf 'scope:           project:%s/%s @ %s\n' "$PROJECT" "$ROUTE" "$VIEWPORT"
  printf 'approved:        %s\n' "$VERSION_ID"
  printf 'note:            %s\n' "$NOTE"
  printf 'source run:      %s\n' "$REPORT_ID"
  printf 'report:          %s\n' "$REPORT_PATH"
  printf 'bundle manifest: %s sha256=%s\n' "$MANIFEST" "$MANIFEST_SHA"
  printf 'bundle image:    %s sha256=%s bytes=%s\n' "$IMAGE_FILE" "$IMAGE_SHA" "$IMAGE_BYTES"
} | tee "$PROVENANCE"

ci_heading "5 · What to do with it"
ci_info "Nothing in the repository was changed. Review the bundle, then commit it:"
ci_info "  git add $OUT"
ci_info "  git diff --cached --stat $OUT    # a new image and a manifest, nothing else"
if git rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git status --porcelain -- "$OUT" 2>/dev/null || true)" ]; then
  ci_info "  git status --porcelain $OUT"
fi
ci_info "Provenance for the commit message: $PROVENANCE"
ci_info "The gate that uses this bundle must run the same image ($UIPROOF_IMAGE_TAG)."
