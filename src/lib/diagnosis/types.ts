import type { AxeImpact } from "@/lib/quality/types";

/**
 * Domain types for the optional AI diagnosis.
 *
 * The one rule this whole feature is built around: **a diagnosis is never a verdict.**
 * Every field here is either
 *
 *  · a **measured fact** copied from a stored report — a number, a rule, a selector, a
 *    screenshot URL that UIProof itself produced, or
 *  · a **model statement** clearly marked as such, with its own uncertainty, or
 *  · a **verified source reference**: a path and line UIProof actually read before
 *    asking the model anything, re-checked after the answer came back.
 *
 * Nothing in this module can change a comparison's status or a quality verdict, and a
 * diagnosis carries no pass/fail of its own. `aiGenerated: true` is on the record so a
 * stored diagnosis can never be mistaken for a measurement.
 */

/** Which measurement produced the issue being diagnosed. */
export type DiagnosisIssueKind = "visual" | "accessibility" | "responsive";

/** One measured fact, already true before any model was called. */
export interface MeasuredFact {
  readonly label: string;
  readonly value: string;
}

/** A pointer at the UIProof artifact a fact came from. */
export interface DiagnosticEvidence {
  readonly kind: "screenshot" | "report" | "finding" | "reference" | "diff";
  /** Application-relative URL, when the evidence is served over HTTP. */
  readonly url: string | null;
  /** What this proves, in words. */
  readonly note: string;
}

/**
 * One thing worth explaining, assembled from a stored report. `measured` and `evidence`
 * are UIProof's own output — the model is never the source of a number here.
 */
export interface DiagnosticIssue {
  /** Stable within one diagnosis, e.g. `a11y:mobile:button-name@#flood-icon`. */
  readonly key: string;
  readonly kind: DiagnosisIssueKind;
  readonly title: string;
  readonly measured: readonly MeasuredFact[];
  readonly evidence: readonly DiagnosticEvidence[];
  /** The rule's impact, when the issue came from an accessibility finding. */
  readonly impact?: AxeImpact | null;
  /**
   * Machine search hints, copied verbatim from the measurement: the CSS selector and the
   * element's markup. They are what the source investigation greps for — never invented,
   * and never a claim about where the code is.
   */
  readonly hints?: {
    readonly selector?: string;
    readonly html?: string;
  };
}

/** A file UIProof read and showed to the model, with the lines it showed. */
export interface SourceCandidate {
  /** Path relative to the registered source root, with `/` separators. */
  readonly path: string;
  /** Why the file was chosen: which route, selector token or literal text matched. */
  readonly via: readonly string[];
  /** 1-based lines in the file that matched something we searched for. */
  readonly matchedLines: readonly number[];
  /** First and last line of the excerpt that was sent, 1-based and inclusive. */
  readonly excerptStartLine: number;
  readonly excerptEndLine: number;
  /** The excerpt exactly as it was sent: numbered lines, LF separated. */
  readonly excerpt: string;
  /** True when the file is longer than the excerpt. */
  readonly excerptTruncated: boolean;
}

/** A citation UIProof verified against the file it actually read. */
export interface VerifiedSource {
  readonly path: string;
  readonly line: number | null;
  readonly why: string;
  /** The text of the cited line, when a line was cited. */
  readonly lineText: string | null;
}

/** A citation that could not be verified. Kept and reported, never quietly dropped. */
export interface UnverifiedSource {
  readonly path: string;
  readonly line: number | null;
  readonly why: string;
  readonly reason: string;
}

/** Everything the model said about one issue. */
export interface ModelDiagnosis {
  readonly summary: string;
  /** The model's hypothesis, not a measurement. */
  readonly likelyCause: string;
  readonly repairApproach: string;
  /** Measured facts the model says support its reading, quoted back. */
  readonly citedFacts: readonly string[];
  readonly confidence: "high" | "medium" | "low";
  readonly uncertainty: string | null;
  readonly sources: readonly VerifiedSource[];
  readonly unverifiedSources: readonly UnverifiedSource[];
}

