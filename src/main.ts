import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  BlockObjectResponse,
  PartialBlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import fm from "front-matter";
import dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion";
import type { NotionBlock, NotionRichText } from "./notion-types";
import { commitAndPush } from "./git-utils";

dotenv.config();

type DocEntry = {
  absPath: string;
  relPath: string;
  rawContent: string;
  body: string;
  attributes: Record<string, unknown>;
  title: string;
  notionPageId?: string;
  notionUrl?: string;
};

type SyncResult = {
  title: string;
  pageId: string;
  url: string;
  filePath: string;
};

type FolderStrategy = "subpages" | "title_prefix";

async function run(): Promise<void> {
  try {
    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const indexBlockInput = readInput("index_block_id", ["INDEX_BLOCK_ID"]);
    const parentPageInput = readInput("parent_page_id", ["PARENT_PAGE_ID"]);
    const folderStrategyInput = readInput("folder_strategy", ["FOLDER_STRATEGY"]);
    const pushFailureModeInput = readInput("push_failure_mode", ["PUSH_FAILURE_MODE"]);
    const githubToken = readInput("github_token", ["GITHUB_TOKEN"]);

    if (!notionToken || !docsFolder || !githubToken) {
      throw new Error("Missing required inputs. Check notion_token, docs_folder, github_token.");
    }

    if (!indexBlockInput && !parentPageInput) {
      throw new Error("Either index_block_id or parent_page_id must be provided.");
    }

    core.setSecret(notionToken);
    core.setSecret(githubToken);

    const notion = new Client({ auth: notionToken });

    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const docsFolderPath = path.resolve(workspaceRoot, docsFolder);
    await ensureDirectoryExists(docsFolderPath);

    const indexBlockId = indexBlockInput ? normalizeNotionId(indexBlockInput) : null;
    const parentPageId = indexBlockId
      ? await resolveParentPageId(notion, indexBlockId)
      : normalizeNotionId(parentPageInput);
    const folderStrategy = normalizeFolderStrategy(folderStrategyInput);
    const failOnPushError = normalizePushFailureMode(pushFailureModeInput);

    const markdownFiles = await collectMarkdownFiles(docsFolderPath);
    if (markdownFiles.length === 0) {
      core.warning(`No markdown files found in ${docsFolderPath}.`);
    }

    const documents = await loadDocuments(markdownFiles, docsFolderPath);

    const knownPageUrls = new Map<string, string>();
    for (const doc of documents) {
      if (doc.notionPageId) {
        knownPageUrls.set(doc.absPath, notionPageUrl(doc.notionPageId));
      }
    }

    const changedFiles: string[] = [];
    const syncedDocs: SyncResult[] = [];
    const folderPageCache = new Map<string, string>();

    for (const doc of documents) {
      try {
        core.info(`[${doc.relPath}] Sync start: ${doc.title}`);
        const resolveLink = (href: string) =>
          resolveRelativeLink(href, doc.absPath, docsFolderPath, knownPageUrls);

        const blocks = markdownToNotionBlocks(doc.body, {
          resolveLink,
          logger: (message) => core.info(`[${doc.relPath}] ${message}`),
        });

        const effectiveTitle = buildTitleWithStrategy(doc, folderStrategy);
        let pageId = doc.notionPageId;
        let pageUrl = doc.notionUrl;
        if (pageId) {
          try {
            await updatePageContent(notion, pageId, effectiveTitle, blocks);
            pageUrl = notionPageUrl(pageId);
            core.info(`[${doc.relPath}] Updated page: ${effectiveTitle}`);
          } catch (error) {
            if (!isNotionNotFoundError(error)) {
              throw error;
            }
            core.warning(
              `[${doc.relPath}] Notion page missing, recreating: ${effectiveTitle}`,
            );
            pageId = undefined;
          }
        }

        if (!pageId) {
          const pageParentId =
            folderStrategy === "subpages"
              ? await resolveFolderParentPage(notion, parentPageId, doc.relPath, folderPageCache)
              : parentPageId;
          const created = await createPage(notion, pageParentId, effectiveTitle);
          pageId = normalizeNotionId(created.id);
          pageUrl = created.url || notionPageUrl(pageId);
          core.info(`[${doc.relPath}] Created page: ${effectiveTitle}`);
          if (pageUrl) {
            core.info(`[${doc.relPath}] Page URL: ${pageUrl}`);
          }
          await appendBlocksSafe(notion, pageId, blocks, (msg) =>
            core.warning(`[${doc.relPath}] ${msg}`),
          );

          const updatedContent = upsertFrontMatter(
            doc.rawContent,
            "notion_page_id",
            toDashedId(pageId),
          );
          if (updatedContent !== doc.rawContent) {
            await fs.writeFile(doc.absPath, updatedContent, "utf8");
            changedFiles.push(path.relative(workspaceRoot, doc.absPath));
          }
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(doc.absPath, pageUrl);
          syncedDocs.push({
            title: effectiveTitle,
            pageId,
            url: pageUrl,
            filePath: doc.absPath,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to sync ${doc.relPath}: ${message}`);
      }
    }

    if (indexBlockId) {
      if (syncedDocs.length > 0) {
        await updateIndexBlock(notion, indexBlockId, syncedDocs);
      } else {
        core.warning("No documents were synced. Skipping index update.");
      }
    }

    if (changedFiles.length > 0) {
      await commitAndPush(
        changedFiles,
        "chore: store notion page ids",
        githubToken,
        (message) => core.info(message),
        workspaceRoot,
        failOnPushError,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

function readInput(name: string, envFallbacks: string[]): string {
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

function isNotionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; status?: number; message?: string };
  if (err.code === "object_not_found") {
    return true;
  }
  if (err.status === 404) {
    return true;
  }
  if (typeof err.message === "string" && err.message.toLowerCase().includes("not found")) {
    return true;
  }
  return false;
}

function normalizeFolderStrategy(value: string): FolderStrategy {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "subpages";
  }
  if (normalized === "subpages" || normalized === "title_prefix") {
    return normalized;
  }
  core.warning(`Unknown folder_strategy '${value}', defaulting to 'subpages'.`);
  return "subpages";
}

function normalizePushFailureMode(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "fail") {
    return true;
  }
  if (normalized === "warn") {
    return false;
  }
  core.warning(`Unknown push_failure_mode '${value}', defaulting to 'fail'.`);
  return true;
}

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function loadDocuments(markdownFiles: string[], docsRoot: string): Promise<DocEntry[]> {
  const documents: DocEntry[] = [];
  for (const filePath of markdownFiles) {
    const rawContent = await fs.readFile(filePath, "utf8");
    const parsed = fm<Record<string, unknown>>(rawContent);
    const attributes = parsed.attributes || {};
    const body = parsed.body || "";

    let notionPageId: string | undefined;
    if (
      typeof attributes.notion_page_id === "string" &&
      attributes.notion_page_id.trim().length > 0
    ) {
      try {
        notionPageId = normalizeNotionId(attributes.notion_page_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Invalid notion_page_id in ${filePath}: ${message}`);
      }
    }

    const titleFromFrontMatter = typeof attributes.title === "string" ? attributes.title : "";
    const titleFromMarkdown = extractTitle(body);
    const title = titleFromFrontMatter || titleFromMarkdown || path.basename(filePath, ".md");

    documents.push({
      absPath: filePath,
      relPath: path.relative(docsRoot, filePath),
      rawContent,
      body,
      attributes,
      title,
      notionPageId,
      notionUrl: notionPageId ? notionPageUrl(notionPageId) : undefined,
    });
  }

  return documents;
}

function resolveRelativeLink(
  href: string,
  currentFilePath: string,
  docsRoot: string,
  knownPageUrls: Map<string, string>,
): string | null {
  const cleaned = href.split("#")[0].split("?")[0];
  if (!cleaned) {
    return null;
  }

  const resolvedPath = path.resolve(path.dirname(currentFilePath), cleaned);
  const relativePath = path.relative(docsRoot, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  if (path.extname(resolvedPath).toLowerCase() === ".md") {
    return knownPageUrls.get(resolvedPath) || null;
  }

  return null;
}

function normalizeNotionId(input: string): string {
  const matches = input.match(
    /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  );
  if (!matches || matches.length === 0) {
    throw new Error(`Invalid Notion id: ${input}`);
  }
  const raw = matches[matches.length - 1];
  const cleaned = raw.replace(/-/g, "").toLowerCase();
  if (cleaned.length !== 32) {
    throw new Error(`Invalid Notion id: ${input}`);
  }
  return cleaned;
}

function toDashedId(id: string): string {
  const cleaned = normalizeNotionId(id);
  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
}

function notionPageUrl(id: string): string {
  const cleaned = normalizeNotionId(id);
  return `https://www.notion.so/${cleaned}`;
}

async function resolveParentPageId(notion: Client, blockId: string): Promise<string> {
  let currentBlockId = toDashedId(blockId);
  for (let depth = 0; depth < 10; depth += 1) {
    const block = await notion.blocks.retrieve({ block_id: currentBlockId });
    if (!("parent" in block)) {
      throw new Error("Unable to resolve parent for index block.");
    }
    const parent = block.parent;
    if (parent.type === "page_id") {
      return normalizeNotionId(parent.page_id);
    }
    if (parent.type === "block_id") {
      currentBlockId = parent.block_id;
      continue;
    }
    throw new Error(`Index block parent type ${parent.type} is not supported.`);
  }
  throw new Error("Index block parent resolution exceeded depth limit.");
}

async function createPage(
  notion: Client,
  parentPageId: string,
  title: string,
): Promise<{ id: string; url?: string | null }> {
  const response = await notion.pages.create({
    parent: { page_id: toDashedId(parentPageId) },
    properties: buildTitleProperty(title),
  });
  return {
    id: response.id,
    url: "url" in response ? response.url : null,
  };
}

async function resolveFolderParentPage(
  notion: Client,
  rootPageId: string,
  relPath: string,
  cache: Map<string, string>,
): Promise<string> {
  const folderPath = normalizeFolderPath(relPath);
  if (!folderPath) {
    return rootPageId;
  }

  const segments = folderPath.split("/");
  let currentParentId = rootPageId;
  let currentPath = "";

  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const cached = cache.get(currentPath);
    if (cached) {
      currentParentId = cached;
      continue;
    }

    const pageId = await findOrCreateChildPage(notion, currentParentId, segment);
    cache.set(currentPath, pageId);
    currentParentId = pageId;
  }

  return currentParentId;
}

async function findOrCreateChildPage(
  notion: Client,
  parentPageId: string,
  title: string,
): Promise<string> {
  const existing = await findChildPageByTitle(notion, parentPageId, title);
  if (existing) {
    return existing;
  }

  const created = await notion.pages.create({
    parent: { page_id: toDashedId(parentPageId) },
    properties: buildTitleProperty(title),
  });
  return normalizeNotionId(created.id);
}

async function findChildPageByTitle(
  notion: Client,
  parentPageId: string,
  title: string,
): Promise<string | null> {
  const children = await listAllChildren(notion, parentPageId);
  for (const child of children) {
    if (!("type" in child)) {
      continue;
    }
    if (child.type !== "child_page") {
      continue;
    }
    const childTitle = (child as { child_page?: { title?: string } }).child_page?.title;
    if (childTitle === title) {
      return normalizeNotionId(child.id);
    }
  }
  return null;
}

async function updatePageContent(
  notion: Client,
  pageId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<void> {
  await notion.pages.update({
    page_id: toDashedId(pageId),
    properties: buildTitleProperty(title),
  });
  await clearChildren(notion, pageId);
  await appendBlocksSafe(notion, pageId, blocks, (msg) => core.warning(msg));
}

type CreatePageRequest = Parameters<Client["pages"]["create"]>[0];
type UpdatePageRequest = Parameters<Client["pages"]["update"]>[0];
type PageProperties = CreatePageRequest["properties"];

function buildTitleProperty(title: string): PageProperties {
  return {
    title: {
      title: [
        {
          type: "text",
          text: { content: title },
        },
      ],
    },
  } as PageProperties;
}

function buildTitleWithStrategy(doc: DocEntry, strategy: FolderStrategy): string {
  const baseTitle = doc.title || "Untitled";
  if (strategy !== "title_prefix") {
    return baseTitle;
  }
  const folderPath = normalizeFolderPath(doc.relPath);
  if (!folderPath) {
    return baseTitle;
  }
  return `${folderPath}/${baseTitle}`;
}

function normalizeFolderPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "/") {
    return "";
  }
  return dir.replace(/^\/+/, "");
}

async function updateIndexBlock(
  notion: Client,
  indexBlockId: string,
  documents: SyncResult[],
): Promise<void> {
  const block = await notion.blocks.retrieve({ block_id: toDashedId(indexBlockId) });
  if (!("type" in block)) {
    core.warning("Unable to resolve index block type. Skipping index update.");
    return;
  }

  if (!blockSupportsChildren(block.type)) {
    const updated = await updateIndexInline(notion, block as BlockObjectResponse, documents);
    if (!updated) {
      core.warning(
        `Index block type '${block.type}' does not support children. Skipping index update.`,
      );
    }
    return;
  }

  await clearChildren(notion, indexBlockId);

  const listBlocks: NotionBlock[] = [];
  for (const doc of documents) {
    listBlocks.push(...buildIndexListItemBlocks(doc.title, doc.url));
  }

  await appendBlocksSafe(notion, indexBlockId, listBlocks, (msg) => core.warning(msg));
}

function buildIndexListItemBlocks(title: string, url: string): NotionBlock[] {
  const chunks = splitText(title, 2000);
  return chunks.map((chunk) => ({
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          text: {
            content: chunk,
            link: { url },
          },
        },
      ],
      color: "default",
    },
  }));
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

