import * as core from "@actions/core";
import * as github from "@actions/github";
import { Client } from "@notionhq/client";
import * as fm from "front-matter";
import * as fs from "fs/promises";
import * as path from "path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion.js";
import type { NotionBlock } from "./notion-types.js";
import { commitAndPush, commitAndPushToBranch, getCurrentBranch } from "./git-utils.js";

type AppendChildrenRequest = Parameters<Client["blocks"]["children"]["append"]>[0];
type AppendChildren = AppendChildrenRequest["children"];
type BlocksChildrenListResponse = Awaited<ReturnType<Client["blocks"]["children"]["list"]>>;
type PartialBlockObjectResponse = BlocksChildrenListResponse["results"][number];
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
        const resolveLink = (href: string) =>
          resolveRelativeLink(href, doc.absPath, docsFolderPath, knownPageUrls);

        const blocks = markdownToNotionBlocks(doc.body, {
          resolveLink,
          logger: (message) => core.info(`[${doc.relPath}] ${message}`),
        });

        const effectiveTitle = buildTitleWithSeparator(doc, titlePrefixSeparator);
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
            core.warning(`[${doc.relPath}] Notion page missing, recreating: ${effectiveTitle}`);
            pageId = undefined;
          }
        }

        if (!pageId) {
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
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(doc.absPath, pageUrl);
          const mappingKey = normalizeMappingKey(doc.relPath);
          const normalizedId = normalizeNotionId(pageId);
          const existing = mappingEntries.get(mappingKey);
          if (!existing || normalizeNotionId(existing.pageId) !== normalizedId) {
            mappingEntries.set(mappingKey, { pageId: normalizedId, title: effectiveTitle });
            mappingDirty = true;
          } else if (existing.title !== effectiveTitle) {
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
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(pageId),
        properties: buildTitleProperty(title),
      }),
    `pages.update ${pageId}`,
  );
  await clearChildren(notion, pageId);
  await appendBlocksSafe(notion, pageId, blocks, (msg) => core.warning(msg));
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
  const children = await listAllChildren(notion, blockId);
  for (const child of children) {
    try {
      await notionRequest(
        () => notion.blocks.delete({ block_id: child.id }),
        `blocks.delete ${child.id}`,
      );
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

  const chunks = chunkArray(blocks, 50);
  let afterBlockId = toDashedId(anchorBlockId);

  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
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
  const existingChildren = await listAllChildren(notion, parentPageId);
  const existingPageIds = new Set<string>();
  for (const child of existingChildren) {
    const pageId = extractLinkedPageId(child);
    if (pageId) {
      existingPageIds.add(normalizeNotionId(pageId));
    }
  }

  const blocks: NotionBlock[] = [];
  for (const page of pages) {
    const normalizedId = normalizeNotionId(page.pageId);
    if (existingPageIds.has(normalizedId)) {
      continue;
    }
    blocks.push({
      type: "link_to_page",
      link_to_page: {
        type: "page_id",
        page_id: toDashedId(normalizedId),
      },
    });
  }

  if (blocks.length === 0) {
    core.info("Index anchor already contains all page links. Skipping append.");
    return;
  }

  await appendBlocksAfter(notion, parentPageId, anchorBlockId, blocks, (message) =>
    core.warning(message),
  );
}

function extractLinkedPageId(block: PartialBlockObjectResponse): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const typed = block as Record<string, unknown> & { type?: string };
  if (typed.type !== "link_to_page") {
    return null;
  }
  const content = typed.link_to_page as
    | { type?: string; page_id?: string; database_id?: string }
    | undefined;
  if (!content || content.type !== "page_id" || !content.page_id) {
    return null;
  }
  return content.page_id;
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
