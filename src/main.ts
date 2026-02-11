import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  PartialBlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import fm from "front-matter";
import dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion";
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

async function run(): Promise<void> {
  try {
    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const indexBlockInput = readInput("index_block_id", ["INDEX_BLOCK_ID"]);
    const parentPageInput = readInput("parent_page_id", ["PARENT_PAGE_ID"]);
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

    for (const doc of documents) {
      try {
        const resolveLink = (href: string) =>
          resolveRelativeLink(href, doc.absPath, docsFolderPath, knownPageUrls);

        const blocks = markdownToNotionBlocks(doc.body, {
          resolveLink,
          logger: (message) => core.info(`[${doc.relPath}] ${message}`),
        });

        const title = doc.title || "Untitled";
        let pageId = doc.notionPageId;
        let pageUrl = doc.notionUrl;

        if (pageId) {
          await updatePageContent(notion, pageId, title, blocks);
          pageUrl = notionPageUrl(pageId);
        } else {
          const created = await createPage(notion, parentPageId, title);
          pageId = normalizeNotionId(created.id);
          pageUrl = created.url || notionPageUrl(pageId);
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
            title,
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
): Promise<{ id: string; url: string | null } & Record<string, unknown>> {
  const response = await notion.pages.create({
    parent: { page_id: toDashedId(parentPageId) },
    properties: buildTitleProperty(title),
  });
  return response;
}

async function updatePageContent(
  notion: Client,
  pageId: string,
  title: string,
  blocks: BlockObjectRequest[],
): Promise<void> {
  await notion.pages.update({
    page_id: toDashedId(pageId),
    properties: buildTitleProperty(title),
  });
  await clearChildren(notion, pageId);
  await appendBlocksSafe(notion, pageId, blocks, (msg) => core.warning(msg));
}

function buildTitleProperty(title: string): Record<string, unknown> {
  return {
    title: {
      title: [
        {
          type: "text",
          text: { content: title },
        },
      ],
    },
  };
}

async function updateIndexBlock(
  notion: Client,
  indexBlockId: string,
  documents: SyncResult[],
): Promise<void> {
  await clearChildren(notion, indexBlockId);

  const listBlocks: BlockObjectRequest[] = [];
  for (const doc of documents) {
    listBlocks.push(...buildIndexListItemBlocks(doc.title, doc.url));
  }

  await appendBlocksSafe(notion, indexBlockId, listBlocks, (msg) => core.warning(msg));
}

function buildIndexListItemBlocks(title: string, url: string): BlockObjectRequest[] {
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
  blocks: BlockObjectRequest[],
  logger: (message: string) => void,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  const chunks = chunkArray(blocks, 50);
  for (const chunk of chunks) {
    try {
      await notion.blocks.children.append({
        block_id: toDashedId(blockId),
        children: chunk,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          await notion.blocks.children.append({
            block_id: toDashedId(blockId),
            children: [block],
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
