import * as core from "@actions/core";
import * as github from "@actions/github";
import { Client } from "@notionhq/client";
import * as fm from "front-matter";
import * as fs from "fs/promises";
import * as path from "path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion.js";
import type { NotionBlock } from "./notion-types.js";
import {
  commitAndPush,
  commitAndPushToBranch,
  getCurrentBranch,
  getLastCommitTime,
} from "./git-utils.js";

type AppendChildrenRequest = Parameters<Client["blocks"]["children"]["append"]>[0];
type AppendChildren = AppendChildrenRequest["children"];
type BlocksChildrenListResponse = Awaited<ReturnType<Client["blocks"]["children"]["list"]>>;
type PartialBlockObjectResponse = BlocksChildrenListResponse["results"][number];
type BlockUpdateRequest = Parameters<Client["blocks"]["update"]>[0];
type CalloutUpdateRequest = Extract<BlockUpdateRequest, { callout: unknown }>;
type CalloutIconRequest = CalloutUpdateRequest["callout"] extends { icon?: infer T } ? T : never;
type FrontMatterResult<T> = { attributes: T; body: string };
type FrontMatterFn = <T>(file: string, options?: { allowUnsafe?: boolean }) => FrontMatterResult<T>;

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

type CommitStrategy = "push" | "pr" | "none";

type SyncedPage = {
  pageId: string;
  title: string;
};

type MappingEntry = {
  pageId: string;
  title?: string;
};

