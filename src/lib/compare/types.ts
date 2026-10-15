/**
 * Domain types shared by the comparison engine (server) and the dashboard (client).
 * This module is intentionally free of runtime dependencies and Node APIs.
 */

export type ComparisonStatus = "pass" | "regression";

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

export interface ComparisonReport {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ComparisonStatus;
  readonly target: {
    readonly id: string;
    readonly label: string;
    readonly baselinePath: string;
    readonly currentPath: string;
  };
  readonly viewport: ViewportPreset;
  readonly metrics: ComparisonMetrics;
  readonly artifacts: Readonly<Record<ArtifactName, ArtifactInfo>>;
  readonly engine: ComparisonEngineInfo;
}

export interface ReportSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ComparisonStatus;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly viewportLabel: string;
  readonly changePercentage: number;
}

export interface RunComparisonRequest {
  readonly targetId?: unknown;
  readonly viewportId?: unknown;
  readonly maxDiffPercent?: unknown;
}

export interface CatalogResponse {
  readonly targets: readonly ComparisonTarget[];
  readonly viewports: readonly ViewportPreset[];
  readonly defaultViewportId: string;
  readonly defaults: {
    readonly maxDiffPercent: number;
    readonly pixelThreshold: number;
    readonly maxHistory: number;
  };
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
  };
}
