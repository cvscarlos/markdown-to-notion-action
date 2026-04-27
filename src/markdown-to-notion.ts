import MarkdownIt from "markdown-it";
import { markdownToBlocks } from "@tryfabric/martian";
import type { NotionBlock, NotionRichText } from "./notion-types.js";

type Logger = (message: string) => void;

type MarkdownToNotionOptions = {
  resolveLink?: (href: string) => string | null;
  logger?: Logger;
};

type StandaloneMarkdownImage = {
  altText: string;
  source: string;
};

type ImageReplacementState = {
  nextImageIndex: number;
};

const markdownParser = new MarkdownIt({
  html: false,
  linkify: true,
});

type MarkdownToken = ReturnType<typeof markdownParser.parse>[number];

const TABLE_OF_CONTENTS_LABELS = new Set([
  "table of contents",
  "table of content",
  "table of contentes",
  "toc",
]);

export function extractTitle(markdown: string): string | null {
  const tokens = markdownParser.parse(markdown, {});
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "heading_open" && token.tag === "h1") {
      const inline = tokens[i + 1];
      if (inline && inline.type === "inline") {
        const title = inline.content.trim();
        if (title.length > 0) {
          return title;
        }
      }
    }
  }
  return null;
}

export function markdownToNotionBlocks(
  markdown: string,
  options: MarkdownToNotionOptions = {},
): NotionBlock[] {
  const rawBlocks = markdownToBlocks(markdown) as unknown as NotionBlock[];
  const sanitized = sanitizeBlocks(rawBlocks, options);
  const blocksWithImages = restoreStandaloneImageBlocks(markdown, sanitized, options);
  return applyTableOfContents(blocksWithImages);
}

function sanitizeBlocks(blocks: NotionBlock[], options: MarkdownToNotionOptions): NotionBlock[] {
  const sanitized: NotionBlock[] = [];
  for (const block of blocks) {
    const normalized = sanitizeBlock(block, options);
    if (normalized) {
      sanitized.push(normalized);
    }
  }
  return sanitized;
}

function sanitizeBlock(block: NotionBlock, options: MarkdownToNotionOptions): NotionBlock | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const type = (block as { type?: string }).type;
  if (!type || typeof type !== "string") {
    return null;
  }

  const content = (block as Record<string, unknown>)[type];
  if (content && typeof content === "object") {
    const contentRecord = content as Record<string, unknown>;
    if (Array.isArray(contentRecord.rich_text)) {
      contentRecord.rich_text = sanitizeRichText(
        contentRecord.rich_text as NotionRichText[],
        options,
      );
    }
    if (Array.isArray(contentRecord.caption)) {
      contentRecord.caption = sanitizeRichText(contentRecord.caption as NotionRichText[], options);
    }
    if (type === "table_row" && Array.isArray(contentRecord.cells)) {
      contentRecord.cells = (contentRecord.cells as NotionRichText[][]).map((cell) =>
        sanitizeRichText(cell, options),
      );
    }
    if (Array.isArray(contentRecord.children)) {
      contentRecord.children = sanitizeBlocks(contentRecord.children as NotionBlock[], options);
    }
    if (type === "image") {
      normalizeImageBlock(contentRecord, options);
    }
  }

  return block;
}

function normalizeImageBlock(
  contentRecord: Record<string, unknown>,
  options: MarkdownToNotionOptions,
): void {
  if (contentRecord.type !== "external") {
    return;
  }
  const external = contentRecord.external;
  if (!isUrlRecord(external)) {
    return;
  }
  const url = external.url.trim();
  if (!isRelativeLink(url)) {
    return;
  }
  if (!options.resolveLink) {
    return;
  }
  const resolved = options.resolveLink(url);
  if (!resolved) {
    return;
  }
  external.url = resolved;
}

function isUrlRecord(value: unknown): value is { url: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.url === "string";
}

function sanitizeRichText(
  richText: NotionRichText[],
  options: MarkdownToNotionOptions,
): NotionRichText[] {
  return richText.map((item) => {
    if (item.type !== "text") {
      return item;
    }

    const link = item.text.link;
    if (link?.url) {
      const normalized = normalizeLink(link.url, options);
      if (!normalized) {
        return {
          ...item,
          text: {
            ...item.text,
            link: null,
          },
        };
      }
      if (normalized !== link.url) {
        return {
          ...item,
          text: {
            ...item.text,
            link: { url: normalized },
          },
        };
      }
    }

    return item;
  });
}

