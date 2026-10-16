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

/**
 * Names that mean "this machine". Deliberately *not* in the set:
 *  · `0.0.0.0` and `::` — the unspecified/wildcard addresses. A request that carries
 *    them connected to a wildcard bind, which is reachable from the whole network, so
 *    treating them as loopback would hand write access to anyone on the LAN.
 *  · anything that merely contains "localhost" as a substring.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when the *header* names a loopback address.
 *
 * This is a header check, not a network check: `Host` is written by the client, so a
 * remote caller can send `Host: 127.0.0.1` and pass. It exists as defence in depth on
 * top of the real control, which is that UIProof binds to a loopback interface (`pnpm
 * dev` / `pnpm start` / the browser suite all pass `-H 127.0.0.1`), so an off-machine
 * client has no connection to make. See `docs/PROGRESS.md` for the honest limits.
 */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  const withoutPort = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.split(":")[0];
  // `localhost.` is the same name written as an absolute FQDN.
  const normalized = withoutPort.endsWith(".") ? withoutPort.slice(0, -1) : withoutPort;
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
  // 127.0.0.0/8 is loopback in full, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Guard for state-changing local operations.
 *
 * Two conditions must hold: the request is trusted (same-origin rules above) and it
 * arrived over loopback. Because `Host` is client-supplied, the second condition only
 * raises the cost of a mistake — it is not an authentication mechanism. The control
 * that actually keeps other machines out is the loopback bind in the `dev`/`start`
 * scripts; `UIPROOF_ALLOW_REMOTE_BASELINES=1` exists only for someone who has
 * deliberately put UIProof behind their own access control.
 */
export function isLocalAdminRequest(facts: RequestFacts): boolean {
  if (!isTrustedRequest(facts)) return false;
  if (process.env.UIPROOF_ALLOW_REMOTE_BASELINES === "1") return true;
  return isLoopbackHost(facts.host);
}
