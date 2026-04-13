import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface GitBootstrapResult {
  ok: boolean;
  initialized: boolean;
  createdInitialCommit: boolean;
  defaultBranch: string;
  headRef: string;
  message: string;
}

function runGit(
  repoPath: string,
  args: string[],
  extraEnv?: Record<string, string>,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
  };
}

export function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  return runGit(repoPath, ["rev-parse", "--git-dir"]).ok;
}

export function hasHeadCommit(repoPath: string): boolean {
  if (!isGitRepo(repoPath)) return false;
  return runGit(repoPath, ["rev-parse", "--verify", "HEAD"]).ok;
}

export function currentHeadRef(repoPath: string): string {
  if (!isGitRepo(repoPath)) return "";
  const result = runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

export function defaultBranchName(repoPath: string): string {
  if (!isGitRepo(repoPath)) return "main";
  const symbolic = runGit(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  if (symbolic.ok) return symbolic.stdout.trim() || "main";
  const show = runGit(repoPath, ["branch", "--show-current"]);
  return show.ok ? show.stdout.trim() || "main" : "main";
}

export function ensureGitRepo(repoPath: string): GitBootstrapResult {
  mkdirSync(repoPath, { recursive: true });
  if (isGitRepo(repoPath)) {
    return {
      ok: true,
      initialized: false,
      createdInitialCommit: false,
      defaultBranch: defaultBranchName(repoPath),
      headRef: currentHeadRef(repoPath),
      message: "Repository already initialized",
    };
  }

  const init = runGit(repoPath, ["init", "-b", "main"]);
  if (!init.ok) {
    return {
      ok: false,
      initialized: false,
      createdInitialCommit: false,
      defaultBranch: "main",
      headRef: "",
      message: init.stderr || init.stdout || "git init failed",
    };
  }

  return {
    ok: true,
    initialized: true,
    createdInitialCommit: false,
    defaultBranch: "main",
    headRef: "",
    message: "Initialized git repository",
  };
}

export function ensureHeadCommit(repoPath: string): GitBootstrapResult {
  const bootstrap = ensureGitRepo(repoPath);
  if (!bootstrap.ok) return bootstrap;
  if (hasHeadCommit(repoPath)) {
    return {
      ...bootstrap,
      defaultBranch: defaultBranchName(repoPath),
      headRef: currentHeadRef(repoPath),
      message: bootstrap.initialized ? "Initialized git repository" : "Repository already has a HEAD commit",
    };
  }

  const entries = readdirSync(repoPath).filter((entry) => entry !== ".git");
  const add = runGit(repoPath, ["add", "-A"]);
  if (!add.ok) {
    return {
      ok: false,
      initialized: bootstrap.initialized,
      createdInitialCommit: false,
      defaultBranch: defaultBranchName(repoPath),
      headRef: "",
      message: add.stderr || add.stdout || "git add failed",
    };
  }

  const commitArgs = ["commit", "-m", entries.length > 0 ? "Initial Grist bootstrap" : "Initial empty Grist bootstrap"];
  if (entries.length === 0) commitArgs.splice(1, 0, "--allow-empty");
  const commit = runGit(repoPath, commitArgs, {
    GIT_AUTHOR_NAME: process.env.GRIST_GIT_AUTHOR_NAME || "Grist",
    GIT_AUTHOR_EMAIL: process.env.GRIST_GIT_AUTHOR_EMAIL || "grist@local",
    GIT_COMMITTER_NAME: process.env.GRIST_GIT_COMMITTER_NAME || "Grist",
    GIT_COMMITTER_EMAIL: process.env.GRIST_GIT_COMMITTER_EMAIL || "grist@local",
  });
  if (!commit.ok) {
    return {
      ok: false,
      initialized: bootstrap.initialized,
      createdInitialCommit: false,
      defaultBranch: defaultBranchName(repoPath),
      headRef: "",
      message: commit.stderr || commit.stdout || "initial git commit failed",
    };
  }

  return {
    ok: true,
    initialized: bootstrap.initialized,
    createdInitialCommit: true,
    defaultBranch: defaultBranchName(repoPath),
    headRef: currentHeadRef(repoPath),
    message: entries.length > 0
      ? "Created initial git snapshot for worktree bootstrap"
      : "Created initial empty git commit for worktree bootstrap",
  };
}
