import type { Client } from "@notionhq/client";

import { syncPageBlocks } from "./block-sync.js";
import { getLastCommitTime } from "./git-utils.js";
import { defaultLogContext } from "./logging.js";
import {
  isNotionArchivedError,
  isNotionNotFoundError,
  normalizeNotionId,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";

type SyncDecision = {
  archivedOrMissing: boolean;
  skipSync: boolean;
};

type CreatePageRequest = Parameters<Client["pages"]["create"]>[0];
type PageProperties = CreatePageRequest["properties"];

const NOTION_SYNC_BUFFER_MS = 60_000;

export async function resolveParentPageId(notion: Client, blockId: string): Promise<string> {
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

export async function createPage(
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

export async function archivePageIfPresent(
  notion: Client,
  pageId: string,
  logContext: LogContext = defaultLogContext,
): Promise<"already-gone" | "archived"> {
  try {
    /**
     * Notion API: Move a page to trash
     * https://developers.notion.com/reference/patch-page.md
     */
    await notionRequest(
      () =>
        notion.pages.update({
          in_trash: true,
          page_id: toDashedId(pageId),
        }),
      `pages.update trash ${pageId}`,
    );
    logContext.info(`Archived stale page: ${pageId}`);
    return "archived";
  } catch (error) {
    if (isNotionArchivedError(error) || isNotionNotFoundError(error)) {
      logContext.info(`Stale page already missing or archived: ${pageId}`);
      return "already-gone";
    }
    throw error;
  }
}

export async function updatePageContent(
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

export async function getSyncDecision(
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
      return { archivedOrMissing: true, skipSync: false };
    }
    throw error;
  }

  if (("archived" in page && page.archived) || ("in_trash" in page && page.in_trash)) {
    return { archivedOrMissing: true, skipSync: false };
  }
  if (!lastCommitTime) {
    return { archivedOrMissing: false, skipSync: false };
  }

  const lastEdited = "last_edited_time" in page ? page.last_edited_time : null;
  if (!lastEdited) {
    return { archivedOrMissing: false, skipSync: false };
  }

  const notionTime = new Date(lastEdited);
  if (Number.isNaN(notionTime.getTime())) {
    return { archivedOrMissing: false, skipSync: false };
  }

  return {
    archivedOrMissing: false,
    skipSync: lastCommitTime.getTime() <= notionTime.getTime() + NOTION_SYNC_BUFFER_MS,
  };
}

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
