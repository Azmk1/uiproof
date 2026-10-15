/**
 * UIProof screenshots its own fixtures, so the capture origin is never taken
 * from user input: it is either the configured base URL or the origin the
 * dashboard itself was served from.
 */
export function resolveCaptureOrigin(request: Request): string {
  const override = process.env.UIPROOF_BASE_URL;
  if (override && override.trim().length > 0) {
    return new URL(override.trim()).origin;
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}
