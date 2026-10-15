import { describe, expect, it } from "vitest";
import { formatClockTime, formatDuration, formatRelativeTime } from "./format-time";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it("describes recent runs", () => {
    expect(formatRelativeTime("2026-10-14T11:59:40.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-10-14T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(formatRelativeTime("2026-10-14T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelativeTime("2026-10-13T12:00:00.000Z", NOW)).toBe("yesterday");
    expect(formatRelativeTime("2026-10-10T12:00:00.000Z", NOW)).toBe("4d ago");
  });

  it("does not crash on unparseable timestamps", () => {
    expect(formatRelativeTime("nonsense", NOW)).toBe("unknown time");
  });
});

describe("formatClockTime", () => {
  it("renders a stable UTC clock", () => {
    expect(formatClockTime("2026-10-14T12:00:00.000Z")).toBe("12:00:00 UTC");
    expect(formatClockTime("bad")).toBe("—");
  });
});

describe("formatDuration", () => {
  it("switches units at one second", () => {
    expect(formatDuration(842)).toBe("842 ms");
    expect(formatDuration(1_500)).toBe("1.50 s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
