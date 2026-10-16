import { isLocalAdminRequest, isTrustedRequest, readRequestFacts } from "./trusted-request";

/**
 * Guard for endpoints that change stored state.
 *
 * Two independent conditions, both read from the request itself:
 *  1. the request is same-origin (or carries no Origin at all, which a hostile page
 *     cannot arrange), and
 *  2. it arrived over a loopback interface, because the dev server also listens on the
 *     LAN and "same origin" would otherwise be satisfied by anyone who can reach it.
 *
 * Returns a failure description instead of a response so the rule stays testable and
 * each route keeps control of its own payload shape.
 */
export interface GuardFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly hint: string;
}

export function requireLocalAdmin(request: Request, action: string): GuardFailure | null {
  const facts = readRequestFacts(request.headers);

  if (!isTrustedRequest(facts)) {
    return {
      status: 403,
      code: "untrusted_request",
      message: `Cross-site requests cannot ${action}.`,
      hint: "Open UIProof directly on this machine and try again.",
    };
  }

  if (!isLocalAdminRequest(facts)) {
    return {
      status: 403,
      code: "local_only",
      message: `${action[0].toUpperCase()}${action.slice(1)} is restricted to the local machine.`,
      hint: "Approving baselines is a local operation. Set UIPROOF_ALLOW_REMOTE_BASELINES=1 only if you deliberately expose UIProof.",
    };
  }

  return null;
}
