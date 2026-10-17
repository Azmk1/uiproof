#!/usr/bin/env bash
#
# Extracts the *trusted checker* from a git ref — the gate's own implementation.
#
# The visual and quality gates start the application under test from the pull request's
# working tree, because that application is what the pull request is changing. The code that
# produces the verdict is a different thing entirely, and it must not be controlled by the
# same commit: a pull request that can rewrite `src/lib/quality/policy.ts`, `src/cli/main.ts`
# or `scripts/ci/audit-gate.sh` can make the gate answer whatever it likes.
#
# So the gate runs two revisions at once:
#
#   * the **application under test** — the working tree, untrusted, started with `env -i`;
#   * the **checker** — `src/`, `scripts/` and `package.json` extracted with `git archive`
#     from the pull request's base branch. `git archive` reads the committed tree of that
#     ref, so neither the working tree nor the pull request's commits can influence it.
#
# What this extraction does *not* isolate, stated plainly rather than left implied:
#
#   * **Dependencies.** The extracted checker is pointed at the workspace's `node_modules`
#     (a symlink, created here), which were installed from the pull request's lockfile. A
#     pull request that edits `pnpm-lock.yaml` can change the dependency code the checker
#     runs. CODEOWNERS routes those files to review; a fully hermetic answer would install
#     the base revision's lockfile in a separate directory and is the next step, not a claim
#     this script makes.
#   * **`examples/ci/uiproof.config.json`** is extracted here too when it exists, so the
#     project/route registration is the base revision's as well.
#   * **The application under test** is the pull request's code by design. It runs with a
#     scrubbed environment; it cannot write to the trusted reference, which is imported into
#     a store this job owns.
#
# Run it and read its output; a claim of isolation that cannot be reproduced is worth
# nothing.
#
# Usage
#   trusted-checker.sh --from-ref <ref> --into <dir> [--link-node-modules <dir>]
#                      [--config-path <path>] [--provenance <file>]
#
# Exit
#   0  the checker was extracted (and, if asked, the dependency link made)
#   2  the ref has no usable checker, or the extraction did not contain what a gate needs
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
trusted-checker.sh — extract the gate's own implementation from a protected revision

Usage
  trusted-checker.sh --from-ref <ref> --into <dir> [options]

Options
  --from-ref <ref>             Commit or branch to read the checker from (required)
  --into <dir>                 Directory to extract it into (required; replaced)
  --link-node-modules <dir>    Point <dir>/node_modules at this installed tree, so the
                               extracted checker can resolve its dependencies
  --config-path <path>         Registration file to extract as well, when present
                               (default: examples/ci/uiproof.config.json)
  --provenance <file>          Also write a provenance record to this file
  --help                       Show this help

Exit codes
  0  extracted · 2 the ref has no usable checker
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

FROM_REF=""
INTO=""
LINK_NODE_MODULES=""
CONFIG_PATH="$UIPROOF_CONFIG_DEFAULT"
PROVENANCE=""

ci_parse_args "trusted-checker.sh" \
  "--from-ref:FROM_REF" \
  "--into:INTO" \
  "--link-node-modules:LINK_NODE_MODULES" \
  "--config-path:CONFIG_PATH" \
  "--provenance:PROVENANCE" \
  -- "$@"

[ -n "$FROM_REF" ] || ci_fail "trusted-checker.sh: --from-ref <ref> is required."
[ -n "$INTO" ] || ci_fail "trusted-checker.sh: --into <dir> is required."
case "$INTO" in
  / | "" ) ci_fail "trusted-checker.sh: refusing to use $INTO as the output directory." ;;
esac
ci_require_cmd git
ci_trust_the_workspace

ci_heading "Trusted checker"
ci_info "ref:  $FROM_REF"
ci_info "into: $INTO"

COMMIT="$(git rev-parse --verify --quiet "${FROM_REF}^{commit}")" ||
  ci_fail "trusted-checker.sh: \"$FROM_REF\" is not a commit in this repository."
COMMIT_SUBJECT="$(git log -1 --format='%s' "$COMMIT")"
COMMIT_DATE="$(git log -1 --format='%cI' "$COMMIT")"
ci_info "commit: $COMMIT ($COMMIT_DATE)"
ci_info "subject: $COMMIT_SUBJECT"

