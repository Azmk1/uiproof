/**
 * Argument parsing for the CLI. Pure and dependency-free, so every rule below is unit
 * tested directly and `main.ts` only has to dispatch.
 *
 * Nothing here touches the filesystem, the network or the environment: a parsed request is
 * still untrusted. Values are validated against the registration file and the viewport
 * catalogue later, and every path is resolved and guarded where it is used.
 */

export const CLI_NAME = "uiproof";

export type CliCommand = "capture" | "check" | "audit" | "projects" | "baselines" | "help" | "version";
export type BaselinesSubcommand = "status" | "export" | "import";

/** Impact bands a quality policy can fail on, in ascending order. */
export type QualityFailOn = "minor" | "moderate" | "serious" | "critical" | "none";

export const QUALITY_FAIL_ON: readonly QualityFailOn[] = ["minor", "moderate", "serious", "critical", "none"];

/** Raised for anything the user could fix by reading `--help`. */
export class CliUsageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliUsageError";
  }
}

export interface ParsedArgs {
  readonly command: CliCommand;
  /** Only meaningful for `baselines`: `status` (default), `export` or `import`. */
  readonly subcommand: BaselinesSubcommand | null;
  readonly project: string | null;
  readonly route: string | null;
  readonly viewport: string | null;
  readonly config: string | null;
  readonly storage: string | null;
  readonly tolerance: number | null;
  /** Bundle directory to write (`baselines export`). */
  readonly out: string | null;
  /** Bundle directory to read (`baselines import`). */
  readonly from: string | null;
  readonly approve: boolean;
  readonly note: string | null;
  readonly activate: boolean;
  readonly all: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly help: boolean;
  /** Also measure accessibility and responsive layout (capture and check). */
  readonly quality: boolean;
  /** Lowest accessibility impact that fails the quality gate (audit). */
  readonly failOn: QualityFailOn | null;
  /** Count only findings absent from the approved reference (audit). */
  readonly newOnly: boolean;
  /** Exclude best-practice rules from the policy; WCAG-tagged rules only (audit). */
  readonly wcagOnly: boolean;
  /** Maximum document-level horizontal overflow, in pixels (audit). */
  readonly maxDocumentOverflow: number | null;
  /** Maximum per-element viewport escape, in pixels (audit). */
  readonly maxElementOverflow: number | null;
}

const BOOLEAN_FLAGS: Record<string, keyof ParsedArgs> = {
  "--approve": "approve",
  "--activate": "activate",
  "--all": "all",
  "--json": "json",
  "--quiet": "quiet",
  "--help": "help",
  "-h": "help",
  "--quality": "quality",
  "--new-only": "newOnly",
  "--wcag-only": "wcagOnly",
};

const VALUE_FLAGS: Record<string, keyof ParsedArgs> = {
  "--project": "project",
  "--route": "route",
  "--viewport": "viewport",
  "--config": "config",
  "--storage": "storage",
  "--tolerance": "tolerance",
  "--out": "out",
  "--from": "from",
  "--note": "note",
  "--fail-on": "failOn",
  "--max-document-overflow": "maxDocumentOverflow",
  "--max-element-overflow": "maxElementOverflow",
};

const COMMANDS = new Set<CliCommand>(["capture", "check", "audit", "projects", "baselines", "help", "version"]);
const SUBCOMMANDS = new Set<BaselinesSubcommand>(["status", "export", "import"]);

