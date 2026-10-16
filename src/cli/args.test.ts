import { describe, expect, it } from "vitest";
import { CliUsageError, helpText, parseArgs } from "./args";

describe("parseArgs", () => {
  it("defaults to help with no arguments", () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBe("help");
    expect(parsed.json).toBe(false);
    expect(parsed.activate).toBe(false);
    expect(parsed.tolerance).toBeNull();
  });

  it("reads every command and the baselines subcommands", () => {
    expect(parseArgs(["capture"]).command).toBe("capture");
    expect(parseArgs(["check"]).command).toBe("check");
    expect(parseArgs(["projects"]).command).toBe("projects");
    expect(parseArgs(["help"]).command).toBe("help");
    expect(parseArgs(["version"]).command).toBe("version");
    expect(parseArgs(["baselines"]).subcommand).toBeNull();
    expect(parseArgs(["baselines", "status"]).subcommand).toBe("status");
    expect(parseArgs(["baselines", "export"]).subcommand).toBe("export");
    expect(parseArgs(["baselines", "import"]).subcommand).toBe("import");
  });

  it("reads source, run and baseline options", () => {
    const parsed = parseArgs([
      "check",
      "--project",
      "my-app",
      "--route",
      "home",
      "--viewport",
      "mobile",
      "--config",
      "./cfg.json",
      "--storage",
      "./store",
      "--tolerance",
      "0.25",
      "--out",
      "./bundle",
      "--from",
      "./other",
      "--note",
      "release 4",
      "--json",
      "--quiet",
      "--approve",
      "--activate",
      "--all",
    ]);
    expect(parsed).toMatchObject({
      command: "check",
      project: "my-app",
      route: "home",
      viewport: "mobile",
      config: "./cfg.json",
      storage: "./store",
      tolerance: 0.25,
      out: "./bundle",
      from: "./other",
      note: "release 4",
      json: true,
      quiet: true,
      approve: true,
      activate: true,
      all: true,
    });
  });

  it("treats --version and --help as their own commands", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-v"]).command).toBe("version");
    expect(parseArgs(["-h"]).help).toBe(true);
    // Help wins over a command, so `check --help` explains rather than complains.
    const parsed = parseArgs(["check", "--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBe("check");
  });

  it("refuses anything it does not understand", () => {
    const cases: Array<readonly string[]> = [
      ["compare"],
      ["baselines", "publish"],
      ["capture", "extra"],
      ["projects", "some-argument"],
      ["--nope"],
      ["--project"],
      ["--project", "--route", "home"],
      ["--note", "--json"],
      ["--tolerance", "hot"],
      ["--tolerance", "-1"],
      ["--tolerance", "101"],
      ["--tolerance", "abc"],
    ];
    for (const argv of cases) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(CliUsageError);
    }
  });

  it("accepts the tolerance boundaries", () => {
    expect(parseArgs(["check", "--tolerance", "0"]).tolerance).toBe(0);
    expect(parseArgs(["check", "--tolerance", "100"]).tolerance).toBe(100);
    expect(parseArgs(["check", "--tolerance", "0.05"]).tolerance).toBe(0.05);
  });
});

describe("helpText", () => {
  it("documents every command, option and exit code", () => {
    const text = helpText("9.9.9");
    expect(text).toContain("uiproof 9.9.9");
    for (const command of ["capture", "check", "projects", "baselines export", "baselines import"]) {
      expect(text).toContain(command);
    }
    for (const option of ["--project", "--route", "--viewport", "--config", "--storage", "--json", "--activate"]) {
      expect(text).toContain(option);
    }
    expect(text).toContain("Exit codes");
    expect(text).toMatch(/0\s+the comparison passed/);
    expect(text).toMatch(/1\s+a visual regression/);
    expect(text).toMatch(/2\s+configuration/);
  });
});
