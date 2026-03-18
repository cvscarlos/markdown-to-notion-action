import * as core from "@actions/core";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import type { FormatterChoice } from "./action-inputs.js";
import { normalizeNotionId, notionPageUrl, toDashedId } from "./notion-api.js";
import type { MappingEntry } from "./sync-types.js";

type FormatterOption = {
  command: string;
  displayName: string;
  formatArgs: string[];
};

type FormatterSettings = {
  command: string;
  displayName: string;
  baseArgs: string[];
  configFlag: string;
};

const execFileAsync = promisify(execFile);

const FORMATTER_SETTINGS: Record<Exclude<FormatterChoice, "none">, FormatterSettings> = {
  prettier: {
    command: "prettier",
    displayName: "Prettier",
    baseArgs: ["--write"],
    configFlag: "--config",
  },
  biome: {
    command: "@biomejs/biome",
    displayName: "Biome",
    baseArgs: ["format", "--write"],
    configFlag: "--config-path",
  },
};

export function resolveMappingFilePath(
  docsFolderPath: string,
  workspaceRoot: string,
  input: string,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return path.join(docsFolderPath, "_notion_links.md");
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(workspaceRoot, trimmed);
}

export function normalizeMappingKey(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

export async function readMappingFile(mappingFilePath: string): Promise<Map<string, MappingEntry>> {
  try {
    const content = await fs.readFile(mappingFilePath, "utf8");
    const parsed = parseMappingTable(content);
    if (!parsed) {
      return new Map();
    }

    const { header, rows } = parsed;
    const headerMap = header.map((value) => value.trim().toLowerCase());
    const pathIndex = headerMap.findIndex((value) => ["path", "file", "markdown"].includes(value));
    const idIndex = headerMap.findIndex((value) =>
      ["notion_page_id", "notion_page", "notion_id"].includes(value),
    );
    const titleIndex = headerMap.findIndex((value) => value === "title");
    if (pathIndex === -1 || idIndex === -1) {
      return new Map();
    }

    const entries = new Map<string, MappingEntry>();
    for (const row of rows) {
      const rawPath = row[pathIndex]?.trim();
      const rawId = row[idIndex]?.trim();
      if (!rawPath || !rawId) {
        continue;
      }

      try {
        const normalizedPath = normalizeMappingKey(rawPath);
        const normalizedId = normalizeNotionId(rawId);
        const title = titleIndex >= 0 ? row[titleIndex]?.trim() : undefined;
        entries.set(normalizedPath, { pageId: normalizedId, title });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Invalid notion_page_id in mapping file for ${rawPath}: ${message}`);
      }
    }
    return entries;
  } catch (error) {
    const errorDetails = error as { code?: string };
    if (errorDetails.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function writeMappingFile(
  mappingFilePath: string,
  entries: Map<string, MappingEntry>,
): Promise<void> {
  const lines = buildMappingTable(entries);
  await fs.writeFile(mappingFilePath, lines, "utf8");
}

export async function formatMappingFileIfFormatterAvailable(
  mappingFilePath: string,
  workspaceRoot: string,
  formatterChoice: FormatterChoice,
  formatterConfigPath: string | null,
): Promise<void> {
  if (formatterChoice === "none") {
    core.info("Formatter disabled. Skipping mapping file formatting.");
    return;
  }

  const formatter = buildFormatterOption(formatterChoice, formatterConfigPath);
  core.info(`Formatting mapping file with ${formatter.displayName}: ${mappingFilePath}`);
  if (formatterConfigPath) {
    core.info(`Using ${formatter.displayName} config: ${formatterConfigPath}`);
  }

  const result = await runFormatterCommand(formatter, mappingFilePath, workspaceRoot);
  if (result.success) {
    core.info(`Formatted mapping file with ${formatter.displayName}.`);
    return;
  }

  const errorSuffix = result.error ? ` (${result.error})` : "";
  core.warning(`${formatter.displayName} failed to format${errorSuffix}.`);
}

function buildFormatterOption(
  formatterChoice: FormatterChoice,
  formatterConfigPath: string | null,
): FormatterOption {
  const settings = FORMATTER_SETTINGS[formatterChoice as Exclude<FormatterChoice, "none">];
  if (!settings) {
    throw new Error(`Unsupported formatter selection: ${formatterChoice}`);
  }

  const args = [...settings.baseArgs];
  if (formatterConfigPath) {
    args.push(settings.configFlag, formatterConfigPath);
  }

  return {
    command: settings.command,
    displayName: settings.displayName,
    formatArgs: args,
  };
}

async function runFormatterCommand(
  formatter: FormatterOption,
  mappingFilePath: string,
  workspaceRoot: string,
): Promise<{ success: boolean; error?: string }> {
  const commandArgs = ["--yes", formatter.command, ...formatter.formatArgs, mappingFilePath];
  try {
    await execFileAsync("npx", commandArgs, {
      cwd: workspaceRoot,
      env: process.env,
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

function parseMappingTable(content: string): { header: string[]; rows: string[][] } | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    const headerLine = lines[i];
    if (!headerLine.includes("|")) {
      continue;
    }

    const header = splitTableRow(headerLine);
    if (!header.some((cell) => cell.trim().toLowerCase() === "notion_page_id")) {
      continue;
    }

    const separatorLine = lines[i + 1] ?? "";
    if (!isSeparatorRow(separatorLine)) {
      continue;
    }

    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.includes("|")) {
        break;
      }

      const row = splitTableRow(line);
      if (row.length === 0) {
        break;
      }
      rows.push(row);
    }

    return { header, rows };
  }

  return null;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const stripped = line.replace(/[\s|\-:]/g, "");
  return stripped.length === 0;
}

function buildMappingTable(entries: Map<string, MappingEntry>): string {
  const rows = Array.from(entries.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  const lines = ["| path | notion_page_id | title |", "| --- | --- | --- |"];
  for (const [relPath, entry] of rows) {
    const title = entry.title ?? "";
    const pageUrl = notionPageUrl(entry.pageId);
    const linkedTitle = title ? `[${title}](${pageUrl})` : pageUrl;
    lines.push(`| ${relPath} | ${toDashedId(entry.pageId)} | ${linkedTitle} |`);
  }
  return `${lines.join("\n")}\n`;
}
