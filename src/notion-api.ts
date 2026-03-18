import { Client } from "@notionhq/client";

export type AppendChildrenRequest = Parameters<Client["blocks"]["children"]["append"]>[0];
export type AppendChildren = AppendChildrenRequest["children"];
export type BlocksChildrenListResponse = Awaited<ReturnType<Client["blocks"]["children"]["list"]>>;
export type PartialBlockObjectResponse = BlocksChildrenListResponse["results"][number];
export type BlockUpdateRequest = Parameters<Client["blocks"]["update"]>[0];
export type CalloutUpdateRequest = Extract<BlockUpdateRequest, { callout: unknown }>;
export type CalloutIconRequest = CalloutUpdateRequest["callout"] extends { icon?: infer T }
  ? T
  : never;

export function isNotionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorDetails = error as { code?: string; status?: number; message?: string };
  if (errorDetails.code === "object_not_found") {
    return true;
  }
  if (errorDetails.status === 404) {
    return true;
  }
  if (
    typeof errorDetails.message === "string" &&
    errorDetails.message.toLowerCase().includes("not found")
  ) {
    return true;
  }
  return false;
}

export function isNotionArchivedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorDetails = error as { code?: string; message?: string };
  if (errorDetails.code !== "validation_error") {
    return false;
  }
  if (typeof errorDetails.message !== "string") {
    return false;
  }
  return errorDetails.message.toLowerCase().includes("archived");
}

export function normalizeNotionId(input: string): string {
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

export function toDashedId(id: string): string {
  const cleaned = normalizeNotionId(id);
  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
}

export function notionPageUrl(id: string): string {
  const cleaned = normalizeNotionId(id);
  return `https://www.notion.so/${cleaned}`;
}

export function normalizeNotionIdValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    return normalizeNotionId(value);
  } catch {
    return undefined;
  }
}

export async function listAllChildren(
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

export async function notionRequest<T>(operation: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 6;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Notion] ${label} rate limited (attempt ${attempt}/${maxAttempts}): ${reason}. Retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorDetails = error as { code?: string; status?: number; headers?: unknown };
  return errorDetails.code === "rate_limited" || errorDetails.status === 429;
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  if (error && typeof error === "object") {
    const errorDetails = error as { headers?: unknown };
    const retryAfterHeader =
      typeof errorDetails.headers === "object" && errorDetails.headers !== null
        ? (errorDetails.headers as { [key: string]: unknown })["retry-after"]
        : undefined;
    const retryAfterValue = Number(retryAfterHeader);
    if (Number.isFinite(retryAfterValue) && retryAfterValue > 0) {
      return retryAfterValue * 1000;
    }
  }

  const baseDelayMs = 500;
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
