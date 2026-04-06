import { join, normalize, resolve } from "node:path";

export function assertUnderRoot(root: string, relOrAbs: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, normalize(relOrAbs));
  if (!target.startsWith(rootAbs)) {
    throw new Error(`Path escapes repo root: ${relOrAbs}`);
  }
  return target;
}

export function assertUnderWorktree(worktreeRoot: string, relPath: string): string {
  return assertUnderRoot(worktreeRoot, relPath);
}
