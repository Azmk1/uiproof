import { NextResponse } from "next/server";
import { DEFAULT_MAX_DIFF_PERCENT, DEFAULT_PIXEL_THRESHOLD, MAX_HISTORY } from "@/lib/compare/metrics";
import { DEFAULT_MODE } from "@/lib/compare/run-options";
import { COMPARISON_TARGETS, DEFAULT_VIEWPORT_ID, VIEWPORT_PRESETS } from "@/lib/compare/targets";
import type { CatalogResponse } from "@/lib/compare/types";
import { loadProjectCatalog } from "@/lib/projects/config";

/**
 * Everything the dashboard is allowed to compare: the compiled demo fixtures, plus the
 * applications registered in the local configuration file. The client can never invent a
 * target, a project or a route: it picks from this list and the engine re-validates the
 * identity on the way back in.
 *
 * The catalogue is read per request (cached on the config file's size and mtime), so
 * editing a registration shows up in the console without restarting the server.
 */
export async function GET() {
  const projects = await loadProjectCatalog();
  const body: CatalogResponse = {
    targets: COMPARISON_TARGETS,
    projects: projects.projects,
    projectConfigPath: projects.configPath,
    projectConfigError: projects.error,
    viewports: VIEWPORT_PRESETS,
    defaultViewportId: DEFAULT_VIEWPORT_ID,
    defaults: {
      maxDiffPercent: DEFAULT_MAX_DIFF_PERCENT,
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
      maxHistory: MAX_HISTORY,
      defaultMode: DEFAULT_MODE,
    },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