async function run(): Promise<void> {
  try {
    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const mappingFileInput = readInput("notion_mapping_file", ["NOTION_MAPPING_FILE"]);
    const indexBlockInput = readInput("index_block_id", ["INDEX_BLOCK_ID"]);
    const parentPageInput = readInput("parent_page_id", ["PARENT_PAGE_ID"]);
    const titlePrefixSeparatorInput = readInput("title_prefix_separator", [
      "TITLE_PREFIX_SEPARATOR",
    ]);
    const commitStrategyInput = readInput("commit_strategy", ["COMMIT_STRATEGY"]);
    const prBranchPrefixInput = readInput("pr_branch_prefix", ["PR_BRANCH_PREFIX"]);
    const githubToken = readInput("github_token", ["GITHUB_TOKEN"]);
    const commitStrategy = normalizeCommitStrategy(commitStrategyInput);

    if (!notionToken || !docsFolder) {
      throw new Error("Missing required inputs. Check notion_token and docs_folder.");
    }

    if (commitStrategy !== "none" && !githubToken) {
      throw new Error("github_token is required when commit_strategy is 'push' or 'pr'.");
    }

    core.setSecret(notionToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }

    const notion = new Client({ auth: notionToken });

    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const docsFolderPath = path.resolve(workspaceRoot, docsFolder);
    await ensureDirectoryExists(docsFolderPath);
    const mappingFilePath = resolveMappingFilePath(docsFolderPath, workspaceRoot, mappingFileInput);

    const indexBlockId = indexBlockInput ? normalizeNotionId(indexBlockInput) : null;
    const indexParentPageId = indexBlockId ? await resolveParentPageId(notion, indexBlockId) : null;
    const pagesParentId = parentPageInput ? normalizeNotionId(parentPageInput) : indexParentPageId;

    if (!pagesParentId) {
      throw new Error("Either index_block_id or parent_page_id must be provided.");
    }
    const titlePrefixSeparator = normalizeTitlePrefixSeparator(titlePrefixSeparatorInput);
    const prBranchPrefix = normalizePrBranchPrefix(prBranchPrefixInput);

    const markdownFiles = await collectMarkdownFiles(docsFolderPath, mappingFilePath);
    if (markdownFiles.length === 0) {
      core.warning(`No markdown files found in ${docsFolderPath}.`);
    }

    const mappingEntries = await readMappingFile(mappingFilePath);
    const documents = await loadDocuments(markdownFiles, docsFolderPath, mappingEntries);

    const knownPageUrls = new Map<string, string>();
    for (const doc of documents) {
      if (doc.notionPageId) {
        knownPageUrls.set(doc.absPath, notionPageUrl(doc.notionPageId));
      }
    }

    const changedFiles: string[] = [];
    const syncedPages: SyncedPage[] = [];
    let mappingDirty = false;

    for (const doc of documents) {
      try {
        core.info(`[${doc.relPath}] Sync start: ${doc.title}`);
        const effectiveTitle = buildTitleWithSeparator(doc, titlePrefixSeparator);
        let pageId = doc.notionPageId;
        let pageUrl = doc.notionUrl;
        let didSync = false;
        if (pageId) {
          const skipSync = await shouldSkipSync(notion, pageId, doc.absPath, workspaceRoot);
          if (skipSync) {
            core.info(`[${doc.relPath}] Skipping sync: Notion is up to date.`);
            pageUrl = pageUrl ?? notionPageUrl(pageId);
          } else {
            const resolveLink = (href: string) =>
              resolveRelativeLink(href, doc.absPath, docsFolderPath, knownPageUrls);
            const blocks = markdownToNotionBlocks(doc.body, {
              resolveLink,
              logger: (message) => core.info(`[${doc.relPath}] ${message}`),
            });
            try {
              await updatePageContent(notion, pageId, effectiveTitle, blocks);
              pageUrl = notionPageUrl(pageId);
              didSync = true;
              core.info(`[${doc.relPath}] Updated page: ${effectiveTitle}`);
            } catch (error) {
              if (!isNotionNotFoundError(error)) {
                throw error;
              }
              core.warning(`[${doc.relPath}] Notion page missing, recreating: ${effectiveTitle}`);
              pageId = undefined;
            }
          }
        }

        if (!pageId) {
          const resolveLink = (href: string) =>
            resolveRelativeLink(href, doc.absPath, docsFolderPath, knownPageUrls);
          const blocks = markdownToNotionBlocks(doc.body, {
            resolveLink,
            logger: (message) => core.info(`[${doc.relPath}] ${message}`),
          });
          const pageParentId = pagesParentId;
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
          didSync = true;
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(doc.absPath, pageUrl);
          const mappingKey = normalizeMappingKey(doc.relPath);
          const normalizedId = normalizeNotionId(pageId);
          const existing = mappingEntries.get(mappingKey);
          if (!existing || normalizeNotionId(existing.pageId) !== normalizedId) {
            mappingEntries.set(mappingKey, {
              pageId: normalizedId,
              title: didSync ? effectiveTitle : (existing?.title ?? effectiveTitle),
            });
            mappingDirty = true;
          } else if (didSync && existing.title !== effectiveTitle) {
            mappingEntries.set(mappingKey, { pageId: normalizedId, title: effectiveTitle });
            mappingDirty = true;
          }
          syncedPages.push({
            pageId,
            title: effectiveTitle,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to sync ${doc.relPath}: ${message}`);
      }
    }

    if (indexBlockId && indexParentPageId && syncedPages.length > 0) {
      await appendPageLinksAfterAnchor(notion, indexParentPageId, indexBlockId, syncedPages);
    }

    if (mappingDirty) {
      await writeMappingFile(mappingFilePath, mappingEntries);
      changedFiles.push(path.relative(workspaceRoot, mappingFilePath));
    }

    if (changedFiles.length > 0) {
      await persistNotionIds(
        changedFiles,
        githubToken,
        commitStrategy,
        workspaceRoot,
        prBranchPrefix,
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

function normalizeTitlePrefixSeparator(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "→";
  }
  return trimmed;
}

function normalizePrBranchPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "auto-notion-sync/";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function resolveMappingFilePath(
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

function normalizeMappingKey(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

async function readMappingFile(mappingFilePath: string): Promise<Map<string, MappingEntry>> {
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
    const err = error as { code?: string };
    if (err.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

async function writeMappingFile(
  mappingFilePath: string,
  entries: Map<string, MappingEntry>,
): Promise<void> {
  const lines = buildMappingTable(entries);
  await fs.writeFile(mappingFilePath, lines, "utf8");
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
  const rows = Array.from(entries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = ["| path | notion_page_id | title |", "| --- | --- | --- |"];
  for (const [relPath, entry] of rows) {
    const title = entry.title ?? "";
    const pageUrl = notionPageUrl(entry.pageId);
    const linkedTitle = title ? `[${title}](${pageUrl})` : pageUrl;
    lines.push(`| ${relPath} | ${toDashedId(entry.pageId)} | ${linkedTitle} |`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeCommitStrategy(value: string): CommitStrategy {
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

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

async function collectMarkdownFiles(dirPath: string, mappingFilePath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await collectMarkdownFiles(fullPath, mappingFilePath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      if (path.resolve(fullPath) === path.resolve(mappingFilePath)) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

async function loadDocuments(
  markdownFiles: string[],
  docsRoot: string,
  mapping: Map<string, MappingEntry>,
): Promise<DocEntry[]> {
  const documents: DocEntry[] = [];
  for (const filePath of markdownFiles) {
    const rawContent = await fs.readFile(filePath, "utf8");
    const parsed = (fm.default as unknown as FrontMatterFn)<Record<string, unknown>>(rawContent);
    const attributes = parsed.attributes || {};
    const body = parsed.body || "";

    const relPath = normalizeMappingKey(path.relative(docsRoot, filePath));
    let notionPageId: string | undefined;
    const mapped = mapping.get(relPath);
    if (mapped?.pageId) {
      notionPageId = normalizeNotionId(mapped.pageId);
    } else if (
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
      relPath: relPath,
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
    /**
     * Notion API: Retrieve a block
     * https://developers.notion.com/reference/retrieve-a-block.md
     */
    const block = await notionRequest(
      () => notion.blocks.retrieve({ block_id: currentBlockId }),
      `blocks.retrieve ${currentBlockId}`,
    );
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
  /**
   * Notion API: Create a page
   * https://developers.notion.com/reference/post-page.md
   */
  const response = await notionRequest(
    () =>
      notion.pages.create({
        parent: { page_id: toDashedId(parentPageId) },
        properties: buildTitleProperty(title),
      }),
    `pages.create ${parentPageId}`,
  );
  return {
    id: response.id,
    url: "url" in response ? response.url : null,
  };
}

async function updatePageContent(
  notion: Client,
  pageId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<void> {
  core.info(`Updating page metadata for ${pageId}...`);
  /**
   * Notion API: Update page properties
   * https://developers.notion.com/reference/patch-page.md
   */
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(pageId),
        properties: buildTitleProperty(title),
      }),
    `pages.update ${pageId}`,
  );
  core.info(`Starting block sync for ${pageId}...`);
  await syncPageBlocks(notion, pageId, blocks);
}

const NOTION_SYNC_BUFFER_MS = 60_000;

async function shouldSkipSync(
  notion: Client,
  pageId: string,
  filePath: string,
  workspaceRoot: string,
): Promise<boolean> {
  const lastCommitTime = await getLastCommitTime(filePath, workspaceRoot);
  if (!lastCommitTime) {
    core.warning(`Unable to read git commit time for ${filePath}. Syncing.`);
    return false;
  }

  /**
   * Notion API: Retrieve a page
   * https://developers.notion.com/reference/retrieve-a-page.md
   */
  const page = await notionRequest(
    () => notion.pages.retrieve({ page_id: toDashedId(pageId) }),
    `pages.retrieve ${pageId}`,
  );
  const lastEdited = "last_edited_time" in page ? page.last_edited_time : null;
  if (!lastEdited) {
    return false;
  }
  const notionTime = new Date(lastEdited);
  if (Number.isNaN(notionTime.getTime())) {
    return false;
  }

  return lastCommitTime.getTime() <= notionTime.getTime() + NOTION_SYNC_BUFFER_MS;
}

type CreatePageRequest = Parameters<Client["pages"]["create"]>[0];
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

function buildTitleWithSeparator(doc: DocEntry, separator: string): string {
  const baseTitle = doc.title || "Untitled";
  const folderPath = normalizeFolderPath(doc.relPath);
  if (!folderPath) {
    return baseTitle;
  }
  const normalizedSeparator = separator.trim();
  const delim = normalizedSeparator.length > 0 ? ` ${normalizedSeparator} ` : " ";
  return `${folderPath.replace(/\//g, delim)}${delim}${baseTitle}`;
}

function normalizeFolderPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "/") {
    return "";
  }
  return dir.replace(/^\/+/, "");
}

async function persistNotionIds(
  changedFiles: string[],
  githubToken: string,
  commitStrategy: CommitStrategy,
  workspaceRoot: string,
  prBranchPrefix: string,
): Promise<void> {
  const commitMessage = "chore: store notion page ids";

  if (commitStrategy === "none") {
    core.info(`Skipping git update: commit_strategy='none'.`);
    return;
  }

  if (commitStrategy === "push") {
    await commitAndPush(
      changedFiles,
      commitMessage,
      githubToken,
      (message) => core.info(message),
      workspaceRoot,
    );
    return;
  }

  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    throw new Error("GITHUB_REPOSITORY is required for commit_strategy='pr'.");
  }

  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${ownerRepo}`);
  }

  const baseBranch = process.env.GITHUB_REF_NAME || (await getCurrentBranch(workspaceRoot));
  const branchName = `${prBranchPrefix}${baseBranch}`;

  const pushed = await commitAndPushToBranch(
    changedFiles,
    commitMessage,
    githubToken,
    branchName,
    (message) => core.info(message),
    workspaceRoot,
    true,
  );
  if (!pushed) {
    core.info("No git changes to commit. Skipping PR update.");
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branchName}`,
    state: "open",
  });

  if (existing.data.length > 0) {
    core.info(`PR already exists: ${existing.data[0].html_url}`);
    return;
  }

  const pr = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base: baseBranch,
    title: "docs: store notion page ids [auto generated]",
    body: "Automated update of notion_page_id frontmatter for synced docs.",
  });

  core.info(`Opened PR: ${pr.data.html_url}`);
}

async function clearChildren(notion: Client, blockId: string): Promise<void> {
  core.info(`Starting block deletion for ${blockId}...`);
  const children = await listAllChildren(notion, blockId);
  if (children.length === 0) {
    core.info("No existing blocks to clear.");
    return;
  }

  const concurrencyLimit = 3;
  core.info(`Deleting ${children.length} existing blocks...`);

  const chunks = chunkArray(children, concurrencyLimit);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    await Promise.all(
      chunk.map(async (child) => {
        const blockIdValue = "id" in child ? child.id : null;
        if (typeof blockIdValue !== "string" || blockIdValue.length === 0) {
          core.warning("Skipping delete for block with missing id.");
          return;
        }
        try {
          /**
           * Notion API: Delete a block
           * https://developers.notion.com/reference/delete-a-block.md
           */
          await notionRequest(
            () => notion.blocks.delete({ block_id: blockIdValue }),
            `blocks.delete ${blockIdValue}`,
          );
        } catch (error) {
          if (isNotionNotFoundError(error)) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          core.warning(`Failed to delete block ${blockIdValue}: ${message}`);
        }
      }),
    );

    if (chunkIndex % 20 === 0 && chunkIndex > 0) {
      const deletedCount = Math.min((chunkIndex + 1) * concurrencyLimit, children.length);
      core.info(`Deleted ${deletedCount}/${children.length} blocks...`);
    }
  }

  core.info("Finished clearing page.");
}