function blockSupportsChildren(type: string): boolean {
  return [
    "toggle",
    "to_do",
    "bulleted_list_item",
    "numbered_list_item",
    "callout",
    "quote",
    "synced_block",
  ].includes(type);
}

function blockSupportsInlineRichText(type: string): boolean {
  return [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "callout",
    "toggle",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "quote",
  ].includes(type);
}

async function updateIndexInline(
  notion: Client,
  block: BlockObjectResponse,
  documents: SyncResult[],
): Promise<boolean> {
  if (!blockSupportsInlineRichText(block.type)) {
    return false;
  }

  const existingText = extractPlainText(block);
  const baseText = existingText.split("\n")[0].trim();
  const richText = buildInlineIndexRichText(baseText, documents);

  const blockValue = ((block as Record<string, unknown>)[block.type] ?? {}) as {
    color?: string;
    icon?: unknown;
    checked?: boolean;
    is_toggleable?: boolean;
    rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>;
  };
  const updateValue: Record<string, unknown> = {
    rich_text: richText,
  };

  if (blockValue?.color) {
    updateValue.color = blockValue.color;
  }
  if (block.type === "callout" && blockValue?.icon) {
    updateValue.icon = blockValue.icon;
  }
  if (block.type === "to_do" && typeof blockValue?.checked === "boolean") {
    updateValue.checked = blockValue.checked;
  }
  if (
    (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3") &&
    typeof blockValue?.is_toggleable === "boolean"
  ) {
    updateValue.is_toggleable = blockValue.is_toggleable;
  }

  const updatePayload = {
    block_id: toDashedId(block.id),
    [block.type]: updateValue,
  } as unknown as Parameters<Client["blocks"]["update"]>[0];

  await notion.blocks.update(updatePayload);

  core.warning(
    `Index block type '${block.type}' does not support children. Wrote list inline instead.`,
  );
  return true;
}

function extractPlainText(block: BlockObjectResponse): string {
  const blockValue = ((block as Record<string, unknown>)[block.type] ?? {}) as {
    rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>;
  };
  if (!blockValue || !Array.isArray(blockValue.rich_text)) {
    return "";
  }
  return blockValue.rich_text
    .map((item: { plain_text?: string; text?: { content?: string } }) => {
      if (typeof item.plain_text === "string") {
        return item.plain_text;
      }
      return item.text?.content ?? "";
    })
    .join("");
}

function buildInlineIndexRichText(baseText: string, documents: SyncResult[]): NotionRichText[] {
  const richText: NotionRichText[] = [];

  if (baseText.length > 0) {
    richText.push({
      type: "text",
      text: { content: baseText },
    });
  }

  for (const doc of documents) {
    const prefix = `${baseText.length > 0 || richText.length > 0 ? "\n" : ""}• `;
    richText.push({
      type: "text",
      text: { content: prefix },
    });
    const chunks = splitText(doc.title, 2000);
    if (chunks.length === 0) {
      continue;
    }
    for (const chunk of chunks) {
      richText.push({
        type: "text",
        text: {
          content: chunk,
          link: { url: doc.url },
        },
      });
    }
  }

  return richText;
}

async function clearChildren(notion: Client, blockId: string): Promise<void> {
  const children = await listAllChildren(notion, blockId);
  for (const child of children) {
    try {
      await notion.blocks.delete({ block_id: child.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to delete block ${child.id}: ${message}`);
    }
  }
}

async function listAllChildren(
  notion: Client,
  blockId: string,
): Promise<PartialBlockObjectResponse[]> {
  const results: PartialBlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: toDashedId(blockId),
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor || undefined : undefined;
  } while (cursor);

  return results;
}

async function appendBlocksSafe(
  notion: Client,
  blockId: string,
  blocks: NotionBlock[],
  logger: (message: string) => void,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  const chunks = chunkArray(blocks, 50);
  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
      await notion.blocks.children.append({
        block_id: toDashedId(blockId),
        children: requestChunk,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          await notion.blocks.children.append({
            block_id: toDashedId(blockId),
            children: toNotionBlockRequests([block]),
          });
        } catch (blockError) {
          const blockMessage =
            blockError instanceof Error ? blockError.message : String(blockError);
          logger(`Failed to append block (${block.type}): ${blockMessage}`);
        }
      }
    }
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toNotionBlockRequests(blocks: NotionBlock[]): BlockObjectRequest[] {
  return blocks as unknown as BlockObjectRequest[];
}

function upsertFrontMatter(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return [`---`, `${key}: ${value}`, `---`, "", ...lines].join("\n");
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return [`---`, `${key}: ${value}`, `---`, "", ...lines].join("\n");
  }

  const frontMatterLines = lines.slice(1, endIndex);
  let updated = false;
  const updatedLines = frontMatterLines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}:`)) {
      updated = true;
      return `${key}: ${value}`;
    }
    return line;
  });

  if (!updated) {
    updatedLines.push(`${key}: ${value}`);
  }

  return ["---", ...updatedLines, "---", ...lines.slice(endIndex + 1)].join("\n");
}

run();
