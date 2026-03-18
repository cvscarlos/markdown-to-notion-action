import * as core from "@actions/core";
import * as path from "path";

export type CommitStrategy = "push" | "pr" | "none";
export type FormatterChoice = "biome" | "none" | "prettier";

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

export function normalizeFormatterChoice(value: string): FormatterChoice {
  const normalized = value.trim().toLowerCase() || "prettier";
  if (["prettier", "biome", "none"].includes(normalized)) {
    return normalized as FormatterChoice;
  }
  throw new Error(`Invalid formatter: ${value}. Use 'prettier', 'biome', or 'none'.`);
}

export function resolveFormatterConfigPath(value: string, workspaceRoot: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceRoot, trimmed);
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
