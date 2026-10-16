/**
 * Domain types shared by the comparison engine (server) and the dashboard (client).
 * This module is intentionally free of runtime dependencies and Node APIs.
 */

/**
 * `captured` is a run that produced a screenshot but had nothing to compare it against
 * yet — the state every project route starts in. It is not a pass.
 */
export type ComparisonStatus = "pass" | "regression" | "captured";

/**
 * How the reference side of a run is obtained.
 * - `fixture`  — the target's paired baseline route is captured alongside the current route.
 * - `baseline` — a fresh capture of the current route is diffed against an approved baseline image.
 * - `capture`  — one screenshot, no comparison: how a route gets its first baseline.
 */
export type ComparisonMode = "fixture" | "baseline" | "capture";

/** Built-in demo fixtures, or a locally registered application. */
export type RunSourceKind = "demo" | "project";

/** One allow-listed route of a registered application. */
export interface ProjectRoute {
  readonly id: string;
  readonly name: string;
  /** Path only, always starting with `/`. */
  readonly path: string;
  /** Absolute URL shown in the console: project origin + path. */
  readonly url: string;
}

/**
 * An application registered in the local configuration file. UIProof only ever
 * captures configured routes of configured loopback origins.
 */
export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  /** `http://host:port` — always a loopback origin. */
  readonly origin: string;
  readonly routes: readonly ProjectRoute[];
  readonly modes: readonly ComparisonMode[];
  readonly defaultMode: ComparisonMode;
  /** Extra origins the browser may load from while capturing. Empty by default. */
  readonly allowedOrigins: readonly string[];
}

/** Result of reading the local project configuration file. */
export interface ProjectCatalog {
  /** Absolute path of the configuration file, or `null` when none was found. */
  readonly configPath: string | null;
  readonly projects: readonly RegisteredProject[];
  /** Set when a configuration file exists but could not be used, verbatim for the UI. */
  readonly error: string | null;
}

/**
 * The identity of one capturable thing: a demo target, or a route of a registered
 * project. `scopeKey` is the single string used to key baselines, run filtering and
 * the console's selection state.
 */
export interface RunSource {
  readonly kind: RunSourceKind;
  /** `demo:<targetId>` or `project:<projectId>/<routeId>`. */
  readonly scopeKey: string;
  readonly label: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly routeId: string | null;
  readonly routeName: string | null;
  /** Origin the page was captured from. */
  readonly origin: string;
  /** Path that was captured. */
  readonly path: string;
  /** Requests the capture refused because they left the approved origins. */
  readonly blockedRequests: number;
}

/** Which stored baseline a run compares against, and every run is scoped this way. */
export type BaselineScope =
  | { readonly kind: "demo"; readonly targetId: string }
  | { readonly kind: "project"; readonly projectId: string; readonly routeId: string };

export type ArtifactName = "baseline" | "current" | "diff";

export interface DemoRoute {
  /** Internal, application-relative route. Never an absolute URL. */
  readonly path: string;
  readonly label: string;
}

