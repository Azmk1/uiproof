#!/usr/bin/env bash
#
# Extracts the *trusted* approved baseline from a git ref.
#
# This is the step that makes the gate trustworthy. The bundle a check loads has to come from
# a commit the pull request cannot write to — its base branch — because a pull request that
# can rewrite the baseline it is judged against can always pass. `git archive` reads the
# committed tree of the ref, so uncommitted edits in the working tree (what a pull request
# looks like before anybody commits it) cannot influence the gate either.
#
# The extraction verifies itself on the way out: every version's SHA-256 and byte count are
# recomputed and compared with what the manifest records, so "the trusted baseline" is a
# statement about bytes, not about a file name. The copy in the working tree is compared with
# the trusted one and reported — a difference is *not* a failure (the gate ignoring the
# working tree is the point) but it must be visible in the log, because "I updated the
# baseline and nothing changed" should never be a mystery.
#
# Usage
#   trusted-baseline.sh --from-ref <ref> --into <dir>
#                       [--path <bundle path in the repo>] [--provenance <file>]
#
# Exit
#   0  the trusted bundle was extracted and verified
#   2  the ref does not exist, has no bundle, or the extracted images contradict it
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
trusted-baseline.sh — extract the approved baseline a gate is allowed to trust

Usage
  trusted-baseline.sh --from-ref <ref> --into <dir> [options]

Options
  --from-ref <ref>     Commit, branch or FETCH_HEAD to read the bundle from (required)
  --into <dir>         Directory to extract the bundle into (required; replaced)
  --path <path>        Bundle location inside the repository
                       (default: examples/uiproof-baselines)
  --provenance <file>  Also write a provenance record to this file
  --help               Show this help

Exit codes
  0  extracted and verified
  2  unusable ref, missing bundle, or images that contradict the manifest
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

FROM_REF=""
INTO=""
BUNDLE_PATH="$UIPROOF_BUNDLE_PATH_DEFAULT"
PROVENANCE=""

ci_parse_args "trusted-baseline.sh" \
  "--from-ref:FROM_REF" \
  "--into:INTO" \
  "--path:BUNDLE_PATH" \
  "--provenance:PROVENANCE" \
  -- "$@"

[ -n "$FROM_REF" ] || ci_fail "trusted-baseline.sh: --from-ref <ref> is required."
[ -n "$INTO" ] || ci_fail "trusted-baseline.sh: --into <dir> is required."
case "$INTO" in
  / | "" ) ci_fail "trusted-baseline.sh: refusing to use $INTO as the output directory." ;;
esac
ci_require_cmd git

ci_heading "Trusted baseline"
ci_info "ref:    $FROM_REF"
ci_info "bundle: $BUNDLE_PATH"
ci_info "into:   $INTO"

COMMIT="$(git rev-parse --verify --quiet "${FROM_REF}^{commit}")" ||
  ci_fail "trusted-baseline.sh: \"$FROM_REF\" is not a commit in this repository."
COMMIT_SUBJECT="$(git log -1 --format='%s' "$COMMIT")"
COMMIT_DATE="$(git log -1 --format='%cI' "$COMMIT")"
ci_info "commit: $COMMIT ($COMMIT_DATE)"
ci_info "subject: $COMMIT_SUBJECT"

EXTRACTED="$(mktemp -d)"
trap 'rm -rf "$EXTRACTED"' EXIT

if ! git archive --format=tar "$COMMIT" -- "$BUNDLE_PATH" | tar -x -C "$EXTRACTED"; then
  ci_fail "trusted-baseline.sh: commit $COMMIT has no $BUNDLE_PATH — there is no approved baseline to gate against."
fi

if [ ! -d "$EXTRACTED/$BUNDLE_PATH" ]; then
  ci_fail "trusted-baseline.sh: commit $COMMIT has no $BUNDLE_PATH — there is no approved baseline to gate against."
fi

rm -rf "$INTO"
mkdir -p "$(dirname "$INTO")"
mv "$EXTRACTED/$BUNDLE_PATH" "$INTO"

MANIFEST="$INTO/uiproof-baselines.json"
[ -f "$MANIFEST" ] ||
  ci_fail "trusted-baseline.sh: the bundle at $BUNDLE_PATH in $COMMIT has no $(basename "$MANIFEST")."