function parseTolerance(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new CliUsageError(`--tolerance must be a number between 0 and 100, got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function parsePixels(raw: string, token: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CliUsageError(`${token} must be a number of pixels, zero or more, got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function parseFailOn(raw: string): QualityFailOn {
  if (!(QUALITY_FAIL_ON as readonly string[]).includes(raw)) {
    throw new CliUsageError(`--fail-on must be one of: ${QUALITY_FAIL_ON.join(", ")}, got ${JSON.stringify(raw)}.`);
  }
  return raw as QualityFailOn;
}

/**
 * Parses one command line. `--help` and `--version` win over everything else, so
 * `uiproof check --help` prints help rather than complaining about missing options.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  // A mutable mirror of ParsedArgs: parsing fills it in, then it is handed out as the
  // readonly result.
  const values: { -readonly [K in keyof ParsedArgs]: ParsedArgs[K] } = {
    command: "help",
    subcommand: null,
    project: null,
    route: null,
    viewport: null,
    config: null,
    storage: null,
    tolerance: null,
    out: null,
    from: null,
    approve: false,
    note: null,
    activate: false,
    all: false,
    json: false,
    quiet: false,
    help: false,
    quality: false,
    failOn: null,
    newOnly: false,
    wcagOnly: false,
    maxDocumentOverflow: null,
    maxElementOverflow: null,
  };

  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--version" || token === "-v") {
      values.command = "version";
      continue;
    }

    const booleanKey = BOOLEAN_FLAGS[token];
    if (booleanKey) {
      (values as Record<string, unknown>)[booleanKey] = true;
      continue;
    }

    const valueKey = VALUE_FLAGS[token];
    if (valueKey) {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new CliUsageError(`${token} needs a value.`);
      }
      index += 1;
      if (valueKey === "tolerance") {
        values.tolerance = parseTolerance(raw);
      } else if (valueKey === "failOn") {
        values.failOn = parseFailOn(raw);
      } else if (valueKey === "maxDocumentOverflow" || valueKey === "maxElementOverflow") {
        values[valueKey] = parsePixels(raw, token);
      } else {
        if (raw.trim().length === 0) throw new CliUsageError(`${token} needs a non-empty value.`);
        (values as Record<string, unknown>)[valueKey] = raw;
      }
      continue;
    }

    if (token.startsWith("-")) {
      throw new CliUsageError(`Unknown option ${JSON.stringify(token)}.`);
    }
    positionals.push(token);
  }

  const [command, subcommand, ...rest] = positionals;
  if (command !== undefined) {
    if (!COMMANDS.has(command as CliCommand)) {
      throw new CliUsageError(`Unknown command ${JSON.stringify(command)}.`);
    }
    values.command = command as CliCommand;
  }
  if (subcommand !== undefined) {
    if (values.command !== "baselines") {
      throw new CliUsageError(`Unexpected argument ${JSON.stringify(subcommand)}.`);
    }
    if (!SUBCOMMANDS.has(subcommand as BaselinesSubcommand)) {
      throw new CliUsageError(
        `Unknown baselines subcommand ${JSON.stringify(subcommand)}. Use status, export or import.`,
      );
    }
    values.subcommand = subcommand as BaselinesSubcommand;
  }
  if (rest.length > 0) {
    throw new CliUsageError(`Unexpected argument ${JSON.stringify(rest[0])}.`);
  }

  return values;
}

export function helpText(version: string): string {
  return `${CLI_NAME} ${version} — visual regression checks from the terminal

Usage
  ${CLI_NAME} <command> [options]

Commands
  capture              Capture a route of a registered project and store the screenshot
  check                Capture it and compare it with its approved baseline
  audit                Measure accessibility and responsive layout, and judge them by policy
  projects             List the projects and routes in the registration file
  baselines [status]   Show approved baselines, their versions and their images
  baselines export     Write a portable baseline bundle
  baselines import     Read a portable baseline bundle into this machine's store
  help                 Show this help

Source
  --project <id>       Registered project id            (required by capture and check)
  --route <id>         Registered route id              (required by capture and check)
  --viewport <id>      desktop | tablet | mobile        (default: desktop)
  --config <file>      Registration file                (default: ./uiproof.config.json)

Run
  --tolerance <pct>    Share of the viewport that may change and still pass (default: 0.1)
  --quality            Also measure accessibility and responsive layout (capture and check)
  --storage <dir>      Where reports and baselines are written  (default: .uiproof/data)

Quality (audit; every threshold is a number you can disagree with)
  --fail-on <impact>   Lowest impact that fails: minor | moderate | serious | critical | none
                       (default: serious)
  --new-only           Fail only on findings absent from the approved baseline's snapshot
  --wcag-only          Count WCAG-tagged rules only; best-practice rules are reported but
                       never fail the check
  --max-document-overflow <px>   Horizontal document scroll allowed (default: 1)
  --max-element-overflow <px>    Viewport escape allowed per element (default: 1)
  audit measures every viewport preset (desktop, tablet, mobile) unless --viewport narrows it

Baselines
  --approve            Approve this capture as a new baseline version (capture only)
  --note <text>        Note stored on the approved version
  --out <dir>          Bundle directory to write (baselines export)
  --from <dir>         Bundle directory to read  (baselines import)
  --activate           Make the imported versions the active reference
  --all                Export every baseline in the store, not just the selected one

Output
  --json               Print one JSON object on stdout, machine-readable
  --quiet              Print only errors
  --help, -h           Show this help
  --version, -v        Show the version

Exit codes
  0  the comparison passed (or the capture was stored — a capture is never reported as a pass)
  1  a visual regression was detected, or the quality policy failed (audit)
  2  configuration, baseline, browser or infrastructure error

  audit never touches the approved baseline: a failing quality policy exits 1 and leaves
  every approved screenshot exactly as it was.

Examples
  ${CLI_NAME} projects --config ./uiproof.config.json
  ${CLI_NAME} capture --project my-app --route home --approve
  ${CLI_NAME} check --project my-app --route home --json
  ${CLI_NAME} audit --project my-app --route home --fail-on serious
  ${CLI_NAME} audit --project my-app --route home --viewport mobile --json
  ${CLI_NAME} baselines export --project my-app --route home --out ./uiproof-baselines
  ${CLI_NAME} baselines import --from ./uiproof-baselines --activate
`;
}