export interface ViewportPreset {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface FixtureVariantOption {
  readonly id: string;
  readonly label: string;
  /** The allow-listed route a run captures while this variant is selected. */
  readonly route: string;
  readonly summary: string;
}

/** A demo fixture pair plus the modes it can be run in. */
export interface ComparisonTarget {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly baseline: DemoRoute;
  readonly current: DemoRoute;
  /** The deliberate differences this fixture pair is designed to exercise. */
  readonly expectedChanges: readonly string[];
  /** Plain-language expectation shown next to the target in the console. */
  readonly expectedOutcome: string;
  /** Comparison modes this target supports, in the order the console should offer them. */
  readonly modes: readonly ComparisonMode[];
  readonly defaultMode: ComparisonMode;
  /**
   * Switchable states of the page under test. Selecting a variant only changes which
   * allow-listed route is captured — it exists so a deliberate page change (and the
   * return to the original) can be demonstrated and tested without editing source.
   */
  readonly variants?: readonly FixtureVariantOption[];
  /** Must name one of `variants` when variants are declared. */
  readonly defaultVariantId?: string;
}

export interface ArtifactInfo {
  /** Application-relative URL the dashboard can request the PNG from. */
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ComparisonMetrics {
  readonly changedPixels: number;
  readonly comparedPixels: number;
  readonly changePercentage: number;
  /** Perceptual colour distance passed to pixelmatch (0–1). */
  readonly pixelThreshold: number;
  /** Human/target tolerance, in percent of the captured viewport. */
  readonly maxDiffPercent: number;
  readonly dimensionsChanged: boolean;
}

export interface ComparisonEngineInfo {
  readonly provider: "playwright";
  readonly comparator: "pixelmatch";
  readonly browser: string;
  readonly captureMs: number;
  readonly compareMs: number;
  readonly totalMs: number;
}

export interface BaselineReference {
  readonly versionId: string;
  readonly approvedAt: string;
  readonly sourceReportId: string;
  /** Route the approved baseline was captured from. */
  readonly capturedRoute: string;
  readonly origin: string;
  readonly width: number;
  readonly height: number;
  /** Application-relative URL of the approved baseline PNG. */
  readonly imageUrl: string;
}

/** One approved baseline image. Versions are append-only; nothing is overwritten. */
export interface BaselineVersion {
  readonly id: string;
  /** Absent on Phase 2 manifests, which were all demo targets. */
  readonly scope?: RunSourceKind;
  readonly targetId: string;
  readonly projectId?: string | null;
  readonly routeId?: string | null;
  readonly routeName?: string | null;
  readonly viewportId: string;
  readonly viewportLabel: string;
  readonly approvedAt: string;
  readonly sourceReportId: string;
  /** Route this baseline was captured from. */
  readonly capturedRoute: string;
  readonly origin?: string | null;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly note: string | null;
  readonly imageUrl: string;
}

export interface BaselineManifest {
  /** Absent on Phase 2 manifests, which were all demo targets. */
  readonly scope?: RunSourceKind;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly projectId?: string | null;
  readonly routeId?: string | null;
  readonly viewportId: string;
  readonly viewportLabel: string;
  /** The version a new run compares against. `null` is only reachable by editing disk state. */
  readonly activeVersionId: string | null;
  /** Increments on every metadata change. */
  readonly revision: number;
  readonly updatedAt: string;
  readonly versions: readonly BaselineVersion[];
}

/**
 * Artifacts a run produced. A comparison has all three; a capture-only run has just
 * the screenshot, because there was nothing to compare it against.
 */
export interface ReportArtifacts {
  readonly baseline?: ArtifactInfo;
  readonly current: ArtifactInfo;
  readonly diff?: ArtifactInfo;
}

export interface ComparisonReport {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ComparisonStatus;
  /** Absent on reports written before Phase 2; the console treats those as `fixture`. */
  readonly mode?: ComparisonMode;
  readonly variantId?: string | null;
  /** The approved baseline this run compared against, when it ran in baseline mode. */
  readonly baseline?: BaselineReference | null;
  /** Absent on reports written before Phase 3; those were all demo targets. */
  readonly source?: RunSource;
  readonly target: {
    readonly id: string;
    readonly label: string;
    /** Reference side: the paired fixture route, or the route the approved baseline came from. */
    readonly baselinePath: string;
    readonly currentPath: string;
  };
  readonly viewport: ViewportPreset;
  readonly metrics: ComparisonMetrics;
  readonly artifacts: ReportArtifacts;
  readonly engine: ComparisonEngineInfo;
}

export interface ReportSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ComparisonStatus;
  readonly targetId: string;
  readonly targetLabel: string;
  /** `demo:<targetId>` or `project:<projectId>/<routeId>`. */
  readonly scopeKey: string;
  readonly kind: RunSourceKind;
  readonly viewportId: string;
  readonly viewportLabel: string;
  readonly mode: ComparisonMode;
  readonly variantId: string | null;
  readonly changePercentage: number;
}

/** How a caller picks what to capture. `targetId` is the Phase 1/2 spelling. */
export interface RunSourceRequest {
  readonly kind?: unknown;
  readonly targetId?: unknown;
  readonly projectId?: unknown;
  readonly routeId?: unknown;
}

export interface RunComparisonRequest {
  readonly targetId?: unknown;
  /** Phase 3: capture a route of a registered project. */
  readonly source?: RunSourceRequest;
  readonly viewportId?: unknown;
  readonly maxDiffPercent?: unknown;
  readonly mode?: unknown;
  readonly variantId?: unknown;
}

export interface ApproveBaselineRequest {
  readonly targetId?: unknown;
  /** Phase 3: approve for a registered project route. */
  readonly source?: RunSourceRequest;
  readonly viewportId?: unknown;
  /** Run whose `current.png` becomes the approved baseline. */
  readonly sourceReportId?: unknown;
  readonly note?: unknown;
}

export interface ActivateBaselineRequest {
  readonly targetId?: unknown;
  readonly viewportId?: unknown;
  readonly versionId?: unknown;
}

export interface CatalogResponse {
  readonly targets: readonly ComparisonTarget[];
  readonly projects: readonly RegisteredProject[];
  readonly projectConfigPath: string | null;
  /** Set when a configuration file exists but could not be used. */
  readonly projectConfigError: string | null;
  readonly viewports: readonly ViewportPreset[];
  readonly defaultViewportId: string;
  readonly defaults: {
    readonly maxDiffPercent: number;
    readonly pixelThreshold: number;
    readonly maxHistory: number;
    readonly defaultMode: ComparisonMode;
  };
}

export interface BaselineResponse {
  /** `null` when nothing has been approved for this target/viewport pair yet. */
  readonly baseline: BaselineManifest | null;
}

export interface ApproveBaselineResponse {
  readonly baseline: BaselineManifest;
  readonly version: BaselineVersion;
}

export interface ActivateBaselineResponse {
  readonly baseline: BaselineManifest;
}

export interface ReportsResponse {
  readonly reports: readonly ReportSummary[];
}

export interface ReportResponse {
  readonly report: ComparisonReport;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present when the failure has an obvious next step for the console. */
    readonly hint?: string;
  };
}
