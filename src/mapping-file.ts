import * as core from "@actions/core";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { normalizeNotionId, notionPageUrl, toDashedId } from "./notion-api.js";
import type { MappingEntry } from "./sync-types.js";

const execFileAsync = promisify(execFile);

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
    const sourceHashIndex = headerMap.findIndex((value) => value === "source_hash");
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
        const sourceHash = sourceHashIndex >= 0 ? row[sourceHashIndex]?.trim() : undefined;
        const title = titleIndex >= 0 ? row[titleIndex]?.trim() : undefined;
        entries.set(normalizedPath, {
          pageId: normalizedId,
          sourceHash: sourceHash || undefined,
          title,
        });
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

export async function formatMappingFile(
  mappingFilePath: string,
  workspaceRoot: string,
): Promise<void> {
  core.info(`Formatting mapping file with Prettier: ${mappingFilePath}`);
  try {
    await execFileAsync("npx", ["--yes", "prettier", "--write", mappingFilePath], {
      cwd: workspaceRoot,
      env: process.env,
    });
    core.info("Formatted mapping file with Prettier.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Prettier failed to format (${message}).`);
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
  const lines = ["| path | notion_page_id | source_hash | title |", "| --- | --- | --- | --- |"];
  for (const [relPath, entry] of rows) {
    const sourceHash = entry.sourceHash ?? "";
    const title = entry.title ?? "";
    const pageUrl = notionPageUrl(entry.pageId);
    const linkedTitle = title ? `[${title}](${pageUrl})` : pageUrl;
    lines.push(`| ${relPath} | ${toDashedId(entry.pageId)} | ${sourceHash} | ${linkedTitle} |`);
  }
  return `${lines.join("\n")}\n`;
}
