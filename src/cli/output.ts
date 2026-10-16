/**
 * Where the CLI writes things.
 *
 * One rule matters: with `--json`, **stdout carries exactly one JSON document** and nothing
 * else, so a pipeline can pipe it straight into `jq`. The human-readable trail still happens,
 * on stderr, unless `--quiet` asks for silence. Errors always go to stderr, in both modes.
 */
export interface CliOutput {
  /** Progress and results for a human. Suppressed by `--quiet`; on stderr in JSON mode. */
  readonly note: (text: string) => void;
  /** The command's machine-readable result. Printed on stdout only in JSON mode. */
  readonly result: (value: unknown) => void;
  /** Warnings and failures. Never suppressed. */
  readonly warn: (text: string) => void;
}

export function createOutput(flags: { readonly json: boolean; readonly quiet: boolean }): CliOutput {
  return {
    note: (text) => {
      if (flags.quiet) return;
      const stream = flags.json ? process.stderr : process.stdout;
      stream.write(`${text}\n`);
    },
    result: (value) => {
      if (!flags.json) return;
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    warn: (text) => {
      process.stderr.write(`${text}\n`);
    },
  };
}
