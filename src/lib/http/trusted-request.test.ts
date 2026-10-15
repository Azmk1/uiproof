import { describe, expect, it } from "vitest";
import { isSameHost, isTrustedRequest } from "./trusted-request";

describe("isSameHost", () => {
  it("compares parsed origins against the Host header", () => {
    expect(isSameHost("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isSameHost("https://uiproof.local", "UIPROOF.LOCAL")).toBe(true);
    expect(isSameHost("http://localhost:3001", "localhost:3000")).toBe(false);
    expect(isSameHost("http://localhost:3000", "localhost:3000.evil.com")).toBe(false);
  });

  it("rejects junk", () => {
    expect(isSameHost("not-a-url", "localhost:3000")).toBe(false);
    expect(isSameHost("ftp://localhost:3000", "localhost:3000")).toBe(false);
    expect(isSameHost(null, "localhost:3000")).toBe(false);
    expect(isSameHost("http://localhost:3000", null)).toBe(false);
    expect(isSameHost("http://localhost:3000", "")).toBe(false);
  });
});

describe("isTrustedRequest", () => {
  it("allows same-origin browser requests", () => {
    expect(
      isTrustedRequest({ origin: "http://localhost:3000", host: "localhost:3000", fetchSite: "same-origin" }),
    ).toBe(true);
  });

  it("allows clients that send no Origin at all", () => {
    expect(isTrustedRequest({ origin: null, host: "localhost:3000", fetchSite: null })).toBe(true);
  });

  it("blocks cross-site requests even when the Origin looks local", () => {
    expect(
      isTrustedRequest({ origin: "http://localhost:3000", host: "localhost:3000", fetchSite: "cross-site" }),
    ).toBe(false);
  });

  it("blocks a foreign Origin and an opaque null origin", () => {
    expect(isTrustedRequest({ origin: "https://evil.example", host: "localhost:3000", fetchSite: null })).toBe(false);
    expect(isTrustedRequest({ origin: "null", host: "localhost:3000", fetchSite: null })).toBe(false);
  });
});
