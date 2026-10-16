import { startE2eServer } from "./e2e-server";

/**
 * Vitest global setup: one production server for the whole browser suite, started
 * against a throwaway data directory and stopped again when the run finishes.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const { runtime, stop } = await startE2eServer();
  // Workers are forked after this returns, so the environment is inherited; the runtime
  // file is the fallback for workers that start without it.
  process.env.UIPROOF_E2E_URL = runtime.url;
  process.env.UIPROOF_E2E_DATA_DIR = runtime.dataDir;
  process.stdout.write(`e2e: UIProof listening on ${runtime.url} (data: ${runtime.dataDir})\n`);
  return stop;
}