async function listAllChildren(
  notion: Client,
  blockId: string,
): Promise<PartialBlockObjectResponse[]> {
  const results: PartialBlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    /**
     * Notion API: Retrieve block children
     * https://developers.notion.com/reference/get-block-children.md
     */
    const response = await notionRequest(
      () =>
        notion.blocks.children.list({
          block_id: toDashedId(blockId),
          start_cursor: cursor,
          page_size: 100,
        }),
      `blocks.children.list ${blockId}`,
    );
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor || undefined : undefined;
  } while (cursor);

  return results;
}

type BlockSyncStats = {
  unchanged: number;
  updated: number;
  replaced: number;
  appended: number;
  deleted: number;
};

type BlockSyncResult = {
  action: "unchanged" | "updated" | "replaced";
  newBlockId?: string;
};

async function syncPageBlocks(
  notion: Client,
  pageId: string,
  blocks: NotionBlock[],
): Promise<void> {
  if (blocks.length === 0) {
    await clearChildren(notion, pageId);
    return;
  }

  core.info(`Loading existing blocks for ${pageId}...`);
  const existingChildren = await listAllChildren(notion, pageId);
  if (existingChildren.length === 0) {
    await appendBlocksSafe(notion, pageId, blocks, (msg) => core.warning(msg));
    return;
  }

  core.info(`Syncing ${blocks.length} blocks with ${existingChildren.length} existing blocks.`);

  const stats: BlockSyncStats = {
    unchanged: 0,
    updated: 0,
    replaced: 0,
    appended: 0,
    deleted: 0,
  };

  const sharedCount = Math.min(existingChildren.length, blocks.length);
  let lastBlockId: string | null = null;

  for (let index = 0; index < sharedCount; index += 1) {
    const existing = existingChildren[index];
    const existingId = getBlockId(existing);
    if (!existingId) {
      core.warning("Skipping existing block with missing id.");
      continue;
    }
    const incoming = blocks[index];
    const result = await syncBlockPair(notion, pageId, existing, incoming);
    switch (result.action) {
      case "unchanged":
        stats.unchanged += 1;
        lastBlockId = existingId;
        break;
      case "updated":
        stats.updated += 1;
        lastBlockId = existingId;
        break;
      case "replaced":
        stats.replaced += 1;
        lastBlockId = result.newBlockId ?? existingId;
        break;
      default:
        lastBlockId = existingId;
        break;
    }
  }

  if (blocks.length > existingChildren.length) {
    const remaining = blocks.slice(sharedCount);
    if (remaining.length > 0) {
      if (lastBlockId) {
        await appendBlocksAfter(notion, pageId, lastBlockId, remaining, (msg) => core.warning(msg));
      } else {
        await appendBlocksSafe(notion, pageId, remaining, (msg) => core.warning(msg));
      }
      stats.appended += remaining.length;
    }
  }

  if (existingChildren.length > blocks.length) {
    const remainingExisting = existingChildren.slice(sharedCount);
    stats.deleted += await deleteBlocks(notion, remainingExisting);
  }

  core.info(
    `Block sync complete. Unchanged: ${stats.unchanged}, updated: ${stats.updated}, replaced: ${stats.replaced}, appended: ${stats.appended}, deleted: ${stats.deleted}.`,
  );
}

