import { NextResponse } from "next/server";
import { DEFAULT_MAX_DIFF_PERCENT, DEFAULT_PIXEL_THRESHOLD, MAX_HISTORY } from "@/lib/compare/metrics";
import { COMPARISON_TARGETS, DEFAULT_VIEWPORT_ID, VIEWPORT_PRESETS } from "@/lib/compare/targets";
import type { CatalogResponse } from "@/lib/compare/types";

/**
 * Static catalogue of everything the dashboard is allowed to compare. The
 * client can never invent a target or a viewport: it picks from this list and
 * the engine re-validates the id on the way back in.
 */
export async function GET() {
  const body: CatalogResponse = {
    targets: COMPARISON_TARGETS,
    viewports: VIEWPORT_PRESETS,
    defaultViewportId: DEFAULT_VIEWPORT_ID,
    defaults: {
      maxDiffPercent: DEFAULT_MAX_DIFF_PERCENT,
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
      maxHistory: MAX_HISTORY,
    },
  };
  return NextResponse.json(body);
}
