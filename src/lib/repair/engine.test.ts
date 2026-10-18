import { describe, expect, it } from "vitest";
import { applyRevisionOutcome } from "./engine";
import type { RepairAttempt, RepairVerification } from "./types";

/**
 * The engine's last rule, tested without a browser, a model or a container: a verdict that
 * was measured against one revision does not survive the tree moving.
 */

function verification(verdict: RepairVerification["verdict"]): RepairVerification {
  return {
    verdict,
    reasons: ["Every target defect is gone."],
    targets: [],
    regressions: [],
    build: [],
    before: { phase: "before", startedAt: "2026-01-01T00:00:00.000Z", totalMs: 1, pages: [], warnings: [] },
    after: { phase: "after", startedAt: "2026-01-01T00:00:00.000Z", totalMs: 1, pages: [], warnings: [] },
    scope: { ok: true, files: [], violations: [] },
    notes: [],
  };
}

function attempt(overrides: Partial<RepairAttempt> = {}): RepairAttempt {
  return {
    attempt: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    proposal: null,
    model: null,
    rejection: null,
    patchArtifact: null,
    replyArtifact: null,
    artifacts: [],
    verification: verification("verified"),
    verdict: "verified",
    ...overrides,
  };
}

const SAME = {
  digestBefore: "a".repeat(64),
  digestAfter: "a".repeat(64),
  commitBefore: "1111111",
  commitAfter: "1111111",
  dirtyBefore: false,
  dirtyAfter: false,
};

describe("applyRevisionOutcome", () => {
  it("keeps a verified verdict when the pinned revision is intact", () => {
    const result = applyRevisionOutcome({ attempts: [attempt()], ...SAME });
    expect(result.drift).toBeNull();
    expect(result.attempts[0].verdict).toBe("verified");
    expect(result.attempts[0].verification?.verdict).toBe("verified");
  });

  it("withdraws a verified verdict when a file changed, and says which hash moved", () => {
    const result = applyRevisionOutcome({
      attempts: [attempt()],
      ...SAME,
      digestAfter: "b".repeat(64),
    });
    expect(result.drift).toContain("its files changed");
    expect(result.attempts[0].verdict).toBe("unverified");
    expect(result.attempts[0].verification?.verdict).toBe("unverified");
    expect(result.attempts[0].verification?.reasons[0]).toContain("The source directory changed while the repair ran");
    expect(result.attempts[0].verification?.regressions.some((check) => check.kind === "source")).toBe(true);
  });

  it("withdraws the verdict when HEAD moved or the tree became dirty", () => {
    const moved = applyRevisionOutcome({ attempts: [attempt()], ...SAME, commitAfter: "2222222" });
    expect(moved.attempts[0].verdict).toBe("unverified");
    expect(moved.drift).toContain("HEAD moved");

    const dirtied = applyRevisionOutcome({ attempts: [attempt()], ...SAME, dirtyAfter: true });
    expect(dirtied.attempts[0].verdict).toBe("unverified");
    expect(dirtied.drift).toContain("uncommitted state changed");
  });

  it("downgrades every attempt of a run, not only the verified one", () => {
    const result = applyRevisionOutcome({
      attempts: [
        attempt({ attempt: 1, verdict: "rejected", verification: verification("rejected") }),
        attempt({ attempt: 2 }),
        attempt({ attempt: 2, verification: null, verdict: "unverified", rejection: "the answer was unusable" }),
      ],
      ...SAME,
      digestAfter: "c".repeat(64),
    });
    expect(result.attempts.map((entry) => entry.verdict)).toEqual(["unverified", "unverified", "unverified"]);
    expect(result.attempts[2].rejection).toBe("the answer was unusable");
  });
});
