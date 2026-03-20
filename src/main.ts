import * as core from "@actions/core";
import * as github from "@actions/github";
import { Client } from "@notionhq/client";
import * as path from "path";
import {
  normalizeCommitStrategy,
  normalizeFormatterChoice,
  normalizePrBranchPrefix,
  normalizeTitlePrefixSeparator,
  readInput,
  resolveFormatterConfigPath,
} from "./action-inputs.js";
import type { CommitStrategy } from "./action-inputs.js";
import {
  buildBlocksForDocument,
  buildNotionPageTitle,
  collectMarkdownFiles,
  ensureDirectoryExists,
  loadMarkdownDocuments,
} from "./documents.js";
import type { NotionBlock } from "./notion-types.js";
import {
  commitAndPush,
  commitAndPushToBranch,
  getCurrentBranch,
  getLastCommitTime,
} from "./git-utils.js";
import { createLogContext, defaultLogContext } from "./logging.js";
import {
  formatMappingFileIfFormatterAvailable,
  normalizeMappingKey,
  readMappingFile,
  resolveMappingFilePath,
  writeMappingFile,
} from "./mapping-file.js";
import {
  type AppendChildren,
  type BlockUpdateRequest,
  type CalloutIconRequest,
  type PartialBlockObjectResponse,
  isNotionArchivedError,
  isNotionNotFoundError,
  listAllChildren,
  normalizeNotionId,
  normalizeNotionIdValue,
  notionPageUrl,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { SyncedPage } from "./sync-types.js";

type SyncDecision = {
  skipSync: boolean;
  archivedOrMissing: boolean;
};

async function run(): Promise<void> {
  try {
    const actionRef = process.env.ACTION_SOURCE_REF || process.env.GITHUB_ACTION_REF || "unknown";
    const actionRepo =
      process.env.ACTION_SOURCE_REPOSITORY || process.env.GITHUB_ACTION_REPOSITORY || "unknown";
    core.info(`Action source: ${actionRepo}@${actionRef}`);
    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const mappingFileInput = readInput("notion_mapping_file", ["NOTION_MAPPING_FILE"]);
    const pageBlockInput = readInput("page_block_id", ["PAGE_BLOCK_ID"]);
    const pageInput = readInput("page_id", ["PAGE_ID"]);
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

    const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
    const pageBlockParentId = pageBlockId ? await resolveParentPageId(notion, pageBlockId) : null;
    const pagesParentId = pageInput ? normalizeNotionId(pageInput) : pageBlockParentId;

    if (!pagesParentId) {
      throw new Error("Either page_block_id or page_id must be provided.");
    }
    const titlePrefixSeparator = normalizeTitlePrefixSeparator(titlePrefixSeparatorInput);
    const prBranchPrefix = normalizePrBranchPrefix(prBranchPrefixInput);
    const formatterChoice = normalizeFormatterChoice(readInput("formatter", ["FORMATTER"]));
    const formatterConfigPath = resolveFormatterConfigPath(
      readInput("formatter_config", ["FORMATTER_CONFIG"]),
      workspaceRoot,
    );

    const markdownFiles = await collectMarkdownFiles(docsFolderPath, mappingFilePath);
    if (markdownFiles.length === 0) {
      core.warning(`No markdown files found in ${docsFolderPath}.`);
    }

    const mappingEntries = await readMappingFile(mappingFilePath);
    const documents = await loadMarkdownDocuments(markdownFiles, docsFolderPath, mappingEntries);

    const knownPageUrls = new Map<string, string>();
    for (const documentEntry of documents) {
      if (documentEntry.notionPageId) {
        knownPageUrls.set(documentEntry.absPath, notionPageUrl(documentEntry.notionPageId));
      }
    }

    const changedFiles: string[] = [];
    const syncedPages: SyncedPage[] = [];
    let mappingDirty = false;

    for (const documentEntry of documents) {
      try {
        const documentLog = createLogContext(documentEntry.relPath);
        documentLog.info(`Sync start: ${documentEntry.title}`);
        const pageTitle = buildNotionPageTitle(documentEntry, titlePrefixSeparator);
        let pageId = documentEntry.notionPageId;
        let pageUrl = documentEntry.notionUrl;
        let pageWasWritten = false;
        if (pageId) {
          const decision = await getSyncDecision(
            notion,
            pageId,
            documentEntry.absPath,
            githubToken,
            workspaceRoot,
            documentLog,
          );
          if (decision.archivedOrMissing) {
            documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
            pageId = undefined;
          } else if (decision.skipSync) {
            documentLog.info("Skipping sync: Notion is up to date.");
            pageUrl = pageUrl ?? notionPageUrl(pageId);
          } else {
            const blocks = await buildBlocksForDocument(
              notion,
              documentEntry,
              docsFolderPath,
              workspaceRoot,
              knownPageUrls,
              githubToken,
              documentLog,
            );
            try {
              await updatePageContent(notion, pageId, pageTitle, blocks, documentLog);
              pageUrl = notionPageUrl(pageId);
              pageWasWritten = true;
              documentLog.info(`Updated page: ${pageTitle}`);
            } catch (error) {
              if (!isNotionNotFoundError(error) && !isNotionArchivedError(error)) {
                throw error;
              }
              documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
              pageId = undefined;
            }
          }
        }

        if (!pageId) {
          const blocks = await buildBlocksForDocument(
            notion,
            documentEntry,
            docsFolderPath,
            workspaceRoot,
            knownPageUrls,
            githubToken,
            documentLog,
          );
          const pageParentId = pagesParentId;
          const created = await createPage(notion, pageParentId, pageTitle);
          pageId = normalizeNotionId(created.id);
          pageUrl = created.url || notionPageUrl(pageId);
          documentLog.info(`Created page: ${pageTitle}`);
          if (pageUrl) {
            documentLog.info(`Page URL: ${pageUrl}`);
          }
          await appendBlocksSafe(notion, pageId, blocks, documentLog);
          pageWasWritten = true;
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(documentEntry.absPath, pageUrl);
          const mappingKey = normalizeMappingKey(documentEntry.relPath);
          const normalizedId = normalizeNotionId(pageId);
          const existingMapping = mappingEntries.get(mappingKey);
          if (!existingMapping || normalizeNotionId(existingMapping.pageId) !== normalizedId) {
            mappingEntries.set(mappingKey, {
              pageId: normalizedId,
              title: pageWasWritten ? pageTitle : (existingMapping?.title ?? pageTitle),
            });
            mappingDirty = true;
          } else if (pageWasWritten && existingMapping.title !== pageTitle) {
            mappingEntries.set(mappingKey, { pageId: normalizedId, title: pageTitle });
            mappingDirty = true;
          }
          syncedPages.push({
            pageId,
            title: pageTitle,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to sync ${documentEntry.relPath}: ${message}`);
      }
    }

    if (pageBlockId && pageBlockParentId && syncedPages.length > 0) {
      const indexLog = createLogContext("index");
      await appendPageLinksAfterAnchor(
        notion,
        pageBlockParentId,
        pageBlockId,
        syncedPages,
        indexLog,
      );
    }

    if (mappingDirty) {
      await writeMappingFile(mappingFilePath, mappingEntries);
      if (commitStrategy !== "none") {
        await formatMappingFileIfFormatterAvailable(
          mappingFilePath,
          workspaceRoot,
          formatterChoice,
          formatterConfigPath,
        );
      }
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
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Updating page metadata for ${pageId}...`);
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
  logContext.info(`Starting block sync for ${pageId}...`);
  await syncPageBlocks(notion, pageId, blocks, logContext);
}

const NOTION_SYNC_BUFFER_MS = 60_000;

async function getSyncDecision(
  notion: Client,
  pageId: string,
  filePath: string,
  githubToken: string | null,
  workspaceRoot: string,
  logContext: LogContext = defaultLogContext,
): Promise<SyncDecision> {
  const lastCommitTime = await getLastCommitTime(filePath, workspaceRoot, githubToken);
  if (!lastCommitTime) {
    logContext.warn(`Unable to read git commit time for ${filePath}. Syncing.`);
  }

  /**
   * Notion API: Retrieve a page
   * https://developers.notion.com/reference/retrieve-a-page.md
   */
  let page: Awaited<ReturnType<Client["pages"]["retrieve"]>>;
  try {
    page = await notionRequest(
      () => notion.pages.retrieve({ page_id: toDashedId(pageId) }),
      `pages.retrieve ${pageId}`,
    );
  } catch (error) {
    if (isNotionNotFoundError(error)) {
      return { skipSync: false, archivedOrMissing: true };
    }
    throw error;
  }

  if ("archived" in page && page.archived) {
    return { skipSync: false, archivedOrMissing: true };
  }
  if ("in_trash" in page && page.in_trash) {
    return { skipSync: false, archivedOrMissing: true };
  }
  if (!lastCommitTime) {
    return { skipSync: false, archivedOrMissing: false };
  }

  const lastEdited = "last_edited_time" in page ? page.last_edited_time : null;
  if (!lastEdited) {
    return { skipSync: false, archivedOrMissing: false };
  }
  const notionTime = new Date(lastEdited);
  if (Number.isNaN(notionTime.getTime())) {
    return { skipSync: false, archivedOrMissing: false };
  }

  return {
    skipSync: lastCommitTime.getTime() <= notionTime.getTime() + NOTION_SYNC_BUFFER_MS,
    archivedOrMissing: false,
  };
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

async function clearChildren(
  notion: Client,
  blockId: string,
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Starting block deletion for ${blockId}...`);
  const children = await listAllChildren(notion, blockId);
  if (children.length === 0) {
    logContext.info("No existing blocks to clear.");
    return;
  }

  const concurrencyLimit = 3;
  logContext.info(`Deleting ${children.length} existing blocks...`);

  const chunks = chunkArray(children, concurrencyLimit);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    await Promise.all(
      chunk.map(async (child) => {
        const blockIdValue = "id" in child ? child.id : null;
        if (typeof blockIdValue !== "string" || blockIdValue.length === 0) {
          logContext.warn("Skipping delete for block with missing id.");
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
          logContext.warn(`Failed to delete block ${blockIdValue}: ${message}`);
        }
      }),
    );

    if (chunkIndex % 20 === 0 && chunkIndex > 0) {
      const deletedCount = Math.min((chunkIndex + 1) * concurrencyLimit, children.length);
      logContext.info(`Deleted ${deletedCount}/${children.length} blocks...`);
    }
  }

  logContext.info("Finished clearing page.");
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
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  if (blocks.length === 0) {
    await clearChildren(notion, pageId, logContext);
    return;
  }

  logContext.info(`Loading existing blocks for ${pageId}...`);
  const existingChildren = await listAllChildren(notion, pageId);
  if (existingChildren.length === 0) {
    await appendBlocksSafe(notion, pageId, blocks, logContext);
    return;
  }

  logContext.info(
    `Syncing ${blocks.length} blocks with ${existingChildren.length} existing blocks.`,
  );

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
      logContext.warn("Skipping existing block with missing id.");
      continue;
    }
    const incoming = blocks[index];
    const result = await syncBlockPair(notion, pageId, existing, incoming, logContext);
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
        await appendBlocksAfter(notion, pageId, lastBlockId, remaining, logContext);
      } else {
        await appendBlocksSafe(notion, pageId, remaining, logContext);
      }
      stats.appended += remaining.length;
    }
  }

  if (existingChildren.length > blocks.length) {
    const remainingExisting = existingChildren.slice(sharedCount);
    stats.deleted += await deleteBlocks(notion, remainingExisting, logContext);
  }

  logContext.info(
    `Block sync complete. Unchanged: ${stats.unchanged}, updated: ${stats.updated}, replaced: ${stats.replaced}, appended: ${stats.appended}, deleted: ${stats.deleted}.`,
  );
}

async function syncBlockPair(
  notion: Client,
  parentPageId: string,
  existing: PartialBlockObjectResponse,
  incoming: NotionBlock,
  logContext: LogContext = defaultLogContext,
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
        await syncPageBlocks(notion, existingId, incomingChildren, logContext);
        return { action: "updated" };
      }
      return { action: "unchanged" };
    }

    if (canUpdateBlockType(incoming.type)) {
      const updated = await updateBlockContent(notion, existingId, incoming, logContext);
      if (updated) {
        if (hasChildrenToSync) {
          await syncPageBlocks(notion, existingId, incomingChildren, logContext);
        }
        return { action: "updated" };
      }
    }
  }

  const newBlockId = await appendSingleBlockAfter(
    notion,
    parentPageId,
    existingId,
    incoming,
    logContext,
  );
  await deleteBlockSafe(notion, existingId, logContext);
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
  logContext: LogContext = defaultLogContext,
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
    logContext.warn(`Block update failed for ${blockId}: ${message}. Replacing block.`);
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
  logContext: LogContext = defaultLogContext,
): Promise<string> {
  logContext.info(`Starting single block creation after ${anchorBlockId}.`);
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

async function deleteBlocks(
  notion: Client,
  blocks: PartialBlockObjectResponse[],
  logContext: LogContext = defaultLogContext,
): Promise<number> {
  if (blocks.length === 0) {
    return 0;
  }

  logContext.info(`Starting batch delete for ${blocks.length} blocks...`);
  const concurrencyLimit = 3;
  const chunks = chunkArray(blocks, concurrencyLimit);
  let deletedCount = 0;

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (block) => {
        const blockId = getBlockId(block);
        if (!blockId) {
          logContext.warn("Skipping delete for block with missing id.");
          return;
        }
        await deleteBlockSafe(notion, blockId, logContext);
      }),
    );
    deletedCount += chunk.length;
    if (deletedCount % 50 === 0 || deletedCount === blocks.length) {
      logContext.info(`Deleted ${deletedCount}/${blocks.length} trailing blocks...`);
    }
  }

  return deletedCount;
}

async function deleteBlockSafe(
  notion: Client,
  blockId: string,
  logContext: LogContext = defaultLogContext,
): Promise<void> {
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
    logContext.warn(`Failed to delete block ${blockId}: ${message}`);
  }
}

async function appendBlocksSafe(
  notion: Client,
  blockId: string,
  blocks: NotionBlock[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  logContext.info(`Starting block creation for ${blockId} (${blocks.length} blocks).`);
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
      logContext.warn(`Chunk append failed: ${message}. Retrying block-by-block.`);
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
          logContext.warn(`Failed to append block (${block.type}): ${blockMessage}`);
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
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  logContext.info(`Starting block creation after ${anchorBlockId} (${blocks.length} blocks).`);
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
      logContext.warn(`Chunk append failed: ${message}. Retrying block-by-block.`);
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
          logContext.warn(`Block append failed: ${innerMessage}`);
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
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Starting index link sync for anchor ${anchorBlockId}...`);
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
    logContext.info(`Replacing ${existingLinkBlocks.length} index link blocks.`);
    await deleteBlocks(notion, existingLinkBlocks, logContext);
  }

  if (blocks.length === 0) {
    logContext.info("Index anchor cleared. No pages to link.");
    return;
  }

  await appendBlocksAfter(notion, parentPageId, anchorBlockId, blocks, logContext);
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

function extractImageUrl(record: Record<string, unknown>): string | null {
  const imageType = typeof record.type === "string" ? record.type : null;
  if (imageType === "external") {
    const external = record.external as { url?: unknown } | undefined;
    return typeof external?.url === "string" ? external.url : null;
  }
  if (imageType === "file") {
    const file = record.file as { url?: unknown } | undefined;
    return typeof file?.url === "string" ? file.url : null;
  }
  if (imageType === "file_upload") {
    const fileUpload = record.file_upload as { id?: unknown } | undefined;
    return typeof fileUpload?.id === "string" ? fileUpload.id : null;
  }
  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toNotionBlockRequests(blocks: NotionBlock[]): AppendChildren {
  return blocks as AppendChildren;
}

run();
