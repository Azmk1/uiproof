import type { AxeImpact } from "@/lib/quality/types";

/**
 * Domain types for the autonomous repair engine.
 *
 * The rule this feature is built around is the same one that governs the diagnosis, only
 * sharper: **a repair is a proposal, and its verdict comes from a measurement.**
 *
 *  · A `RepairProposal` is model output. It carries the measured issue key it claims to
 *    address, a unified diff, and its own uncertainty. It is never a claim that anything
 *    was fixed.
 *  · A `Verification` is UIProof's own evidence: the same accessibility, layout and visual
 *    measurements taken before and after the patch, inside an isolated checkout, plus the
 *    configured build and test commands. Its `verdict` is computed from those measurements
 *    and can never be read from the model's answer.
 *  · A `RepairRun` records both, separately, and never changes the comparison or audit it
 *    was derived from. The developer's own working tree is not touched at all.
 */

export type RepairVerdict = "verified" | "partially-improved" | "rejected" | "unverified";

/**
 * Where generated application code is allowed to run.
 *
 *  · `container` — every command and the patched application run inside a container with no
 *    network interface, a read-only root filesystem, no added capabilities and bounded
 *    memory/CPU/PIDs. This is the default and the only mode UIProof describes as isolated.
 *  · `host` — the commands run as ordinary child processes of UIProof with the developer's
 *    own privileges. The sandbox is then a filesystem copy and nothing more. It requires an
 *    explicit acknowledgement in the registration (`trustHostExecution: true`).
 */
export type RepairExecutionMode = "container" | "host";

/** The optional `execution` block of a repair registration. Every field is developer-authored. */
export interface RepairExecutionConfig {
  readonly mode: RepairExecutionMode;
  /** `auto` prefers docker, then podman. */
  readonly runtime: "auto" | "docker" | "podman";
  /** Image the sandbox runs in. Required in container mode. */
  readonly image: string | null;
  /**
   * `none` gives the container no network interface at all; UIProof reaches the application
   * through a relay on the container's stdio, so loopback testing still works. `egress`
   * attaches the default bridge network, which is weaker and is recorded as such.
   */
  readonly network: "none" | "egress";
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  /** `uid:gid` the container runs as, or `null` for the image's own default user. */
  readonly user: string | null;
  /**
   * Named volume holding the application's installed dependencies, mounted read-only at
   * `/work/node_modules`. Dependencies are never copied from the host: a Windows checkout
   * of `node_modules` does not translate into a Linux container.
   */
  readonly dependenciesVolume: string | null;
  /** Command that installs dependencies into the volume on first use. Runs with egress. */
  readonly install: readonly string[] | null;
  /** True only when the developer explicitly accepted running generated code with their own privileges. */
  readonly trustHostExecution: boolean;
}

/** What the run record says about the isolation the verdict was produced under. */
export interface RepairExecutionRecord {
  readonly mode: RepairExecutionMode;
  /** Container runtime that ran everything, or `null` for host execution. */
  readonly runtime: string | null;
  readonly serverVersion: string | null;
  readonly image: string | null;
  readonly network: "none" | "egress" | null;
  readonly readOnlyRoot: boolean;
  readonly capDropAll: boolean;
  readonly noNewPrivileges: boolean;
  readonly memoryMb: number | null;
  readonly cpus: number | null;
  readonly pidsLimit: number | null;
  readonly user: string | null;
  readonly dependenciesVolume: string | null;
  /** One sentence, for the report and the console. */
  readonly summary: string;
}

/** Which kind of stored report a repair starts from. */
export type RepairTargetKind = "report" | "audit";

export interface RepairTarget {
  readonly kind: RepairTargetKind;
  /** Run id (`run-…`) or audit id (`audit-…`). */
  readonly id: string;
  /** `project:<projectId>/<routeId>` or `demo:<targetId>`. */
  readonly scopeKey: string;
  readonly label: string;
  /** Path captured by the report, when it names one. */
  readonly route: string | null;
}

/**
 * The source revision a repair attempt is pinned to. Every field is either measured by
 * Git or computed by UIProof from the files it actually copied.
 */