/** One issue as diagnosed: facts always present, the model's answer optional. */
export interface DiagnosedIssue {
  readonly key: string;
  readonly kind: DiagnosisIssueKind;
  readonly title: string;
  readonly measured: readonly MeasuredFact[];
  readonly evidence: readonly DiagnosticEvidence[];
  /** `null` when the model did not return this issue — an honest gap, not an error. */
  readonly diagnosis: ModelDiagnosis | null;
}

/** Which provider answered, so a stored diagnosis is reproducible. */
export interface DiagnosisModelInfo {
  readonly provider: "openai-compatible";
  readonly model: string;
  /** Host of the configured endpoint. The key is never recorded. */
  readonly endpointHost: string;
  readonly latencyMs: number;
  readonly promptChars: number;
  readonly responseChars: number;
  /** True when the request had to be repeated without JSON mode. */
  readonly jsonModeFallback: boolean;
}

/**
 * The exact source bytes a diagnosis was based on, per file, so a later read can say
 * whether the citations still point at the same code. Optional: diagnoses written before
 * Phase 8 carry no snapshot, and that is reported as "cannot tell", never as "current".
 */
export interface DiagnosisSourceSnapshot {
  /** Path relative to the registered root → SHA-256 of the file when it was read. */
  readonly files: Readonly<Record<string, string>>;
}

/** One persisted diagnosis. */
export interface Diagnosis {
  readonly id: string;
  readonly createdAt: string;
  readonly reportId: string | null;
  readonly auditId: string | null;
  /** `project:<projectId>/<routeId>` — the same key baselines and reports use. */
  readonly scopeKey: string;
  readonly sourceLabel: string;
  /** Absolute directory the investigation was restricted to. */
  readonly sourceRoot: string;
  /** How many files the workspace offered, before candidates were chosen. */
  readonly filesScanned: number;
  readonly filesRead: readonly string[];
  readonly model: DiagnosisModelInfo;
  readonly issues: readonly DiagnosedIssue[];
  readonly warnings: readonly string[];
  /** Phase 8: the bytes each cited file had when the diagnosis was produced. */
  readonly sourceSnapshot?: DiagnosisSourceSnapshot | null;
  /** Literal marker: every word below `issues[].diagnosis` came from a model. */
  readonly aiGenerated: true;
}

/** One row of the diagnosis history. */
export interface DiagnosisSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly reportId: string | null;
  readonly auditId: string | null;
  readonly scopeKey: string;
  readonly sourceLabel: string;
  readonly model: string;
  readonly issues: number;
  readonly diagnosed: number;
  readonly verifiedSources: number;
  readonly unverifiedSources: number;
}

/** Whether a model is configured at all — the console asks before offering the button. */
export interface DiagnosisAvailability {
  readonly configured: boolean;
  readonly model: string | null;
  readonly endpointHost: string | null;
  /** Why it is not configured, in words a developer can act on. */
  readonly reason: string | null;
  /** Where a source directory comes from, so the console can explain the requirement. */
  readonly sourceRegistration: "config" | "cli" | "missing";
}

/* ── API envelopes ─────────────────────────────────────────────────────────── */

export interface DiagnoseRequest {
  readonly reportId?: unknown;
  readonly auditId?: unknown;
  readonly maxIssues?: unknown;
}

export interface DiagnoseResponse {
  readonly diagnosis: Diagnosis;
}

export interface DiagnosesResponse {
  readonly diagnoses: readonly DiagnosisSummary[];
  readonly availability: DiagnosisAvailability;
}

export interface StaleSources {
  readonly checked: number;
  readonly stale: readonly string[];
  readonly missing: readonly string[];
  readonly reason: string | null;
}

export interface DiagnosisResponse {
  readonly diagnosis: Diagnosis;
  /**
   * Whether the source files this diagnosis read still have the bytes it saw. `null` when
   * the diagnosis predates snapshots or the check could not run; always a report, never a
   * claim that a reference is still correct.
   */
  readonly staleSources?: StaleSources | null;
}
