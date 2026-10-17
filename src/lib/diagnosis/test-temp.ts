import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Builds a real directory tree on disk from a path → contents map.
 *
 * The workspace and candidate tests need actual files: the safety rules are about `stat`,
 * `realpath` and `readdir` behaviour, and a mocked filesystem would test the mock instead.
 */

export async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "uiproof-diagnosis-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