export interface SourceRevision {
  /** `git rev-parse HEAD`, or `null` when the directory is not in a Git repository. */
  readonly commitSha: string | null;
  /** `git status --porcelain` was non-empty. `null` when Git is unavailable. */
  readonly dirty: boolean | null;
  /** Up to 50 changed paths, as Git reported them. */
  readonly dirtyFiles: readonly string[];
  readonly capturedAt: string;
  /** Absolute directory the sandbox was copied from. */
  readonly sourceRoot: string;
  /** SHA-256 over the sorted `<path>\0<sha256(content)>` lines of every copied source file. */
  readonly digest: string;
  readonly digestFiles: number;
}

/** What Git said about the original tree after the run, to prove it was not modified. */
export interface RevisionAfter {
  readonly commitSha: string | null;
  readonly dirty: boolean | null;
  readonly digest: string;
  readonly unchanged: boolean;
}

export interface ScopeViolation {
  readonly path: string;
  readonly reason: string;
}

/** The result of checking one patch against the registered source and the scope rules. */
export interface ScopeCheck {
  readonly ok: boolean;
  /** Files the patch modifies, relative to the source root. */
  readonly files: readonly string[];
  readonly violations: readonly ScopeViolation[];
}

export interface PatchFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** One model-authored repair candidate. Always a proposal, never an applied change. */
export interface RepairProposal {
  /** The measured issue this patch claims to address. */
  readonly issueKey: string;
  readonly title: string;
  readonly summary: string;
  readonly explanation: string;
  readonly expectedImprovement: string;
  readonly uncertainty: string | null;
  readonly confidence: "high" | "medium" | "low";
  /** Unified diff, exactly as the model returned it. */
  readonly patch: string;
  readonly files: readonly PatchFileSummary[];
  readonly linesChanged: number;
  /** True when the patch applied cleanly to the pinned revision. */
  readonly applied: boolean;
}

export interface RepairAccessibilityMeasure {
  readonly violations: number;
  readonly serious: number;
  readonly critical: number;
  /** `<rule>@<selector>` identities, the same key the audit report uses. */
  readonly fingerprints: readonly string[];
  /** The stated impact of each fingerprint, for exact regression classification. */
  readonly impactByFingerprint: Readonly<Record<string, AxeImpact | "unknown">>;
  readonly byImpact: Readonly<Record<AxeImpact | "unknown", number>>;
}

export interface RepairLayoutMeasure {
  readonly documentOverflowPx: number;
  readonly defects: readonly { readonly selector: string; readonly overflowPx: number }[];
  readonly scrollableRegions: readonly string[];
}

/**
 * The visual comparison of the sandbox against the approved baseline, when one exists.
 * It never approves, replaces or edits a baseline — it only reads the active version.
 */
export interface RepairVisualMeasure {
  readonly baselineVersionId: string;
  readonly changedPixels: number;
  readonly changePercentage: number;
  readonly tolerance: number;
  readonly dimensionsChanged: boolean;
  readonly status: "match" | "regressed" | "no-baseline" | "unreadable";
  readonly detail: string;
}

/** Everything measured on one route at one viewport inside the sandbox. */
export interface RepairPageMeasurement {
  readonly routeId: string;
  readonly path: string;
  readonly viewportId: string;
  readonly viewportLabel: string;
  readonly accessibility: RepairAccessibilityMeasure;
  readonly layout: RepairLayoutMeasure;
  readonly visual: RepairVisualMeasure;
  /** Artifact name inside the repair directory: `before-support-mobile.png`. */
  readonly screenshot: string | null;
  /** Artifact name of the diff against the approved baseline, when one existed. */
  readonly diff: string | null;
  readonly measuredAt: string;
}

/** One measurement pass over the sandbox: before the patch, or after it. */
export interface RepairMeasurement {
  readonly phase: "before" | "after";
  readonly startedAt: string;
  readonly totalMs: number;
  readonly pages: readonly RepairPageMeasurement[];
  readonly warnings: readonly string[];
}

/** One command the developer configured, and what happened when it ran in the sandbox. */
export interface SandboxCommandResult {
  readonly name: "build" | "test";
  readonly command: readonly string[];
  readonly status: "passed" | "failed" | "skipped";
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Last 40 lines of combined output. Never contains the environment UIProof scrubbed. */
  readonly outputTail: string;
  readonly reason: string | null;
}

