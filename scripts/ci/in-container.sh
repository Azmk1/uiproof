#!/usr/bin/env bash
#
# Runs one of the scripts in this directory inside the pinned rendering container.
#
# The GitHub workflows run these scripts inside that container (`container:` in the job). This
# is the same thing on a laptop, so a bundle generated here and a verdict a gate reaches in CI
# come from the same Chromium build, the same fonts and the same image digest:
#
#   bash scripts/ci/in-container.sh trusted-baseline.sh --from-ref HEAD --into /out/trusted
#   bash scripts/ci/in-container.sh run-gate.sh --bundle /out/trusted --artifacts /out/reports
#   bash scripts/ci/in-container.sh walkthrough.sh --bundle /out/trusted --trusted-ref HEAD
#   bash scripts/ci/in-container.sh generate-baseline.sh --out /out/bundle --artifacts /out/reports
#
# The container is given a *clean copy* of this working tree — no node_modules, no .next, no
# store — which is a fresh-runner simulation rather than your development checkout, plus a host
# directory mounted at /out. Every path an argument names should live under /out, so the same
# arguments mean the same thing inside the container as outside it. The host path of /out is
# printed when the run finishes.
#
# Usage
#   in-container.sh <script.sh> [script arguments...]
#
# Environment
#   UIPROOF_HOST_OUT     Host directory to mount at /out (default: a fresh temporary directory)
#   UIPROOF_PNPM_VOLUME  Named volume caching the pnpm store (default: uiproof-pnpm-store)
#
# Exit
#   the exit code of the script inside the container
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
in-container.sh — run a scripts/ci script inside the pinned rendering container

Usage
  in-container.sh <script.sh> [script arguments...]

Example
  in-container.sh walkthrough.sh --bundle /out/trusted --trusted-ref HEAD

Environment
  UIPROOF_HOST_OUT     Host directory mounted at /out (default: a fresh temporary directory)
  UIPROOF_PNPM_VOLUME  Named volume for the pnpm store (default: uiproof-pnpm-store)

Everything an argument names should be under /out; the host location of /out is printed at
the end of the run.
EOF
}

if ci_wants_help "$@"; then
  usage
  exit 0
fi

[ "$#" -ge 1 ] || {
  usage
  exit "$CI_INFRASTRUCTURE"
}

SCRIPT="$1"
shift

[ -f "scripts/ci/$SCRIPT" ] || ci_fail "in-container.sh: scripts/ci/$SCRIPT does not exist."
ci_require_cmd docker
docker info >/dev/null 2>&1 ||
  ci_fail "in-container.sh: the Docker daemon is not reachable. Start Docker and try again."

# Git Bash hands docker a POSIX path unless told not to; `pwd -W` gives the Windows spelling.
HOST_ROOT="$(pwd -W 2>/dev/null || pwd)"
OUT_DIR="${UIPROOF_HOST_OUT:-$(mktemp -d)}"
mkdir -p "$OUT_DIR"
PNPM_VOLUME="${UIPROOF_PNPM_VOLUME:-uiproof-pnpm-store}"

ci_heading "Running scripts/ci/$SCRIPT in the pinned rendering container"
ci_info "image:     $UIPROOF_IMAGE"
ci_info "workspace: clean copy of $HOST_ROOT"
ci_info "outputs:   $OUT_DIR (mounted at /out)"

INNER='
set -euo pipefail
mkdir -p /work
tar -C /host -cf - \
  --exclude=./node_modules --exclude=./.next --exclude=./.uiproof --exclude=./.logs . |
  tar -C /work -xf -
cd /work
export CI=1
echo "uiproof-container: node $(node -v), $(corepack pnpm --version 2>/dev/null || echo "pnpm unavailable")"
if ! corepack pnpm install --frozen-lockfile --store-dir /pnpm-store >/out/pnpm-install.log 2>&1; then
  echo "uiproof-container: pnpm install failed; last 40 lines of /out/pnpm-install.log"
  tail -40 /out/pnpm-install.log
  exit 2
fi
echo "uiproof-container: dependencies installed ($(grep -c . /out/pnpm-install.log) log lines)"
script="$1"
shift
exec bash "scripts/ci/$script" "$@"
'

STATUS=0
MSYS_NO_PATHCONV=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 docker run --rm \
  -v "${HOST_ROOT}:/host:ro" \
  -v "${OUT_DIR}:/out" \
  -v "${PNPM_VOLUME}:/pnpm-store" \
  -w /work \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "$UIPROOF_IMAGE" \
  bash -lc "$INNER" -- "$SCRIPT" "$@" || STATUS=$?

ci_heading "Container finished"
ci_info "exit code: $STATUS"
ci_info "outputs:   $OUT_DIR"
exit "$STATUS"