# One line per approved version: id, file, recorded SHA-256, recorded byte count.
VERSIONS="$(node -e '
  const fs = require("node:fs");
  const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const scope of bundle.scopes ?? []) {
    const owner = scope.kind === "demo" ? `demo:${scope.targetId}` : `project:${scope.projectId}/${scope.routeId}`;
    for (const version of scope.versions ?? []) {
      process.stdout.write(
        [owner, scope.viewportId, version.id, version.file, version.sha256, version.bytes, scope.activeVersionId ?? ""].join("\t") + "\n",
      );
    }
  }
' "$MANIFEST")"

[ -n "$VERSIONS" ] || ci_fail "trusted-baseline.sh: the bundle manifest lists no approved versions."

VERIFIED=0
while IFS=$'\t' read -r OWNER VIEWPORT VERSION_ID FILE RECORDED_SHA RECORDED_BYTES ACTIVE; do
  [ -n "$FILE" ] || continue
  IMAGE="$INTO/$FILE"
  [ -f "$IMAGE" ] || ci_fail "trusted-baseline.sh: the bundle is missing $FILE, which its manifest requires."
  ACTUAL_SHA="$(ci_sha256 "$IMAGE")"
  ACTUAL_BYTES="$(wc -c <"$IMAGE" | tr -d ' ')"
  if [ "$ACTUAL_SHA" != "$RECORDED_SHA" ]; then
    ci_fail "trusted-baseline.sh: $FILE is not the image the trusted manifest records (expected sha256 $RECORDED_SHA, got $ACTUAL_SHA)."
  fi
  if [ "$ACTUAL_BYTES" != "$RECORDED_BYTES" ]; then
    ci_fail "trusted-baseline.sh: $FILE is $ACTUAL_BYTES bytes, but the trusted manifest records $RECORDED_BYTES."
  fi
  MARK=""
  if [ "$VERSION_ID" = "$ACTIVE" ]; then MARK=" (the active reference)"; fi
  ci_ok "$OWNER @ $VIEWPORT — $VERSION_ID$MARK"
  ci_info "     $FILE"
  ci_info "     sha256 $ACTUAL_SHA · $ACTUAL_BYTES bytes — matches the manifest"
  VERIFIED=$((VERIFIED + 1))
done <<<"$VERSIONS"

# The working tree is compared, reported, and then ignored: whatever a pull request does to
# its own copy of the bundle, the check below runs against $INTO.
WORKING_TREE="$PWD/$BUNDLE_PATH"
DRIFT="the working tree has no $BUNDLE_PATH"
if [ -d "$WORKING_TREE" ]; then
  DIFF_OUTPUT="$(diff -rq "$INTO" "$WORKING_TREE" 2>&1 || true)"
  if [ -z "$DIFF_OUTPUT" ]; then
    DRIFT="identical to the trusted bundle"
  else
    DRIFT="DIFFERS from the trusted bundle"
  fi
fi

if [ "$DRIFT" = "identical to the trusted bundle" ]; then
  ci_info "working tree copy: $DRIFT"
else
  ci_warn "the working tree copy of $BUNDLE_PATH $DRIFT; this check ignores it and uses commit $COMMIT instead."
  printf '%s\n' "$DIFF_OUTPUT" | sed 's/^/       /' | head -20
fi

if [ -n "$PROVENANCE" ]; then
  mkdir -p "$(dirname "$PROVENANCE")"
  {
    printf 'trusted baseline\n'
    printf 'ref:        %s\n' "$FROM_REF"
    printf 'commit:     %s\n' "$COMMIT"
    printf 'committed:  %s\n' "$COMMIT_DATE"
    printf 'subject:    %s\n' "$COMMIT_SUBJECT"
    printf 'bundle:     %s\n' "$BUNDLE_PATH"
    printf 'extracted:  %s\n' "$INTO"
    printf 'versions:   %s\n' "$VERIFIED"
    printf 'working tree copy: %s\n' "$DRIFT"
    printf 'rendering image: %s\n' "$UIPROOF_IMAGE"
    printf '%s\n' "$VERSIONS" | awk -F'\t' 'NF { printf "version:    %s @ %s %s sha256=%s bytes=%s active=%s\n", $1, $2, $3, $5, $6, $7 }'
  } >"$PROVENANCE"
  ci_info "provenance written to $PROVENANCE"
fi

ci_ok "the trusted baseline contains $VERIFIED approved version(s) from commit $COMMIT"
