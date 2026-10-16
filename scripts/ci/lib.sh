#!/usr/bin/env bash
# Shared configuration and helpers for the CI scripts in this directory.
#
# One implementation, two places to run it. Every step of the GitHub workflows in
# `.github/workflows` calls one of these scripts, and the same scripts run on a laptop
# inside the pinned container (`scripts/ci/in-container.sh`). A workflow step and a local
# reproduction therefore cannot disagree about what the gate does: there is only one copy
# of the logic, and the container is the same one in both places.
#
# ── The rendering environment ────────────────────────────────────────────────────────────
# A baseline is a screenshot, and a screenshot depends on the machine that took it: the
# Chromium build, the fonts, the rasteriser, the colour profile. Comparing images rendered
# by different machines produces differences nobody made, so the environment is pinned twice
# over:
#
#   * the Chromium build, by an exact dependency in package.json (`"playwright": "1.64.1"`,
#     no caret) and by the container tag below, which Playwright publishes per release;
#   * the image itself, by tag *and* digest — a tag is mutable, a digest is not. Fonts,
#     fontconfig, libc and the browser all come from this image.
#
# `src/lib/ci/rendering-environment.test.ts` fails `pnpm test` when those pins drift apart,
# and `scripts/ci/generate-baseline.sh` records the whole environment in the bundle's
# provenance. Nothing in this file is a secret: it is the environment, written down.

# ── The pinned image ─────────────────────────────────────────────────────────────────────
# Keep the tag, the digest and package.json's playwright version in step; the unit test
# above enforces it. Reproduce a bundle with:
#   docker run --rm -v "$PWD:/host:ro" <image> ...
UIPROOF_IMAGE_TAG="v1.64.1-noble"
UIPROOF_IMAGE_DIGEST="sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf"
UIPROOF_IMAGE="mcr.microsoft.com/playwright:${UIPROOF_IMAGE_TAG}@${UIPROOF_IMAGE_DIGEST}"
# The Chromium revision the image ships, recorded in provenance. The unit test checks it
# against the revision Playwright pins for the version in package.json.
UIPROOF_CHROMIUM_REVISION="1248"

# ── Defaults for the example application this repository gates ───────────────────────────
# A developer gates their own application by pointing these at it; nothing below is special
# to the example app except these strings.
UIPROOF_CONFIG_DEFAULT="examples/ci/uiproof.config.json"
UIPROOF_PROJECT_DEFAULT="example-app"
UIPROOF_ROUTE_DEFAULT="home"
UIPROOF_VIEWPORT_DEFAULT="desktop"
UIPROOF_BUNDLE_PATH_DEFAULT="examples/uiproof-baselines"
UIPROOF_APP_CMD_DEFAULT="node examples/example-app/server.mjs"
UIPROOF_APP_HOST_DEFAULT="127.0.0.1"
UIPROOF_APP_PORT_DEFAULT="4173"
UIPROOF_APP_HEALTH_DEFAULT="http://127.0.0.1:4173/healthz"

# Exit codes, the same ones the CLI documents. A CI job is the interface here, so nothing
# in these scripts invents a code of its own: an infrastructure failure is a 2, exactly as
# `uiproof check` reports one.
readonly CI_PASS=0
readonly CI_REGRESSION=1
readonly CI_INFRASTRUCTURE=2

# ── Output ───────────────────────────────────────────────────────────────────────────────
# `::error::`/`::warning::` are GitHub log annotations; in a terminal they read as plain
# text, which is what a local run wants.
ci_say() { printf '%s\n' "$*"; }
ci_heading() { printf '\n── %s\n' "$*"; }
ci_ok() { printf 'ok   %s\n' "$*"; }
ci_info() { printf '     %s\n' "$*"; }
ci_error() { printf '::error::%s\n' "$*" >&2; }
ci_warn() { printf '::warning::%s\n' "$*" >&2; }
ci_fail() {
  ci_error "$*"
  exit "$CI_INFRASTRUCTURE"
}

# Every script here answers `--help` with its own usage text and a success code.
ci_wants_help() {
  for token in "$@"; do
    case "$token" in
      --help | -h) return 0 ;;
    esac
  done
  return 1
}

ci_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || ci_fail "$1 is required but not on PATH."
}

ci_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The CLI, run from source: the same entry point `pnpm uiproof` spawns, without pnpm's own
# banner on stdout — `--json` promises that stdout is exactly one JSON document, and a gate
# that parses it should not have to guess.
ci_uiproof() {
  node scripts/uiproof.mjs "$@"
}

# Reads a dotted path out of a JSON file. Empty output means "absent".
ci_json_get() { # <file> <dotted.path>
  node -e '
    const fs = require("node:fs");
    const [file, keyPath] = process.argv.slice(1);
    let value = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of keyPath.split(".")) {
      if (value === null || value === undefined) break;
      value = value[key];
    }
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1" "$2"
}

# The version a bundle records as approved for one project route — the reference a gate
# expects to be comparing against. Empty output means the bundle does not cover it.
ci_bundle_active_version() { # <manifest> <projectId> [routeId] [viewportId]
  node -e '
    const fs = require("node:fs");
    const [file, projectId, routeId, viewportId] = process.argv.slice(1);
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    const scope = (bundle.scopes ?? []).find(
      (entry) =>
        entry.kind === "project" &&
        entry.projectId === projectId &&
        (!routeId || entry.routeId === routeId) &&
        (!viewportId || entry.viewportId === viewportId),
    );
    process.stdout.write(scope?.activeVersionId ?? "");
  ' "$1" "$2" "${3:-}" "${4:-}"
}

