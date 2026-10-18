# Changelog

UIProof releases are cut from `main` at a tagged commit. The version in
`package.json` is the version the CLI reports (`uiproof --version`) and the version the
dashboard footer shows; nothing else in the project carries a version of its own.
[`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md) is the procedure that produces a
tarball from it.

## 0.2.0-rc.1 — release candidate

The first release candidate: installable, measured, and explicit about what it does not
claim.

### Repair execution now has an operating-system boundary

- Every repair runs in a container by default: `--network none`, a read-only root
  filesystem, `--cap-drop ALL`, `--security-opt no-new-privileges`, and configurable
  memory, CPU and process limits. The checkout is the only writable mount.
- Loopback testing is preserved without giving the container a network: a small relay
  inside the container forwards the application's own HTTP onto the container's stdio, and
  UIProof terminates it on `127.0.0.1` where Chromium expects it.
- Dependencies are installed inside the container into a named volume — a Windows
  `node_modules` is never handed to Linux, and the volume is mounted read-only after the
  one-time install.
- Host execution, which is a filesystem copy and not a security boundary, now requires
  `"trustHostExecution": true` in the registration. Without it the repair is refused with
  that sentence in the error.
- `docs/REPAIR-SECURITY.md` states the model, the flags, and the four things this is *not*.

### A verdict is withdrawn when the tree moves

- If the developer's source changes while a repair runs — content, `HEAD`, or uncommitted
  state — every verdict from that run, including `verified`, becomes `unverified`, with the
  reason recorded first in the list. The measurements stay; the claim does not.
- Guard routes must be measured before *and* after; a page that was measured before and not
  after leaves the candidate unverified instead of silently unguarded.
- A `verified` verdict now requires a recorded passing build *and* test result. Missing
  results, even an empty list, can no longer read as success.
- An unusable model answer is stored (`attempt-N-reply.txt`) beside the rejected patch, so a
  rejected attempt is evidence whether or not it applied.

### Installation

- Published contents are the CLI: `bin/`, `dist/cli/`, `package.json`, `README.md`,
  `CHANGELOG.md` and `docs/REPAIR-SECURITY.md` — a 416 KB tarball (425,845 bytes when packed here),
  no Next.js, no source, no tests.
- The package declares the four dependencies the CLI loads (axe-core, pixelmatch,
  playwright, pngjs) as `dependencies` and everything the dashboard needs as
  `devDependencies`, so installing a gate no longer downloads a web framework.
- Chromium is installed explicitly (`npx playwright install chromium`) and pinned by
  `playwright@1.64.1`; the pin, the browser revision and the rendering image are checked by
  `pnpm test`.
- The package stays `private: true`. Publishing is a deliberate, documented step.

### Documentation

- `README.md`: install, first run, configuration, troubleshooting.
- `docs/RELEASE-CHECKLIST.md`: versioning, what must pass, how to pack, how to publish.
- `docs/BENCHMARK.md`: the defect benchmark, what it measures and which numbers are real.

## 0.1.0

Internal development released as a local tarball for the independent pilot: capture,
compare, approve, portable baselines, accessibility and responsive audits, the quality
gate, the pinned rendering environment, AI diagnosis and the first isolated repair engine.
Never published to a registry.
