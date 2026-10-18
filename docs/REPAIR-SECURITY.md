# What a repair is allowed to touch

A repair runs **a model's patch** and **your own build and test commands**. Both are code
with your privileges unless something stops them. This page says exactly what stops them,
what is proven by tests rather than by intention, and what the model still is.

Everything below is enforced by `src/lib/repair/container.ts` and asserted against a real
container runtime in `e2e/repair-container.test.ts`.

---

## The short version

| Question | Answer |
| --- | --- |
| Where does the patched application run? | In a container, by default. `repair.execution.mode` is `container`. |
| Can it reach the network? | No. `--network none` — the container has a loopback interface and nothing else. |
| Can it write outside the checkout? | No. The root filesystem is read-only; `/work` (a throwaway copy) and `/tmp` are the writable paths. |
| Can it read your credentials? | No. The environment is an allow-list, and a registration refuses secret-looking names outright. |
| Can it rewrite its own dependencies? | No. The dependency volume is mounted read-only after it is installed once. |
| Can it escape into your machine generally? | Not through anything Docker's isolation covers. It shares the host kernel — see [What this is not](#what-this-is-not). |
| What if no container runtime is available? | The repair is **refused**, with instructions. UIProof does not silently fall back to running generated code on your machine. |
| What if you want host execution anyway? | Say so in writing: `"mode": "host"` **and** `"trustHostExecution": true`. The run record then says it was not isolated. |

---

## The execution model

```
┌─ your machine ────────────────────────────────────────────────────────────────┐
│                                                                               │
│  UIProof (Node)                                                               │
│    ├─ Chromium (Playwright) ─┐                                                │
│    │                          │  HTTP to http://127.0.0.1:<port>             │
│    ├─ TCP listener ◄──────────┘                                               │
│    │       │                                                                  │
│    │       │  frames over the container's stdin/stdout                        │
│    │       ▼                                                                  │
│  ┌─ container (docker run) ─────────────────────────────────────────────────┐  │
│  │  --network none        no interface except loopback                      │  │
│  │  --read-only           immutable root filesystem                         │  │
│  │  --cap-drop ALL        no capabilities                                   │  │
│  │  --security-opt no-new-privileges                                        │  │
│  │  --pids-limit, --memory, --cpus                                          │  │
│  │                                                                          │  │
│  │  /uiproof-relay  (read-only, UIProof's own relay)                        │  │
│  │  /work           (read-write: the checkout that was copied)              │  │
│  │  /work/node_modules (read-only volume: dependencies, installed once)     │  │
│  │                                                                          │  │
│  │  relay.mjs ──spawns──► the application's own server on 127.0.0.1:<port>  │  │
│  │      │                                                                   │  │
│  │      └── bridges that HTTP onto the container's stdio ───────────────────┼──┼─►
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Why a relay instead of a published port.** Publishing a port means giving the container a
network interface, and a container with an interface can reach things. The relay gives the
application *no* interface: it listens on the container's own loopback, and UIProof carries
the bytes out over the container's stdio. Chromium is unaware — for it, the URL is the same
`http://127.0.0.1:<port>` it would use for a local dev server. The container still cannot
open a connection to anything.

**What runs where.** The application's `build`, `test`, and server commands are
developer-authored argument vectors from `uiproof.config.json`, run without a shell. The
model never supplies a command. The patch it supplies is parsed as data, validated against
the files it was shown, and written as file contents inside `/work` — it is never executed
as a program and never interpreted by a shell.

---

## What the tests prove

`e2e/repair-container.test.ts` asks the container itself, and fails if any answer is wrong:

| Claim | How it is checked |
| --- | --- |
| No network interface | `os.networkInterfaces()` inside the container reports no non-loopback address; an outbound `fetch` fails. |
| Read-only root | Writing `/uiproof-root-write-test` fails with `EROFS`; `/work` and `/tmp` accept writes. |
| No capabilities | `/proc/self/status` reports `CapEff: 0000000000000000`. |
| Bounded processes | Starting 600 children reports far fewer than 600 started. |
| Bounded memory | The container's cgroup limit equals the configured `memoryMb`. |
| No credentials | A host-side `UIPROOF_AI_API_KEY` is `absent` inside; host path variables are not present. |
| Loopback still works | A server started in the container is reached at `http://127.0.0.1:<port>` from the host, with the container still having no network. |
| Nothing is left behind | After a run, no container carrying the run's label exists. |
| The whole pipeline works there | A complete repair (audit → model → patch → build → test → re-measure → verdict) against a containerized fixture, plus the same against independent Vite and Next.js applications. |

When no container runtime answers, that suite is **skipped and says so** — a skip is
recorded as a skipped check in the report, never as a pass.

---

## Configuration

```json
{
  "repair": {
    "execution": {
      "mode": "container",
      "runtime": "auto",
      "image": "node:24-bookworm-slim",
      "network": "none",
      "memoryMb": 2048,
      "cpus": 2,
      "pidsLimit": 512,
      "dependenciesVolume": "uiproof-my-app-deps",
      "install": ["npm", "ci", "--no-audit", "--no-fund"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `mode` | `container` (default) or `host`. `host` additionally requires `trustHostExecution: true`. |
| `runtime` | `auto` (docker, then podman), or either one explicitly. |
| `image` | Required in container mode, and must carry an explicit tag — an untagged image can change under a run. It must contain Node 20+ (the relay is Node). |
| `network` | `none` by default. `egress` attaches the default bridge network and is recorded in the run as the weaker option. |
| `memoryMb`, `cpus`, `pidsLimit` | Enforced by the runtime, recorded in the run. |
| `user` | Optional `uid` or `uid:gid`. Left unset, the image's own user applies — on Linux, binding the checkout read-write as a different uid is a permissions problem, not a security win. |
| `dependenciesVolume` | A named volume holding the application's installed dependencies, mounted read-only at `/work/node_modules`. |
| `install` | Run **once**, with network access, to fill that volume when it does not exist yet. Everything after it runs with no network. |

The image is pulled on the host if it is missing (never from inside the sandbox), and the
event is recorded as a warning on the run.

---

## What this is not

1. **Not a virtual machine.** Containers share the host kernel. The flags above are the
   runtime's isolation plus sensible restrictions; they are not a defence against a kernel
   exploit, and nothing here should be sold as one.
2. **Not a network policy for `egress` mode.** If you set `"network": "egress"`, the
   container is on the default bridge and can reach the network. The run record says so.
3. **Not a sandbox for the model's *text*.** A patch is data — parsed, scope-checked,
   applied to a copy, and measured. But a patch can still contain malicious *application*
   code, and that code runs in the container while the repair is measured. The container is
   what makes that acceptable; the scope check (`repair.allow`) is what keeps it near the
   files the model was shown.
4. **Not a promise that a repair is correct.** A verified verdict means: the measured
   defect is gone, no measured route or viewport regressed, the build and tests passed, the
   patch stayed inside scope, and the tree did not move. It does not mean the patch is good
   code, and it is never applied to your working tree.

## Host execution: the honest description

`"mode": "host"` runs the patched application and your commands as ordinary child processes
of UIProof, with your environment allow-listed but your privileges intact. The sandbox is
then a **filesystem copy**: it protects your source tree from being written to, and nothing
else. That is why it needs `"trustHostExecution": true`, why every run record carries
`execution.summary` with those words, why the CLI prints a warning, and why the dashboard
shows a badge on the run instead of a green tick.