# The paths a gate needs. `package.json` comes along because the CLI reports its version
# from it (`src/cli/main.ts` imports it); `examples/ci` because the registration file the
# gate audits through is part of the checker's configuration, not the application's code.
PATHS=(scripts src package.json)
CONFIG_FROM_COMMIT="no"
if git cat-file -e "$COMMIT:$CONFIG_PATH" 2>/dev/null; then
  PATHS+=("$CONFIG_PATH")
  CONFIG_FROM_COMMIT="yes"
  ci_info "will extract the registration file $CONFIG_PATH from the same commit"
else
  ci_warn "commit $COMMIT has no $CONFIG_PATH; the caller's registration file will be used"
fi

EXTRACTED="$(mktemp -d)"
trap 'rm -rf "$EXTRACTED"' EXIT

if ! git archive --format=tar "$COMMIT" -- "${PATHS[@]}" | tar -x -C "$EXTRACTED"; then
  ci_fail "trusted-checker.sh: could not extract the checker from commit $COMMIT."
fi

rm -rf "$INTO"
mkdir -p "$(dirname "$INTO")"
mv "$EXTRACTED" "$INTO"
trap - EXIT

for required in scripts/uiproof.mjs scripts/ci/audit-gate.sh src/cli/main.ts src/lib/quality/policy.ts; do
  [ -f "$INTO/$required" ] ||
    ci_fail "trusted-checker.sh: commit $COMMIT has no $required; it cannot gate anything. A base branch older than the gate cannot judge a pull request against it."
done

# The registration file gets one predictable path inside the extraction, so a caller never has
# to reconstruct where it came from: `$INTO/uiproof.config.json`. Absent here means the commit
# had none, and the caller's own file is used instead — which the provenance records.
TRUSTED_CONFIG=""
if [ "$CONFIG_FROM_COMMIT" = "yes" ]; then
  cp "$INTO/$CONFIG_PATH" "$INTO/uiproof.config.json"
  TRUSTED_CONFIG="$INTO/uiproof.config.json"
  ci_info "registration file at $TRUSTED_CONFIG (extracted from $CONFIG_PATH)"
fi

# The one link back into the workspace, named as a limitation rather than hidden: the
# extracted checker borrows the installed dependencies of the revision under test.
NODE_MODULES_STATE="not linked"
if [ -n "$LINK_NODE_MODULES" ]; then
  [ -d "$LINK_NODE_MODULES" ] ||
    ci_fail "trusted-checker.sh: $LINK_NODE_MODULES does not exist, so the checker could not resolve its dependencies."
  ln -s "$(cd "$LINK_NODE_MODULES" && pwd)" "$INTO/node_modules"
  NODE_MODULES_STATE="symlinked to $LINK_NODE_MODULES (the dependency tree is still the revision under test's)"
  ci_warn "the extracted checker uses the workspace's installed dependencies: a dependency change in the pull request is still in the trust boundary"
fi

# A stolen identifier from the extracted tree, so two runs' logs can be compared.
CHECKER_ID="$(ci_sha256 "$INTO/src/lib/quality/policy.ts")"
ci_ok "extracted the checker from $COMMIT"
ci_info "policy.ts sha256: $CHECKER_ID"
ci_info "node_modules:      $NODE_MODULES_STATE"

if [ -n "$PROVENANCE" ]; then
  mkdir -p "$(dirname "$PROVENANCE")"
  {
    printf 'trusted checker\n'
    printf 'ref:            %s\n' "$FROM_REF"
    printf 'commit:         %s\n' "$COMMIT"
    printf 'committed:      %s\n' "$COMMIT_DATE"
    printf 'subject:        %s\n' "$COMMIT_SUBJECT"
    printf 'into:           %s\n' "$INTO"
    printf 'policy sha256:  %s\n' "$CHECKER_ID"
    printf 'entry point:    %s\n' "$INTO/scripts/uiproof.mjs"
    printf 'config:         %s\n' "${TRUSTED_CONFIG:-none in $COMMIT; the caller supplied one}"
    printf 'node_modules:   %s\n' "$NODE_MODULES_STATE"
    printf 'rendering image: %s\n' "$UIPROOF_IMAGE"
  } >"$PROVENANCE"
  ci_info "provenance written to $PROVENANCE"
fi
