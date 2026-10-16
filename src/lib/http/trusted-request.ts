/**
 * Request trust checks.
 *
 * UIProof drives a real browser, so the mutation endpoint refuses cross-site
 * calls. The rules are pure functions so they can be unit tested without
 * spinning up a server.
 */

export interface RequestFacts {
  readonly origin: string | null;
  readonly host: string | null;
  readonly fetchSite: string | null;
}

export function readRequestFacts(headers: Headers): RequestFacts {
  return {
    origin: headers.get("origin"),
    host: headers.get("host"),
    fetchSite: headers.get("sec-fetch-site"),
  };
}

export function isSameHost(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost.length === 0) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.host.toLowerCase() === normalizedHost;
  } catch {
    return false;
  }
}

/**
 * - A cross-site browser request is always rejected.
 * - A browser request must carry an Origin that matches the Host header. An
 *   opaque (`null`) origin — sandboxed iframes, data: URLs — never qualifies.
 * - Requests without an Origin at all (curl, server-to-server) stay allowed;
 *   a hostile page cannot make one carry no Origin.
 */
export function isTrustedRequest(facts: RequestFacts): boolean {
  if (facts.fetchSite === "cross-site") return false;
  if (facts.origin === null) return true;
  return isSameHost(facts.origin, facts.host);
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * True when a request arrived on a loopback address.
 *
 * UIProof's state-changing baseline endpoints are deliberately local-only: the dev
 * server also listens on the LAN interface, so "same origin" alone would let anyone
 * on the network approve baselines for a project they can reach. The host is read
 * from the request, never from a body or a query parameter.
 */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  const withoutPort = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.split(":")[0];
  if (LOOPBACK_HOSTNAMES.has(withoutPort)) return true;
  // 127.0.0.0/8 is loopback in full, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutPort);
}

/**
 * Guard for state-changing local operations. Both conditions must hold: the request is
 * trusted (same-origin rules above) and it reached UIProof over loopback. An explicit
 * `UIPROOF_ALLOW_REMOTE_BASELINES=1` opts a deliberate remote deployment out — it is off
 * by default, so a plain `next start` on a shared host cannot be administered remotely.
 */
export function isLocalAdminRequest(facts: RequestFacts): boolean {
  if (!isTrustedRequest(facts)) return false;
  if (process.env.UIPROOF_ALLOW_REMOTE_BASELINES === "1") return true;
  return isLoopbackHost(facts.host);
}