# ── The application under test ───────────────────────────────────────────────────────────
# Untrusted pull-request code runs here, so it is started with `env -i`: nothing the workflow
# holds — a token, a registry credential, a repository secret — is inherited by the process
# being tested. Only what a web application needs to listen on a loopback port is passed,
# plus whatever a caller adds with --app-env.
CI_APP_PID=""

ci_start_app() { # uses UIPROOF_APP_CMD, UIPROOF_APP_HOST, UIPROOF_APP_PORT, UIPROOF_APP_LOG
  local cmd="${UIPROOF_APP_CMD:-$UIPROOF_APP_CMD_DEFAULT}"
  local host="${UIPROOF_APP_HOST:-$UIPROOF_APP_HOST_DEFAULT}"
  local port="${UIPROOF_APP_PORT:-$UIPROOF_APP_PORT_DEFAULT}"
  local log="${UIPROOF_APP_LOG:-/tmp/uiproof-app.log}"
  local health="${UIPROOF_APP_HEALTH:-$UIPROOF_APP_HEALTH_DEFAULT}"
  local attempts="${UIPROOF_HEALTH_ATTEMPTS:-60}"
  local extra=()
  if [ -n "${UIPROOF_APP_ENV:-}" ]; then
    # shellcheck disable=SC2206 # deliberate word splitting: KEY=VALUE pairs
    extra=(${UIPROOF_APP_ENV})
  fi

  : >"$log"
  env -i \
    PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" \
    HOME="${HOME:-/root}" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    HOST="$host" \
    PORT="$port" \
    ${extra[@]+"${extra[@]}"} \
    bash -c "$cmd" >"$log" 2>&1 &
  CI_APP_PID=$!

  ci_info "started the application under test (pid $CI_APP_PID): $cmd"
  ci_info "environment for the application: env -i PATH HOME LANG LC_ALL TZ HOST PORT${UIPROOF_APP_ENV:+ $UIPROOF_APP_ENV}"

  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' "$health" >/dev/null 2>&1; then
      ci_ok "the application answered $health after $attempt attempt(s)"
      return 0
    fi
    if ! kill -0 "$CI_APP_PID" 2>/dev/null; then
      ci_error "the application exited before it became healthy"
      cat "$log" >&2 || true
      return "$CI_INFRASTRUCTURE"
    fi
    sleep 0.5
  done

  ci_error "the application never answered $health after $attempts attempts"
  cat "$log" >&2 || true
  return "$CI_INFRASTRUCTURE"
}

ci_stop_app() {
  if [ -n "$CI_APP_PID" ] && kill -0 "$CI_APP_PID" 2>/dev/null; then
    kill "$CI_APP_PID" 2>/dev/null || true
    wait "$CI_APP_PID" 2>/dev/null || true
    ci_info "stopped the application under test (pid $CI_APP_PID)"
  fi
  CI_APP_PID=""
}

# Runs a command, captures its output and *keeps its exit status*, which is the whole point:
# a filter or a pipe must never be the thing a gate's verdict is read from.
ci_run_capture() { # <stdout-file> <stderr-file> <command...>
  local stdout_file="$1" stderr_file="$2"
  shift 2
  local status=0
  set +e
  "$@" >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e
  return "$status"
}

# The CLI declares what an exit code means; this is the only place that reads it back.
ci_explain_code() {
  case "$1" in
    "$CI_PASS") printf 'the comparison passed' ;;
    "$CI_REGRESSION") printf 'a visual regression was detected' ;;
    "$CI_INFRASTRUCTURE") printf 'the check could not be answered (baseline, configuration, browser or infrastructure)' ;;
    *) printf 'unexpected exit code' ;;
  esac
}

# ── Argument parsing ─────────────────────────────────────────────────────────────────────
# `--flag value` only; no combined short options, no `=`. Small on purpose: every script here
# is called by a workflow step or by a human reading the log, not by another program.
ci_parse_args() { # <script name> <"flag:variable" ...> -- "$@"
  local script="$1"
  shift
  local spec=()
  while [ "$1" != "--" ]; do
    spec+=("$1")
    shift
  done
  shift # the -- separator itself

  while [ "$#" -gt 0 ]; do
    local token="$1"
    local entry matched=""
    for entry in "${spec[@]}"; do
      local flag="${entry%%:*}"
      local variable="${entry#*:}"
      local many="no"
      local switch="no"
      case "$variable" in
        *"*")
          variable="${variable%\*}"
          many="yes"
          ;;
        *"!")
          variable="${variable%!}"
          switch="yes"
          ;;
      esac
      [ "$token" = "$flag" ] || continue
      if [ "$switch" = "yes" ]; then
        printf -v "$variable" '%s' "1"
        shift
        matched="yes"
        break
      fi
      [ "$#" -ge 2 ] || ci_fail "$script: $flag needs a value."
      if [ "$many" = "yes" ] && [ -n "${!variable:-}" ]; then
        printf -v "$variable" '%s %s' "${!variable}" "$2"
      else
        printf -v "$variable" '%s' "$2"
      fi
      shift 2
      matched="yes"
      break
    done
    [ -n "$matched" ] || ci_fail "$script: unknown argument \"$token\". Run it with --help for the options."
  done
}
