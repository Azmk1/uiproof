/**
 * The CLI's exit codes. They are part of its interface: a pipeline gates on them, so they
 * are documented here, in `--help`, and in the README, and they do not change between
 * releases without saying so.
 */
export const EXIT_PASS = 0;
export const EXIT_REGRESSION = 1;
export const EXIT_ERROR = 2;

export type CliExitCode = typeof EXIT_PASS | typeof EXIT_REGRESSION | typeof EXIT_ERROR;

export const EXIT_CODE_MEANINGS: Record<CliExitCode, string> = {
  0: "the comparison passed, or the capture was stored (a capture is never a pass)",
  1: "a visual regression was detected",
  2: "configuration, baseline, browser or infrastructure error — the tool could not answer",
};
