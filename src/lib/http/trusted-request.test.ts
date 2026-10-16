import { afterEach, describe, expect, it } from "vitest";
import { isLocalAdminRequest, isLoopbackHost, isSameHost, isTrustedRequest } from "./trusted-request";

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

describe("isLoopbackHost (Phase 3 hardening)", () => {
  it("accepts the absolute form of the loopback name", () => {
    expect(isLoopbackHost("localhost.")).toBe(true);
    expect(isLoopbackHost(" 127.0.0.1 ")).toBe(true);
  });

  it("rejects the wildcard addresses a network-reachable bind answers on", () => {
    // A request carrying these connected to a wildcard bind, which every machine on the
    // network can reach. Treating them as local would hand out write access.
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("0.0.0.0:3000")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("[::]")).toBe(false);
    expect(isLoopbackHost("[::]:3000")).toBe(false);
  });

  it("rejects anything that is not exactly a loopback name", () => {
    expect(isLoopbackHost("192.168.1.50:3000")).toBe(false);
    expect(isLoopbackHost("uiproof.example.com")).toBe(false);
    expect(isLoopbackHost("mylocalhost.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("is a header check, not a network check — the bind is the real control", () => {
    // Documented honestly: a remote caller can write this header. What stops them is
    // that the server is only listening on 127.0.0.1 (asserted by loopback-binding.test.ts).
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLocalAdminRequest({ origin: null, host: "127.0.0.1:3000", fetchSite: null })).toBe(true);
    expect(isLocalAdminRequest({ origin: null, host: "0.0.0.0:3000", fetchSite: null })).toBe(false);
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

describe("isLoopbackHost", () => {
  it("recognises the loopback spellings a local browser can send", () => {
    for (const host of ["localhost:3000", "LOCALHOST:3000", "127.0.0.1:3000", "127.0.0.5", "[::1]:3000", "localhost"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects LAN, tunnel and look-alike hosts", () => {
    for (const host of [
      "192.168.1.20:3000",
      "169.254.83.107:3000",
      "uiproof.example.com",
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "[2001:db8::1]:3000",
      "",
      null,
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });
});

describe("isLocalAdminRequest", () => {
  afterEach(() => {
    delete process.env.UIPROOF_ALLOW_REMOTE_BASELINES;
  });

  it("requires both same-origin trust and a loopback host", () => {
    expect(isLocalAdminRequest({ origin: "http://localhost:3000", host: "localhost:3000", fetchSite: null })).toBe(
      true,
    );
    // Same origin, but reached over the LAN address the dev server also listens on.
    expect(
      isLocalAdminRequest({ origin: "http://169.254.83.107:3000", host: "169.254.83.107:3000", fetchSite: null }),
    ).toBe(false);
    expect(isLocalAdminRequest({ origin: "https://evil.example", host: "localhost:3000", fetchSite: null })).toBe(
      false,
    );
    expect(isLocalAdminRequest({ origin: null, host: "192.168.1.20:3000", fetchSite: null })).toBe(false);
  });

  it("only opts out of the loopback rule when explicitly configured", () => {
    process.env.UIPROOF_ALLOW_REMOTE_BASELINES = "1";
    expect(isLocalAdminRequest({ origin: null, host: "192.168.1.20:3000", fetchSite: null })).toBe(true);
    // The same-origin rule is never optional.
    expect(isLocalAdminRequest({ origin: "https://evil.example", host: "192.168.1.20:3000", fetchSite: null })).toBe(
      false,
    );
    expect(
      isLocalAdminRequest({ origin: null, host: "192.168.1.20:3000", fetchSite: "cross-site" }),
    ).toBe(false);
  });
});
