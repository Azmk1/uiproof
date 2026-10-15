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
