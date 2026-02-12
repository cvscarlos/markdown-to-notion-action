import MarkdownIt from "markdown-it";
import { markdownToBlocks } from "@tryfabric/martian";
import type { NotionBlock, NotionRichText } from "./notion-types";

export type Logger = (message: string) => void;

export type MarkdownToNotionOptions = {
  resolveLink?: (href: string) => string | null;
  logger?: Logger;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
});

const TABLE_OF_CONTENTS_LABELS = new Set([
  "table of contents",
  "table of content",
  "table of contentes",
  "toc",
]);

export function extractTitle(markdown: string): string | null {
  const tokens = md.parse(markdown, {});
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
  return applyTableOfContents(sanitized);
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
  }

  return block;
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
