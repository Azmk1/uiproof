/**
 * A Next.js application configured for UIProof's repair sandbox.
 *
 * `next start` reads `PORT` and `HOSTNAME` from the environment, which is exactly what the
 * sandbox passes, so the only thing that needs saying here is that telemetry is off — a
 * container with no network interface should not be trying to phone home, and a build
 * inside a sandbox should not depend on anything outside it.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
