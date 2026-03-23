import * as core from "@actions/core";

export type CommitStrategy = "push" | "pr" | "none";

export function readInput(name: string, envFallbacks: string[]): string {
  const coreValue = core.getInput(name);
  if (coreValue) {
    return coreValue.trim();
  }

  for (const env of envFallbacks) {
    const value = process.env[env];
    if (value) {
      return value.trim();
    }
  }

  return "";
}

export function normalizeTitlePrefixSeparator(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "→";
  }
  return trimmed;
}

export function normalizePrBranchPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "auto-notion-sync/";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function normalizeCommitStrategy(value: string): CommitStrategy {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "push") {
    return "push";
  }
  if (normalized === "pr" || normalized === "none") {
    return normalized;
  }
  core.warning(`Unknown commit_strategy '${value}', defaulting to 'push'.`);
  return "push";
}