async function syncBlockPair(
  notion: Client,
  parentPageId: string,
  existing: PartialBlockObjectResponse,
  incoming: NotionBlock,
): Promise<BlockSyncResult> {
  const existingId = getBlockId(existing);
  const existingType = getBlockType(existing);
  if (!existingId || !existingType) {
    return { action: "unchanged" };
  }

  const incomingChildren = getBlockChildren(incoming);
  const existingHasChildren = blockHasChildrenExisting(existing);
  const hasChildrenToSync = incomingChildren.length > 0 || existingHasChildren;

  if (existingType === incoming.type) {
    if (areBlocksEquivalent(existing, incoming)) {
      if (hasChildrenToSync) {
        await syncPageBlocks(notion, existingId, incomingChildren);
        return { action: "updated" };
      }
      return { action: "unchanged" };
    }

    if (canUpdateBlockType(incoming.type)) {
      const updated = await updateBlockContent(notion, existingId, incoming);
      if (updated) {
        if (hasChildrenToSync) {
          await syncPageBlocks(notion, existingId, incomingChildren);
        }
        return { action: "updated" };
      }
    }
  }

  const newBlockId = await appendSingleBlockAfter(notion, parentPageId, existingId, incoming);
  await deleteBlockSafe(notion, existingId);
  return { action: "replaced", newBlockId };
}

