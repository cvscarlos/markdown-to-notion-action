import { Client } from "@notionhq/client";
import * as path from "path";
import { runStepWithLogging } from "./logging.js";
import { notionRequest } from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";

type GitHubContentsRequest = {
  path: string;
  url: string;
};

type GitHubFile = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  path: string;
  size: number;
};

const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function uploadImageBlocks(
  notion: Client,
  blocks: NotionBlock[],
  githubToken: string | null,
  logContext: LogContext,
): Promise<void> {
  for (const block of blocks) {
    await uploadImageBlock(notion, block, githubToken, logContext);
    const children = getBlockChildren(block);
    if (children.length) {
      await uploadImageBlocks(notion, children, githubToken, logContext);
    }
  }
}

function getBlockChildren(block: NotionBlock): NotionBlock[] {
  const content = (block as Record<string, unknown>)[block.type];
  if (!content || typeof content !== "object") {
    return [];
  }

  const children = (content as { children?: unknown }).children;
  return Array.isArray(children) ? (children as NotionBlock[]) : [];
}

async function uploadImageBlock(
  notion: Client,
  block: NotionBlock,
  githubToken: string | null,
  logContext: LogContext,
): Promise<void> {
  if (block.type !== "image") {
    return;
  }

  const image = block.image;
  if (image.type !== "external" || !image.external?.url) {
    return;
  }

  const githubContentsRequest = getGitHubContentsRequestFromRawUrl(image.external.url);
  if (!githubContentsRequest) {
    logContext.info(`Skipping image ${image.external.url}: not a supported GitHub raw URL.`);
    return;
  }

  const expectedImageContentType = getUploadableImageContentType(githubContentsRequest.path);
  if (!expectedImageContentType) {
    logContext.info(
      `Skipping image ${githubContentsRequest.path}: only PNG, JPG, JPEG, GIF, SVG, and WEBP are uploaded.`,
    );
    return;
  }

  const imageFile = await runStepWithLogging(
    logContext,
    `Starting GitHub image fetch for ${githubContentsRequest.path}.`,
    `Finished GitHub image fetch for ${githubContentsRequest.path}.`,
    () => fetchGitHubFile(githubContentsRequest, githubToken, expectedImageContentType, logContext),
  );
  if (!imageFile) {
    logContext.info(
      `Skipping image ${githubContentsRequest.path}: GitHub fetch returned no uploadable file.`,
    );
    return;
  }

  logContext.info(`Starting Notion image upload for ${imageFile.path} (${imageFile.size} bytes).`);
  /**
   * Notion API: Create a file upload
   * https://developers.notion.com/reference/create-a-file-upload.md
   */
  const fileUpload = await runStepWithLogging(
    logContext,
    `Starting Notion file upload creation for ${imageFile.filename}.`,
    `Finished Notion file upload creation for ${imageFile.filename}.`,
    () =>
      notionRequest(
        () =>
          notion.fileUploads.create({
            mode: "single_part",
            filename: imageFile.filename,
            content_type: imageFile.contentType,
          }),
        `fileUploads.create ${imageFile.filename}`,
      ),
  );

  const uploadId = fileUpload.id;
  const blob = new Blob([new Uint8Array(imageFile.buffer)], { type: imageFile.contentType });

  /**
   * Notion API: Send a file upload
   * https://developers.notion.com/reference/send-a-file-upload.md
   */
  await runStepWithLogging(
    logContext,
    `Starting Notion file upload send for ${imageFile.filename}.`,
    `Finished Notion file upload send for ${imageFile.filename}.`,
    () =>
      notionRequest(
        () =>
          notion.fileUploads.send({
            file_upload_id: uploadId,
            file: {
              data: blob,
              filename: imageFile.filename,
            },
          }),
        `fileUploads.send ${uploadId}`,
      ),
  );

  const caption = image.caption;
  block.image = {
    type: "file_upload",
    file_upload: { id: uploadId },
    ...(caption ? { caption } : {}),
  };
  logContext.info(`Image block now references Notion upload ${uploadId} for ${imageFile.path}.`);
}

function getGitHubContentsRequestFromRawUrl(rawUrl: string): GitHubContentsRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  let filePath: string | null = null;
  let ownerRepo: string | null = null;
  let ref: string | null = null;

  if (parsed.hostname === "raw.githubusercontent.com") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 4) {
      return null;
    }
    ownerRepo = `${segments[0]}/${segments[1]}`;
    ref = segments[2];
    filePath = segments.slice(3).join("/");
  } else {
    const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
    if (parsed.origin !== serverUrl) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 5 || segments[0] !== "raw") {
      return null;
    }
    ownerRepo = `${segments[1]}/${segments[2]}`;
    ref = segments[3];
    filePath = segments.slice(4).join("/");
  }

  if (!ownerRepo || !ref || !filePath) {
    return null;
  }

  const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const encodedRef = encodeURIComponent(ref);
  return {
    path: filePath,
    url: `${apiBase}/repos/${ownerRepo}/contents/${encodedPath}?ref=${encodedRef}`,
  };
}

async function fetchGitHubFile(
  request: GitHubContentsRequest,
  githubToken: string | null,
  expectedContentType: string,
  logContext: LogContext,
): Promise<GitHubFile | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  const response = await fetch(request.url, { headers });
  if (!response.ok) {
    logContext.warn(`Skipping image ${request.path}: GitHub fetch failed (${response.status}).`);
    return null;
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_UPLOAD_BYTES) {
      logContext.warn(`Skipping image ${request.path}: file size ${contentLength} exceeds 20MB.`);
      return null;
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    logContext.warn(`Skipping image ${request.path}: file size ${buffer.length} exceeds 20MB.`);
    return null;
  }

  const headerContentType = response.headers.get("content-type") || "";
  const contentType = headerContentType.startsWith("image/")
    ? headerContentType
    : expectedContentType;
  if (!contentType) {
    logContext.warn(`Skipping image ${request.path}: unsupported content type.`);
    return null;
  }

  return {
    buffer,
    contentType,
    filename: path.basename(request.path),
    path: request.path,
    size: buffer.length,
  };
}

function getUploadableImageContentType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}