function normalizeLink(href: string, options: MarkdownToNotionOptions): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isRelativeLink(trimmed)) {
    return options.resolveLink ? options.resolveLink(trimmed) : null;
  }

  try {
    const url = new URL(trimmed);
    if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function isRelativeLink(href: string): boolean {
  if (href.startsWith("#")) {
    return true;
  }
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

function restoreStandaloneImageBlocks(
  markdown: string,
  blocks: NotionBlock[],
  options: MarkdownToNotionOptions,
): NotionBlock[] {
  const markdownImages = extractStandaloneMarkdownImages(markdown);
  if (!markdownImages.length) {
    return blocks;
  }
  const replacementState: ImageReplacementState = { nextImageIndex: 0 };
  return replaceStandaloneImageParagraphs(blocks, markdownImages, options, replacementState);
}

function extractStandaloneMarkdownImages(markdown: string): StandaloneMarkdownImage[] {
  const tokens = markdownParser.parse(markdown, {});
  const markdownImages: StandaloneMarkdownImage[] = [];

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const openingToken = tokens[index];
    const inlineToken = tokens[index + 1];
    const closingToken = tokens[index + 2];
    if (
      openingToken.type !== "paragraph_open" ||
      inlineToken?.type !== "inline" ||
      closingToken?.type !== "paragraph_close"
    ) {
      continue;
    }

    const imageToken = getStandaloneImageToken(inlineToken.children ?? []);
    if (!imageToken) {
      continue;
    }

    const source = imageToken.attrGet("src");
    if (!source) {
      continue;
    }

    markdownImages.push({
      altText: imageToken.content.trim(),
      source,
    });
  }

  return markdownImages;
}

function getStandaloneImageToken(children: MarkdownToken[]): MarkdownToken | null {
  if (children.length !== 1) {
    return null;
  }
  const [child] = children;
  if (child.type !== "image") {
    return null;
  }
  return child;
}

function replaceStandaloneImageParagraphs(
  blocks: NotionBlock[],
  markdownImages: StandaloneMarkdownImage[],
  options: MarkdownToNotionOptions,
  replacementState: ImageReplacementState,
): NotionBlock[] {
  const replacedBlocks: NotionBlock[] = [];

  for (const block of blocks) {
    const nextImage = markdownImages[replacementState.nextImageIndex];
    const replacement = replaceStandaloneImageParagraph(block, nextImage, options);
    const blockWithChildren = replaceBlockChildren(
      replacement.block,
      markdownImages,
      options,
      replacementState,
    );
    replacedBlocks.push(blockWithChildren);
    if (replacement.replaced) {
      replacementState.nextImageIndex += 1;
    }
  }

  return replacedBlocks;
}

function replaceStandaloneImageParagraph(
  block: NotionBlock,
  markdownImage: StandaloneMarkdownImage | undefined,
  options: MarkdownToNotionOptions,
): { block: NotionBlock; replaced: boolean } {
  if (!markdownImage || block.type !== "paragraph") {
    return { block, replaced: false };
  }

  const paragraphText = getSingleParagraphText(block);
  if (!paragraphText || paragraphText !== markdownImage.source) {
    return { block, replaced: false };
  }

  const resolvedUrl = resolveImageUrl(markdownImage.source, options);
  if (!resolvedUrl) {
    return { block, replaced: false };
  }

  return {
    block: createImageBlock(resolvedUrl, markdownImage.altText),
    replaced: true,
  };
}

function getSingleParagraphText(block: NotionBlock): string | null {
  if (block.type !== "paragraph") {
    return null;
  }
  const richText = block.paragraph?.rich_text;
  if (!richText || richText.length !== 1) {
    return null;
  }
  const [textItem] = richText;
  if (textItem.type !== "text") {
    return null;
  }
  return textItem.text.content.trim();
}

function resolveImageUrl(source: string, options: MarkdownToNotionOptions): string | null {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    return null;
  }

  if (isRelativeLink(trimmedSource)) {
    return options.resolveLink ? options.resolveLink(trimmedSource) : null;
  }

  try {
    const imageUrl = new URL(trimmedSource);
    if (imageUrl.protocol === "http:" || imageUrl.protocol === "https:") {
      return imageUrl.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function createImageBlock(url: string, altText: string): NotionBlock {
  const caption = altText ? createImageCaption(altText) : undefined;
  return {
    type: "image",
    image: {
      type: "external",
      external: { url },
      ...(caption ? { caption } : {}),
    },
  };
}

function createImageCaption(altText: string): NotionRichText[] {
  return [
    {
      type: "text",
      text: {
        content: altText,
      },
    },
  ];
}

function replaceBlockChildren(
  block: NotionBlock,
  markdownImages: StandaloneMarkdownImage[],
  options: MarkdownToNotionOptions,
  replacementState: ImageReplacementState,
): NotionBlock {
  const content = (block as Record<string, unknown>)[block.type];
  if (!content || typeof content !== "object") {
    return block;
  }

  const contentRecord = content as Record<string, unknown>;
  if (!Array.isArray(contentRecord.children)) {
    return block;
  }

  contentRecord.children = replaceStandaloneImageParagraphs(
    contentRecord.children as NotionBlock[],
    markdownImages,
    options,
    replacementState,
  );
  return block;
}

function applyTableOfContents(blocks: NotionBlock[]): NotionBlock[] {
  const result: NotionBlock[] = [];
  let skipNextList = false;

  for (const block of blocks) {
    if (
      skipNextList &&
      block.type !== "bulleted_list_item" &&
      block.type !== "numbered_list_item"
    ) {
      skipNextList = false;
    }

    const label = extractBlockText(block);
    if (label && isTableOfContentsLabel(label)) {
      result.push(createTableOfContentsBlock());
      skipNextList = true;
      continue;
    }

    if (skipNextList) {
      if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
        continue;
      }
      skipNextList = false;
    }

    result.push(block);
  }

  return result;
}

function extractBlockText(block: NotionBlock): string {
  if (block.type === "paragraph" && block.paragraph?.rich_text) {
    return concatRichText(block.paragraph.rich_text);
  }
  if (block.type === "heading_1" && block.heading_1?.rich_text) {
    return concatRichText(block.heading_1.rich_text);
  }
  if (block.type === "heading_2" && block.heading_2?.rich_text) {
    return concatRichText(block.heading_2.rich_text);
  }
  if (block.type === "heading_3" && block.heading_3?.rich_text) {
    return concatRichText(block.heading_3.rich_text);
  }
  return "";
}

function concatRichText(richText: NotionRichText[]): string {
  return richText.map((item) => item.text?.content ?? "").join("");
}

function isTableOfContentsLabel(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return TABLE_OF_CONTENTS_LABELS.has(normalized);
}

function createTableOfContentsBlock(): NotionBlock {
  return {
    type: "table_of_contents",
    table_of_contents: {
      color: "default",
    },
  };
}