function getBlockId(block: PartialBlockObjectResponse): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const candidate = (block as { id?: unknown }).id;
  return typeof candidate === "string" ? candidate : null;
}

function getBlockType(block: PartialBlockObjectResponse): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const candidate = (block as { type?: unknown }).type;
  return typeof candidate === "string" ? candidate : null;
}

function getBlockChildren(block: NotionBlock): NotionBlock[] {
  const content = (block as Record<string, unknown>)[block.type];
  if (!content || typeof content !== "object") {
    return [];
  }
  const children = (content as { children?: unknown }).children;
  return Array.isArray(children) ? (children as NotionBlock[]) : [];
}

function blockHasChildrenExisting(block: PartialBlockObjectResponse): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const hasChildren = (block as { has_children?: unknown }).has_children;
  return hasChildren === true;
}

function canUpdateBlockType(type: string): boolean {
  return [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "quote",
    "callout",
    "toggle",
    "to_do",
    "code",
    "equation",
    "table_of_contents",
  ].includes(type);
}

async function updateBlockContent(
  notion: Client,
  blockId: string,
  block: NotionBlock,
): Promise<boolean> {
  const request = buildBlockUpdateRequest(blockId, block);
  if (!request) {
    return false;
  }
  try {
    /**
     * Notion API: Update a block
     * https://developers.notion.com/reference/update-a-block.md
     */
    await notionRequest(() => notion.blocks.update(request), `blocks.update ${blockId}`);
    return true;
  } catch (error) {
    if (isNotionNotFoundError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Block update failed for ${blockId}: ${message}. Replacing block.`);
    return false;
  }
}

function buildBlockUpdateRequest(blockId: string, block: NotionBlock): BlockUpdateRequest | null {
  const dashedId = toDashedId(blockId);
  switch (block.type) {
    case "paragraph": {
      return {
        block_id: dashedId,
        paragraph: {
          rich_text: block.paragraph?.rich_text ?? [],
          color: block.paragraph?.color ?? "default",
        },
      };
    }
    case "heading_1": {
      return {
        block_id: dashedId,
        heading_1: {
          rich_text: block.heading_1?.rich_text ?? [],
          color: block.heading_1?.color ?? "default",
          is_toggleable: block.heading_1?.is_toggleable ?? false,
        },
      };
    }
    case "heading_2": {
      return {
        block_id: dashedId,
        heading_2: {
          rich_text: block.heading_2?.rich_text ?? [],
          color: block.heading_2?.color ?? "default",
          is_toggleable: block.heading_2?.is_toggleable ?? false,
        },
      };
    }
    case "heading_3": {
      return {
        block_id: dashedId,
        heading_3: {
          rich_text: block.heading_3?.rich_text ?? [],
          color: block.heading_3?.color ?? "default",
          is_toggleable: block.heading_3?.is_toggleable ?? false,
        },
      };
    }
    case "bulleted_list_item": {
      return {
        block_id: dashedId,
        bulleted_list_item: {
          rich_text: block.bulleted_list_item?.rich_text ?? [],
          color: block.bulleted_list_item?.color ?? "default",
        },
      };
    }
    case "numbered_list_item": {
      return {
        block_id: dashedId,
        numbered_list_item: {
          rich_text: block.numbered_list_item?.rich_text ?? [],
          color: block.numbered_list_item?.color ?? "default",
        },
      };
    }
    case "quote": {
      return {
        block_id: dashedId,
        quote: {
          rich_text: block.quote?.rich_text ?? [],
          color: block.quote?.color ?? "default",
        },
      };
    }
    case "callout": {
      const icon = toCalloutIconRequest(block.callout?.icon);
      return {
        block_id: dashedId,
        callout: {
          rich_text: block.callout?.rich_text ?? [],
          color: block.callout?.color ?? "default",
          ...(icon ? { icon } : {}),
        },
      };
    }
    case "toggle": {
      return {
        block_id: dashedId,
        toggle: {
          rich_text: block.toggle?.rich_text ?? [],
          color: block.toggle?.color ?? "default",
        },
      };
    }
    case "to_do": {
      return {
        block_id: dashedId,
        to_do: {
          rich_text: block.to_do?.rich_text ?? [],
          checked: block.to_do?.checked ?? false,
          color: block.to_do?.color ?? "default",
        },
      };
    }
    case "code": {
      return {
        block_id: dashedId,
        code: {
          rich_text: block.code?.rich_text ?? [],
          language: block.code?.language ?? "plain text",
          caption: block.code?.caption ?? [],
        },
      };
    }
    case "equation": {
      return {
        block_id: dashedId,
        equation: {
          expression: block.equation?.expression ?? "",
        },
      };
    }
    case "table_of_contents": {
      return {
        block_id: dashedId,
        table_of_contents: {
          color: block.table_of_contents?.color ?? "default",
        },
      };
    }
    default:
      return null;
  }
}

async function appendSingleBlockAfter(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string,
  block: NotionBlock,
): Promise<string> {
  core.info(`Starting single block creation after ${anchorBlockId}.`);
  /**
   * Notion API: Append block children
   * https://developers.notion.com/reference/patch-block-children.md
   */
  const response = await notionRequest(
    () =>
      notion.blocks.children.append({
        block_id: toDashedId(parentPageId),
        children: toNotionBlockRequests([block]),
        after: toDashedId(anchorBlockId),
      }),
    `blocks.children.append ${parentPageId}`,
  );
  const last = response.results[response.results.length - 1];
  if (last && typeof last === "object" && "id" in last) {
    return (last as { id: string }).id;
  }
  throw new Error("Unable to determine id for appended block.");
}

async function deleteBlocks(notion: Client, blocks: PartialBlockObjectResponse[]): Promise<number> {
  if (blocks.length === 0) {
    return 0;
  }

  core.info(`Starting batch delete for ${blocks.length} blocks...`);
  const concurrencyLimit = 3;
  const chunks = chunkArray(blocks, concurrencyLimit);
  let deletedCount = 0;

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (block) => {
        const blockId = getBlockId(block);
        if (!blockId) {
          core.warning("Skipping delete for block with missing id.");
          return;
        }
        await deleteBlockSafe(notion, blockId);
      }),
    );
    deletedCount += chunk.length;
    if (deletedCount % 50 === 0 || deletedCount === blocks.length) {
      core.info(`Deleted ${deletedCount}/${blocks.length} trailing blocks...`);
    }
  }

  return deletedCount;
}

async function deleteBlockSafe(notion: Client, blockId: string): Promise<void> {
  try {
    /**
     * Notion API: Delete a block
     * https://developers.notion.com/reference/delete-a-block.md
     */
    await notionRequest(
      () => notion.blocks.delete({ block_id: blockId }),
      `blocks.delete ${blockId}`,
    );
  } catch (error) {
    if (isNotionNotFoundError(error)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to delete block ${blockId}: ${message}`);
  }
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

  core.info(`Starting block creation for ${blockId} (${blocks.length} blocks).`);
  const chunks = chunkArray(blocks, 50);
  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
      /**
       * Notion API: Append block children
       * https://developers.notion.com/reference/patch-block-children.md
       */
      await notionRequest(
        () =>
          notion.blocks.children.append({
            block_id: toDashedId(blockId),
            children: requestChunk,
          }),
        `blocks.children.append ${blockId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          /**
           * Notion API: Append block children
           * https://developers.notion.com/reference/patch-block-children.md
           */
          await notionRequest(
            () =>
              notion.blocks.children.append({
                block_id: toDashedId(blockId),
                children: toNotionBlockRequests([block]),
              }),
            `blocks.children.append ${blockId}`,
          );
        } catch (blockError) {
          const blockMessage =
            blockError instanceof Error ? blockError.message : String(blockError);
          logger(`Failed to append block (${block.type}): ${blockMessage}`);
        }
      }
    }
  }
}

async function appendBlocksAfter(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string,
  blocks: NotionBlock[],
  logger: (message: string) => void,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  core.info(`Starting block creation after ${anchorBlockId} (${blocks.length} blocks).`);
  const chunks = chunkArray(blocks, 50);
  let afterBlockId = toDashedId(anchorBlockId);

  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
      /**
       * Notion API: Append block children
       * https://developers.notion.com/reference/patch-block-children.md
       */
      const response = await notionRequest(
        () =>
          notion.blocks.children.append({
            block_id: toDashedId(parentPageId),
            children: requestChunk,
            after: afterBlockId,
          }),
        `blocks.children.append ${parentPageId}`,
      );
      const last = response.results[response.results.length - 1];
      if (last && typeof last === "object" && "id" in last) {
        afterBlockId = (last as { id: string }).id;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          /**
           * Notion API: Append block children
           * https://developers.notion.com/reference/patch-block-children.md
           */
          const response = await notionRequest(
            () =>
              notion.blocks.children.append({
                block_id: toDashedId(parentPageId),
                children: toNotionBlockRequests([block]),
                after: afterBlockId,
              }),
            `blocks.children.append ${parentPageId}`,
          );
          const last = response.results[response.results.length - 1];
          if (last && typeof last === "object" && "id" in last) {
            afterBlockId = (last as { id: string }).id;
          }
        } catch (innerError) {
          const innerMessage =
            innerError instanceof Error ? innerError.message : String(innerError);
          logger(`Block append failed: ${innerMessage}`);
        }
      }
    }
  }
}

async function appendPageLinksAfterAnchor(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string,
  pages: SyncedPage[],
): Promise<void> {
  core.info(`Starting index link sync for anchor ${anchorBlockId}...`);
  const existingChildren = await listAllChildren(notion, parentPageId);
  const anchorId = normalizeNotionId(anchorBlockId);
  const anchorIndex = existingChildren.findIndex((child) => {
    const childId = getBlockId(child);
    if (!childId) {
      return false;
    }
    try {
      return normalizeNotionId(childId) === anchorId;
    } catch {
      return false;
    }
  });
  if (anchorIndex < 0) {
    throw new Error(`Index anchor block ${anchorBlockId} not found in parent page.`);
  }

  const existingLinkBlocks: PartialBlockObjectResponse[] = [];
  for (let i = anchorIndex + 1; i < existingChildren.length; i += 1) {
    const child = existingChildren[i];
    if (getBlockType(child) !== "link_to_page") {
      break;
    }
    existingLinkBlocks.push(child);
  }

  const blocks: NotionBlock[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const normalizedId = normalizeNotionId(page.pageId);
    if (seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);
    blocks.push({
      type: "link_to_page",
      link_to_page: {
        type: "page_id",
        page_id: toDashedId(normalizedId),
      },
    });
  }

  if (existingLinkBlocks.length > 0) {
    core.info(`Replacing ${existingLinkBlocks.length} index link blocks.`);
    await deleteBlocks(notion, existingLinkBlocks);
  }

  if (blocks.length === 0) {
    core.info("Index anchor cleared. No pages to link.");
    return;
  }

  await appendBlocksAfter(notion, parentPageId, anchorBlockId, blocks, (message) =>
    core.warning(message),
  );
}

type NormalizedAnnotations = {
  bold?: true;
  italic?: true;
  strikethrough?: true;
  underline?: true;
  code?: true;
  color?: string;
};

type NormalizedRichTextItem =
  | {
      type: "text";
      text: { content: string; link?: { url: string } };
      annotations?: NormalizedAnnotations;
    }
  | { type: string };

type NormalizedBlock = {
  type: string;
  content: unknown;
};

function areBlocksEquivalent(existing: PartialBlockObjectResponse, incoming: NotionBlock): boolean {
  const normalizedExisting = normalizeBlockForCompare(existing);
  const normalizedIncoming = normalizeBlockForCompare(incoming);
  if (!normalizedExisting || !normalizedIncoming) {
    return false;
  }
  if (normalizedExisting.type !== normalizedIncoming.type) {
    return false;
  }
  return JSON.stringify(normalizedExisting.content) === JSON.stringify(normalizedIncoming.content);
}

function normalizeBlockForCompare(block: unknown): NormalizedBlock | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }
  const content = (block as Record<string, unknown>)[type];
  const normalized = normalizeBlockContent(type, content);
  if (normalized === null) {
    return null;
  }
  return { type, content: normalized };
}

function normalizeBlockContent(type: string, content: unknown): unknown | null {
  const record = content && typeof content === "object" ? (content as Record<string, unknown>) : {};
  switch (type) {
    case "paragraph":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
    case "toggle":
      return {
        rich_text: normalizeRichTextArray(record.rich_text),
        color: normalizeColor(record.color),
      };
    case "heading_1":
    case "heading_2":
    case "heading_3":
      return {
        rich_text: normalizeRichTextArray(record.rich_text),
        color: normalizeColor(record.color),
        is_toggleable: record.is_toggleable === true,
      };
    case "callout":
      return {
        rich_text: normalizeRichTextArray(record.rich_text),
        color: normalizeColor(record.color),
        icon: normalizeCalloutIcon(record.icon),
      };
    case "to_do":
      return {
        rich_text: normalizeRichTextArray(record.rich_text),
        checked: record.checked === true,
        color: normalizeColor(record.color),
      };
    case "divider":
      return {};
    case "code":
      return {
        rich_text: normalizeRichTextArray(record.rich_text),
        language: typeof record.language === "string" ? record.language : "",
        caption: normalizeRichTextArray(record.caption),
      };
    case "equation":
      return {
        expression: typeof record.expression === "string" ? record.expression : "",
      };
    case "image":
      return {
        type: typeof record.type === "string" ? record.type : "",
        url: extractImageUrl(record),
        caption: normalizeRichTextArray(record.caption),
      };
    case "table_of_contents":
      return {
        color: normalizeColor(record.color),
      };
    case "link_to_page":
      return {
        type: typeof record.type === "string" ? record.type : "",
        page_id: normalizeNotionIdValue(record.page_id),
        database_id: normalizeNotionIdValue(record.database_id),
      };
    case "table":
    case "table_row":
      return null;
    default:
      return null;
  }
}

function normalizeRichTextArray(value: unknown): NormalizedRichTextItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: NormalizedRichTextItem[] = [];
  for (const item of value) {
    const normalized = normalizeRichTextItem(item);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeRichTextItem(value: unknown): NormalizedRichTextItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return null;
  }
  if (type !== "text") {
    return { type };
  }
  const text = record.text as { content?: unknown; link?: unknown } | undefined;
  const content = text && typeof text.content === "string" ? text.content : "";
  const link = text && typeof text.link === "object" ? (text.link as { url?: unknown }) : null;
  const linkUrl = link && typeof link.url === "string" ? link.url : null;
  const normalized: NormalizedRichTextItem = {
    type: "text",
    text: { content },
  };
  if (linkUrl) {
    normalized.text.link = { url: linkUrl };
  }
  const annotations = normalizeAnnotations(record.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }
  return normalized;
}

function normalizeAnnotations(value: unknown): NormalizedAnnotations | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const annotations: NormalizedAnnotations = {};
  if (record.bold === true) {
    annotations.bold = true;
  }
  if (record.italic === true) {
    annotations.italic = true;
  }
  if (record.strikethrough === true) {
    annotations.strikethrough = true;
  }
  if (record.underline === true) {
    annotations.underline = true;
  }
  if (record.code === true) {
    annotations.code = true;
  }
  if (typeof record.color === "string" && record.color !== "default") {
    annotations.color = record.color;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value === "default" ? undefined : value;
}

function normalizeCalloutIcon(
  value: unknown,
):
  | { type: "emoji"; emoji: string }
  | { type: "external"; url: string }
  | { type: "file"; url: string }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return undefined;
  }
  if (type === "emoji") {
    const emoji = typeof record.emoji === "string" ? record.emoji : "";
    return emoji ? { type: "emoji", emoji } : undefined;
  }
  if (type === "external") {
    const external = record.external as Record<string, unknown> | undefined;
    const url = external && typeof external.url === "string" ? external.url : "";
    return url ? { type: "external", url } : undefined;
  }
  if (type === "file") {
    const file = record.file as Record<string, unknown> | undefined;
    const url = file && typeof file.url === "string" ? file.url : "";
    return url ? { type: "file", url } : undefined;
  }
  return undefined;
}

function toCalloutIconRequest(value: unknown): CalloutIconRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return undefined;
  }
  if (type === "emoji") {
    const emoji = typeof record.emoji === "string" ? record.emoji : "";
    return emoji ? { type: "emoji", emoji } : undefined;
  }
  if (type === "external") {
    const external = record.external as Record<string, unknown> | undefined;
    const url = external && typeof external.url === "string" ? external.url : "";
    return url ? { type: "external", external: { url } } : undefined;
  }
  return undefined;
}

function normalizeNotionIdValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return normalizeNotionId(value);
  } catch {
    return value;
  }
}

function extractImageUrl(record: Record<string, unknown>): string | null {
  const type = typeof record.type === "string" ? record.type : null;
  if (type === "external") {
    const external = record.external as Record<string, unknown> | undefined;
    const url = external && typeof external.url === "string" ? external.url : null;
    return url || null;
  }
  if (type === "file") {
    const file = record.file as Record<string, unknown> | undefined;
    const url = file && typeof file.url === "string" ? file.url : null;
    return url || null;
  }
  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toNotionBlockRequests(blocks: NotionBlock[]): AppendChildren {
  return blocks as unknown as AppendChildren;
}

async function notionRequest<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) {
        throw error;
      }
      attempt += 1;
      const delayMs = getRetryDelayMs(error, attempt);
      core.warning(`Notion rate limited (${label}). Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; status?: number };
  return err.code === "rate_limited" || err.status === 429;
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  const err = error as { body?: { retry_after?: number }; headers?: Record<string, string> };
  const retryAfterHeader = err.headers?.["retry-after"];
  const headerSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
  if (!Number.isNaN(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000);
  }
  const bodySeconds = err.body?.retry_after;
  if (typeof bodySeconds === "number" && bodySeconds > 0) {
    return Math.ceil(bodySeconds * 1000);
  }
  const base = 1000;
  const backoff = base * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return backoff + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run();
