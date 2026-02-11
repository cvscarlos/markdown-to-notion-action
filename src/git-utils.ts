import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

type Logger = (message: string) => void;

async function runCommand(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  const result = await execFileAsync(command, args, {
    cwd,
    env: process.env,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

export async function commitAndPush(
  filePaths: string[],
  message: string,
  githubToken: string,
  logger: Logger,
  repoRoot?: string,
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  await runCommand("git", ["add", "--", ...filePaths], repoRoot);
  const status = await runCommand("git", ["status", "--porcelain", "--", ...filePaths], repoRoot);
  if (status.stdout.trim().length === 0) {
    logger("No git changes to commit.");
    return;
  }

  await runCommand(
    "git",
    ["config", "user.email", "github-actions[bot]@users.noreply.github.com"],
    repoRoot,
  );
  await runCommand("git", ["config", "user.name", "github-actions[bot]"], repoRoot);
  await runCommand("git", ["commit", "-m", message], repoRoot);

  await pushWithToken(githubToken, logger, repoRoot);
}

async function pushWithToken(
  githubToken: string,
  logger: Logger,
  repoRoot?: string,
): Promise<void> {
  if (!githubToken) {
    throw new Error("github_token is required to push changes back to the repository.");
  }

  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branch = branchResult.stdout.trim();
  const remoteResult = await runCommand("git", ["remote", "get-url", "origin"], repoRoot);
  const remoteUrl = remoteResult.stdout.trim();

  const pushUrl = buildAuthRemoteUrl(remoteUrl, githubToken);
  if (pushUrl) {
    await runCommand("git", ["push", pushUrl, `HEAD:${branch}`], repoRoot);
    logger(`Pushed updates to ${branch}.`);
    return;
  }

  logger("Falling back to pushing via origin remote without token.");
  await runCommand("git", ["push", "origin", branch], repoRoot);
}

function buildAuthRemoteUrl(remoteUrl: string, githubToken: string): string | null {
  if (remoteUrl.startsWith("https://")) {
    return remoteUrl.replace("https://", `https://x-access-token:${githubToken}@`);
  }

  const sshMatch = remoteUrl.match(/^git@github.com:(.+?)(\.git)?$/);
  if (sshMatch) {
    const repoPath = sshMatch[1];
    return `https://x-access-token:${githubToken}@github.com/${repoPath}.git`;
  }

  return null;
}