export interface TargetCheck {
  readonly issueKey: string;
  readonly title: string;
  readonly status: "fixed" | "improved" | "unchanged" | "not-measured";
  /** What was measured before and after, in one short phrase each. */
  readonly before: string;
  readonly after: string;
  readonly detail: string;
}

export interface RegressionCheck {
  readonly kind:
    | "accessibility"
    | "layout"
    | "visual"
    | "build"
    | "test"
    | "scope"
    | "measurement"
    | "source";
  /** Stable id: a fingerprint, a route/viewport pair, or the check name. */
  readonly id: string;
  readonly status: "clear" | "regression" | "unverified";
  readonly detail: string;
}

/** The deterministic judgement of one attempt. */
export interface RepairVerification {
  readonly verdict: RepairVerdict;
  /** Why the verdict is what it is, most important first. */
  readonly reasons: readonly string[];
  readonly targets: readonly TargetCheck[];
  readonly regressions: readonly RegressionCheck[];
  readonly build: readonly SandboxCommandResult[];
  readonly before: RepairMeasurement;
  readonly after: RepairMeasurement | null;
  readonly scope: ScopeCheck;
  readonly notes: readonly string[];
}

export interface RepairModelInfo {
  readonly provider: "openai-compatible";
  readonly model: string;
  readonly endpointHost: string;
  readonly latencyMs: number;
  readonly promptChars: number;
  readonly responseChars: number;
  readonly jsonModeFallback: boolean;
  /** The request was a revision of the previous failed attempt. */
  readonly revision: boolean;
}

export interface RepairArtifact {
  /** File name inside the repair directory; safe to serve by exact match. */
  readonly name: string;
  readonly kind: "screenshot" | "diff";
  readonly phase: "before" | "after";
  readonly routeId: string;
  readonly viewportId: string;
  readonly bytes: number;
  /** Application-relative URL: `/api/repairs/<id>/artifacts/<name>`. */
  readonly url: string;
}

export interface RepairAttempt {
  /** 1 or 2 — the engine never runs more than two. */
  readonly attempt: number;
  readonly createdAt: string;
  readonly durationMs: number;
  /** The model's candidate, or `null` when its answer was unusable. */
  readonly proposal: RepairProposal | null;
  readonly model: RepairModelInfo | null;
  /** Set when the proposal was refused before it ran (shape, scope, size). */
  readonly rejection: string | null;
  /** `attempt-1.patch`, when a patch was stored. */
  readonly patchArtifact: string | null;
  /** `attempt-1-reply.txt`, when the answer could not become a patch at all. */
  readonly replyArtifact: string | null;
  readonly artifacts: readonly RepairArtifact[];
  readonly verification: RepairVerification | null;
  /** The attempt's own verdict; the run's status is derived from all attempts. */
  readonly verdict: RepairVerdict;
}

/** Cost and size bounds the engine enforced, recorded so a run is reproducible. */
export interface RepairLimits {
  readonly maxAttempts: number;
  readonly maxPatchFiles: number;
  readonly maxPatchLines: number;
  readonly maxPromptChars: number;
  readonly commandTimeoutMs: number;
  readonly runTimeoutMs: number;
}

/**
 * One stored repair. The run keeps every attempt — including the rejected ones — because
 * a failed patch with its evidence is the most convincing thing this feature produces.
 */
export interface RepairRun {
  readonly id: string;
  readonly createdAt: string;
  readonly target: RepairTarget;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly sourceLabel: string;
  readonly sourceRoot: string;
  readonly revision: SourceRevision;
  readonly revisionAfter: RevisionAfter | null;
  /** Measurement of the unmodified checkout, taken before the first proposal. */
  readonly before: RepairMeasurement;
  /** Screenshots of the unmodified checkout. */
  readonly baselineArtifacts: readonly RepairArtifact[];
  /** The configured build and test commands run on the unmodified checkout. */
  readonly baselineCommands: readonly SandboxCommandResult[];
  readonly attempts: readonly RepairAttempt[];
  /** `verified` when any attempt verified; otherwise the best attempt's verdict. */
  readonly status: RepairVerdict;
  readonly verifiedAttempt: number | null;
  readonly limits: RepairLimits;
  readonly model: { readonly provider: "openai-compatible"; readonly model: string; readonly endpointHost: string } | null;
  /** Where the sandbox commands actually ran, and what restricted them. */
  readonly execution: RepairExecutionRecord;
  readonly warnings: readonly string[];
  /** Literal marker: everything under `attempts[].proposal` came from a model. */
  readonly aiGenerated: true;
  /** True when the original source digest and Git state were identical after the run. */
  readonly originalUnchanged: boolean;
}

