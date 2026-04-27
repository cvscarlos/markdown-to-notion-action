import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import { createHash } from "crypto";
import * as frontMatter from "front-matter";
import * as fs from "fs/promises";
import * as path from "path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion.js";
import { uploadImageBlocks } from "./image-uploads.js";
import { normalizeNotionId, notionPageUrl } from "./notion-api.js";
import { normalizeMappingKey } from "./mapping-file.js";
import { isInsidePath, isSamePath, resolveChildPath, resolveFromDirectory } from "./path-utils.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";
import type { MappingEntry, MarkdownDocument } from "./sync-types.js";

type FrontMatterResult<T> = { attributes: T; body: string };
type FrontMatterParser = <T>(
  file: string,
  options?: { allowUnsafe?: boolean },
) => FrontMatterResult<T>;

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

export async function collectMarkdownFiles(
  dirPath: string,
  mappingFilePath: string,
): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolveChildPath(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await collectMarkdownFiles(fullPath, mappingFilePath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      if (isSamePath(fullPath, mappingFilePath)) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

export async function loadMarkdownDocuments(
  markdownFiles: string[],
  docsRoot: string,
  mapping: Map<string, MappingEntry>,
): Promise<MarkdownDocument[]> {
  const documents: MarkdownDocument[] = [];
  for (const filePath of markdownFiles) {
    const markdownContent = await fs.readFile(filePath, "utf8");
    const parsedFrontMatter = (frontMatter.default as unknown as FrontMatterParser)<
      Record<string, unknown>
    >(markdownContent);
    const frontMatterAttributes = parsedFrontMatter.attributes || {};
    const markdownBody = parsedFrontMatter.body || "";

    const relPath = normalizeMappingKey(path.relative(docsRoot, filePath));
    let notionPageId: string | undefined;
    const mappedEntry = mapping.get(relPath);
    if (mappedEntry?.pageId) {
      notionPageId = normalizeNotionId(mappedEntry.pageId);
    } else if (
      typeof frontMatterAttributes.notion_page_id === "string" &&
      frontMatterAttributes.notion_page_id.trim().length > 0
    ) {
      try {
        notionPageId = normalizeNotionId(frontMatterAttributes.notion_page_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Invalid notion_page_id in ${filePath}: ${message}`);
      }
    }

    const title = extractTitle(markdownBody) || path.basename(filePath, ".md");
    documents.push({
      absPath: filePath,
      attributes: frontMatterAttributes,
      body: markdownBody,
      relPath,
      sourceHash: hashMarkdownBody(markdownBody),
      title,
      notionPageId,
      notionUrl: notionPageId ? notionPageUrl(notionPageId) : undefined,
    });
  }
  return documents;
}

export async function buildBlocksForDocument(
  notion: Client,
  documentEntry: MarkdownDocument,
  docsFolderPath: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
  githubToken: string | null,
  logContext: LogContext,
): Promise<NotionBlock[]> {
  const blocks = markdownToNotionBlocks(documentEntry.body, {
    logger: (message) => logContext.info(message),
    resolveLink: (href) =>
      resolveRelativeLink(
        href,
        documentEntry.absPath,
        docsFolderPath,
        workspaceRoot,
        knownPageUrls,
      ),
  });
  await uploadImageBlocks(notion, blocks, githubToken, logContext);
  return blocks;
}

export function buildNotionPageTitle(documentEntry: MarkdownDocument, separator: string): string {
  const baseTitle = documentEntry.title || "Untitled";
  const folderPath = normalizeFolderPath(documentEntry.relPath);
  if (!folderPath) {
    return baseTitle;
  }

  const normalizedSeparator = separator.trim();
  const separatorText = normalizedSeparator ? ` ${normalizedSeparator} ` : " ";
  return `${folderPath.replace(/\//g, separatorText)}${separatorText}${baseTitle}`;
}

function normalizeFolderPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "/") {
    return "";
  }
  return dir.replace(/^\/+/, "");
}

function resolveRelativeLink(
  href: string,
  currentFilePath: string,
  docsRoot: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
): string | null {
  const cleaned = href.split("#")[0].split("?")[0];
  if (!cleaned) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveFromDirectory(path.dirname(currentFilePath), cleaned);
  } catch {
    return null;
  }
  if (!isInsidePath(docsRoot, resolvedPath)) {
    return null;
  }

  if (path.extname(resolvedPath).toLowerCase() === ".md") {
    return knownPageUrls.get(resolvedPath) || null;
  }

  const repoRelativePath = path.relative(workspaceRoot, resolvedPath);
  if (!isInsidePath(workspaceRoot, resolvedPath)) {
    return null;
  }

  return buildGitHubRawUrl(repoRelativePath);
}

function buildGitHubRawUrl(repoRelativePath: string): string | null {
  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    return null;
  }

  const ref = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (!ref) {
    return null;
  }

  const normalizedPath = repoRelativePath.split(path.sep).join("/");
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  if (serverUrl === "https://github.com") {
    return `https://raw.githubusercontent.com/${ownerRepo}/${ref}/${normalizedPath}`;
  }
  return `${serverUrl}/raw/${ownerRepo}/${ref}/${normalizedPath}`;
}

function hashMarkdownBody(markdownBody: string): string {
  return createHash("sha256").update(markdownBody, "utf8").digest("hex");
}
