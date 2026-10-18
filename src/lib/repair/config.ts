import type { ProjectRoute, RegisteredProject } from "@/lib/compare/types";
import { describeAvailability } from "@/lib/diagnosis/client";
import { probeContainerRuntime, type ContainerProbe } from "./container";
import type { RepairAvailability, RepairExecutionAvailability, RepairProjectConfig } from "./types";

/**
 * Reads the repair half of a registration, and says plainly what is missing.
 *
 * The console and the CLI both need the same answer to "can a repair run here?", and the
 * answer must never be a guess: a project without a sandbox, a model or a source directory
 * is reported as such, with each missing piece named. A repair that cannot measure the
 * candidate is not offered as if it could.
 */

/** The repair block, or `null` when the project did not register one. */
export function repairConfigOf(project: RegisteredProject | null | undefined): RepairProjectConfig | null {
  return project?.repair ?? null;
}

/**
 * The routes measured inside the sandbox: the failing route first, then the project's
 * declared guard routes. Deliberately bounded — a repair that re-measures an entire
 * application would cost more than the defect it fixes.
 */
export const MAX_MEASURED_ROUTES = 5;

export function routesToMeasure(
  project: RegisteredProject,
  targetRouteId: string | null,
  config: RepairProjectConfig,
): ProjectRoute[] {
  const wanted: string[] = [];
  const target = targetRouteId ? project.routes.find((route) => route.id === targetRouteId) : undefined;
  if (target) wanted.push(target.id);
  for (const routeId of config.guardRoutes) {
    if (!wanted.includes(routeId)) wanted.push(routeId);
  }
  // A report whose route is no longer registered still gets measured: every declared
  // guard route is a better guard set than none at all.
  if (wanted.length === 0) {
    for (const route of project.routes) {
      if (wanted.length >= MAX_MEASURED_ROUTES) break;
      wanted.push(route.id);
    }
  }
  return wanted
    .slice(0, MAX_MEASURED_ROUTES)
    .map((routeId) => project.routes.find((route) => route.id === routeId))
    .filter((route): route is ProjectRoute => route !== undefined);
}

export interface RepairAvailabilityInput {
  readonly project: RegisteredProject | null;
  readonly sourceRegistered: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Why a repair cannot run, or `null` when everything it needs is present. Kept in one
 * place so the CLI, the API and the panel cannot disagree about readiness.
 */
export function describeRepairAvailability(input: RepairAvailabilityInput): RepairAvailability {
  const model = describeAvailability(input.env);
  const config = repairConfigOf(input.project);
  const missing: string[] = [];

  if (!model.configured) missing.push("a model (UIPROOF_AI_API_KEY)");
  if (!input.sourceRegistered) missing.push('a "sourceDir" in uiproof.config.json');
  if (input.project && !config) missing.push('a "repair" block in uiproof.config.json');
  if (config && config.build === null) missing.push("a repair build command");
  if (config && config.test === null) missing.push("a repair test command");

  const measuredRoutes = input.project && config
    ? routesToMeasure(input.project, null, config).map((route) => route.id)
    : [];

  return {
    configured: missing.length === 0,
    model: model.model,
    endpointHost: model.endpointHost,
    reason: missing.length === 0 ? null : `A repair needs ${missing.join(", ")}.`,
    sourceRegistration: input.sourceRegistered ? "config" : "missing",
    sandboxConfigured: config !== null,
    buildConfigured: config?.build !== null && config?.build !== undefined,
    testConfigured: config?.test !== null && config?.test !== undefined,
    measuredRoutes,
    missing,
    execution: executionAvailabilityOf(config),
  };
}

/** What the registration asks for, before anything is probed. */
export function executionAvailabilityOf(config: RepairProjectConfig | null): RepairExecutionAvailability {
  if (!config) {
    return {
      mode: "unset",
      image: null,
      network: null,
      dependenciesVolume: null,
      runtimeAvailable: null,
      runtime: null,
      runtimeVersion: null,
      reason: 'No "repair" block is registered, so no execution mode is configured.',
    };
  }
  const execution = config.execution;
  return {
    mode: execution.mode,
    image: execution.image,
    network: execution.network,
    dependenciesVolume: execution.dependenciesVolume,
    runtimeAvailable: null,
    runtime: null,
    runtimeVersion: null,
    reason:
      execution.mode === "host"
        ? "Host execution is registered: generated code runs with the developer's own privileges."
        : null,
  };
}

/**
 * Answers "can the configured execution mode actually run here?" by probing the runtime.
 * A machine without Docker is told so — with the exact words to change in the registration
 * if the developer decides to trust host execution instead.
 */
export async function probeExecutionAvailability(
  config: RepairProjectConfig | null,
  options: { readonly probe?: ContainerProbe } = {},
): Promise<RepairExecutionAvailability> {
  const base = executionAvailabilityOf(config);
  if (!config || config.execution.mode === "host") return base;

  const probe = options.probe ?? (await probeContainerRuntime({ runtime: config.execution.runtime }));
  if (!probe.available) {
    return {
      ...base,
      runtimeAvailable: false,
      runtime: null,
      runtimeVersion: null,
      reason:
        `${probe.reason} Container execution needs a working container runtime; without one the only alternative is ` +
        '"mode": "host" with "trustHostExecution": true, which runs generated code with your own privileges.',
    };
  }
  return {
    ...base,
    runtimeAvailable: true,
    runtime: probe.runtime.runtime,
    runtimeVersion: probe.runtime.serverVersion,
    reason: null,
  };
}

/** The project origin replaced by the sandbox origin; everything else stays identical. */
export function sandboxProject(project: RegisteredProject, sandboxUrl: string): RegisteredProject {
  return {
    ...project,
    origin: sandboxUrl,
    routes: project.routes.map((route) => ({ ...route, url: `${sandboxUrl}${route.path}` })),
  };
}