/** One row of the repair history. */
export interface RepairSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly targetKind: RepairTargetKind;
  readonly targetId: string;
  readonly scopeKey: string;
  readonly sourceLabel: string;
  readonly status: RepairVerdict;
  readonly attempts: number;
  readonly verifiedAttempt: number | null;
  readonly commitSha: string | null;
  readonly originalUnchanged: boolean;
  /** `container` or `host`; a verdict from a host run is not an isolated one. */
  readonly executionMode: RepairExecutionMode;
  /** One-sentence reason the run ended the way it did. */
  readonly reason: string;
}

/**
 * The sandbox an isolated repair may start. Every field is developer-authored in
 * `uiproof.config.json`; nothing here comes from a model, a request or the environment.
 */
export interface RepairSandboxConfig {
  /** Executable and arguments, run without a shell. */
  readonly command: readonly string[];
  /** Loopback origin the sandbox server will answer on. */
  readonly url: string;
  /** Path polled until it answers 200 before any measurement begins. */
  readonly readyPath: string;
  /** Extra environment for the sandbox process. Secret-looking names are refused. */
  readonly env: Readonly<Record<string, string>>;
}

/** The optional `repair` block of a registered project. */
export interface RepairProjectConfig {
  readonly sandbox: RepairSandboxConfig;
  /** Where the generated application is allowed to run. Container execution by default. */
  readonly execution: RepairExecutionConfig;
  /** Command that must pass before and after a patch, or `null` when none is set. */
  readonly build: readonly string[] | null;
  /** Command that must pass before and after a patch, or `null` when none is set. */
  readonly test: readonly string[] | null;
  /** Glob allow-list for patched files, relative to the source directory. */
  readonly allow: readonly string[];
  /** Extra route ids measured in the sandbox to catch collateral damage. */
  readonly guardRoutes: readonly string[];
  /**
   * Source files shown to the model when an issue has no textual hint to search for —
   * a visual regression, for instance, carries a screenshot but no selector. Registered
   * explicitly because guessing a page file from a URL is not something UIProof can do
   * honestly across routers.
   */
  readonly entryFiles: readonly string[];
}

/** Whether a repair can run at all, and what is missing when it cannot. */
export interface RepairAvailability {
  readonly configured: boolean;
  readonly model: string | null;
  readonly endpointHost: string | null;
  /** Why it is not configured, in words a developer can act on. */
  readonly reason: string | null;
  readonly sourceRegistration: "config" | "missing";
  /** Whether the project registered a sandbox, build and test commands. */
  readonly sandboxConfigured: boolean;
  readonly buildConfigured: boolean;
  readonly testConfigured: boolean;
  readonly measuredRoutes: readonly string[];
  readonly missing: readonly string[];
  /** What the registration asks for, before any runtime probe. */
  readonly execution: RepairExecutionAvailability;
}

/** Whether the configured execution mode can actually run here, and why not when it cannot. */
export interface RepairExecutionAvailability {
  readonly mode: RepairExecutionMode | "unset";
  readonly image: string | null;
  readonly network: "none" | "egress" | null;
  readonly dependenciesVolume: string | null;
  /** `null` until the runtime has been probed; then whether a suitable runtime answered. */
  readonly runtimeAvailable: boolean | null;
  readonly runtime: string | null;
  readonly runtimeVersion: string | null;
  /** Why container execution is not available, when it is not. */
  readonly reason: string | null;
}

/* ── API envelopes ─────────────────────────────────────────────────────────── */

export interface RepairRequest {
  readonly reportId?: unknown;
  readonly auditId?: unknown;
  readonly maxAttempts?: unknown;
}

export interface StartRepairResponse {
  readonly repair: RepairRun;
}

export interface RepairsResponse {
  readonly repairs: readonly RepairSummary[];
  readonly availability: RepairAvailability;
}

export interface RepairResponse {
  readonly repair: RepairRun;
}
