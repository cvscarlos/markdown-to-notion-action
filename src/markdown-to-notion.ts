import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token";
import type {
  BlockObjectRequest,
  RichTextItemRequest,
} from "@notionhq/client/build/src/api-endpoints";

export type Logger = (message: string) => void;

export type MarkdownToNotionOptions = {
  resolveLink?: (href: string) => string | null;
  logger?: Logger;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
});

const MAX_TEXT_LENGTH = 2000;

const ALLOWED_CODE_LANGUAGES = new Set([
  "abap",
  "arduino",
  "bash",
  "basic",
  "c",
  "clojure",
  "coffeescript",
  "c++",
  "c#",
  "css",
  "dart",
  "diff",
  "docker",
  "elixir",
  "elm",
  "erlang",
  "flow",
  "fortran",
  "f#",
  "gherkin",
  "glsl",
  "go",
  "graphql",
  "groovy",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "julia",
  "kotlin",
  "latex",
  "less",
  "lisp",
  "livescript",
  "lua",
  "makefile",
  "markdown",
  "markup",
  "matlab",
  "mermaid",
  "nix",
  "objective-c",
  "ocaml",
  "pascal",
  "perl",
  "php",
  "plain text",
  "powershell",
  "prolog",
  "protobuf",
  "python",
  "r",
  "reason",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scheme",
  "scss",
  "shell",
  "solidity",
  "sql",
  "swift",
  "toml",
  "typescript",
  "vb.net",
  "verilog",
  "vhdl",
  "visual basic",
  "webassembly",
  "xml",
  "yaml",
]);

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

type ParseState = {
  index: number;
  skipNextList?: boolean;
};

export function markdownToNotionBlocks(
  markdown: string,
  options: MarkdownToNotionOptions = {},
): BlockObjectRequest[] {
  const tokens = md.parse(markdown, {});
  const state: ParseState = { index: 0 };
  return parseTokens(tokens, state, options);
}

function parseTokens(
  tokens: Token[],
  state: ParseState,
  options: MarkdownToNotionOptions,
  stopOnTypes: string[] = [],
): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (stopOnTypes.includes(token.type)) {
      break;
    }

    if (
      state.skipNextList &&
      token.type !== "bullet_list_open" &&
      token.type !== "ordered_list_open"
    ) {
      state.skipNextList = false;
    }

    switch (token.type) {
      case "heading_open": {
        const level = parseHeadingLevel(token.tag);
        const inline = tokens[state.index + 1];
        const richText =
          inline && inline.type === "inline" ? inlineToRichText(inline, options) : [];
        blocks.push(...createHeadingBlocks(level, richText));
        state.index += 3;
        if (inline && inline.type === "inline" && isTableOfContentsLabel(inline.content)) {
          blocks.push(createTableOfContentsBlock());
          state.skipNextList = true;
        }
        break;
      }
      case "paragraph_open": {
        const inline = tokens[state.index + 1];
        if (inline && inline.type === "inline" && isTableOfContentsLabel(inline.content)) {
          blocks.push(createTableOfContentsBlock());
          state.index += 3;
          state.skipNextList = true;
          break;
        }
        const richText =
          inline && inline.type === "inline" ? inlineToRichText(inline, options) : [];
        blocks.push(...createParagraphBlocks(richText));
        state.index += 3;
        break;
      }
      case "bullet_list_open": {
        state.index += 1;
        if (state.skipNextList) {
          parseList(tokens, state, "bulleted", options);
          state.skipNextList = false;
          break;
        }
        blocks.push(...parseList(tokens, state, "bulleted", options));
        break;
      }
      case "ordered_list_open": {
        state.index += 1;
        if (state.skipNextList) {
          parseList(tokens, state, "numbered", options);
          state.skipNextList = false;
          break;
        }
        blocks.push(...parseList(tokens, state, "numbered", options));
        break;
      }
      case "table_open": {
        state.index += 1;
        blocks.push(...parseTable(tokens, state, options));
        break;
      }
      case "fence": {
        const language = normalizeCodeLanguage(token.info || "");
        const content = token.content || "";
        blocks.push(...createCodeBlocks(content, language));
        state.index += 1;
        break;
      }
      case "blockquote_open": {
        state.index += 1;
        const quoteBlocks = parseTokens(tokens, state, options, ["blockquote_close"]);
        state.index += 1;
        blocks.push(...quoteBlocks.map((block) => wrapQuote(block)));
        break;
      }
      case "hr": {
        blocks.push({ type: "divider", divider: {} });
        state.index += 1;
        break;
      }
      case "inline": {
        const richText = inlineToRichText(token, options);
        blocks.push(...createParagraphBlocks(richText));
        state.index += 1;
        break;
      }
      default: {
        if (token.type.endsWith("_open")) {
          options.logger?.(`Skipping unsupported markdown token: ${token.type}`);
        }
        state.index += 1;
        break;
      }
    }
  }

  return blocks;
}

function parseList(
  tokens: Token[],
  state: ParseState,
  listType: "bulleted" | "numbered",
  options: MarkdownToNotionOptions,
): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];
  const closeType = listType === "bulleted" ? "bullet_list_close" : "ordered_list_close";

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token.type === closeType) {
      state.index += 1;
      break;
    }
    if (token.type === "list_item_open") {
      state.index += 1;
      const { richText, children } = parseListItem(tokens, state, options);
      const block: BlockObjectRequest =
        listType === "bulleted"
          ? {
              type: "bulleted_list_item",
              bulleted_list_item: {
                rich_text: richText,
                color: "default",
                children: children.length > 0 ? children : undefined,
              },
            }
          : {
              type: "numbered_list_item",
              numbered_list_item: {
                rich_text: richText,
                color: "default",
                children: children.length > 0 ? children : undefined,
              },
            };
      blocks.push(block);
      continue;
    }

    state.index += 1;
  }

  return blocks;
}

function parseTable(
  tokens: Token[],
  state: ParseState,
  options: MarkdownToNotionOptions,
): BlockObjectRequest[] {
  const rows: RichTextItemRequest[][][] = [];
  let inHead = false;
  let hasColumnHeader = false;

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token.type === "table_close") {
      state.index += 1;
      break;
    }

    switch (token.type) {
      case "thead_open":
        inHead = true;
        state.index += 1;
        break;
      case "thead_close":
        inHead = false;
        state.index += 1;
        break;
      case "tbody_open":
      case "tbody_close":
        state.index += 1;
        break;
      case "tr_open": {
        state.index += 1;
        const row = parseTableRow(tokens, state, options);
        if (row.length > 0) {
          rows.push(row);
          if (inHead) {
            hasColumnHeader = true;
          }
        }
        break;
      }
      default:
        state.index += 1;
        break;
    }
  }

  if (rows.length === 0) {
    return [];
  }

  const tableWidth = Math.max(...rows.map((row) => row.length));
  if (tableWidth === 0) {
    return [];
  }

  const normalizedRows = rows.map((row) => {
    const padded = [...row];
    while (padded.length < tableWidth) {
      padded.push([]);
    }
    return padded;
  });

  const tableRows: BlockObjectRequest[] = normalizedRows.map((row) => ({
    type: "table_row",
    table_row: {
      cells: row.map((cell) => normalizeRichTextForCell(cell)),
    },
  }));

  return [
    {
      type: "table",
      table: {
        table_width: tableWidth,
        has_column_header: hasColumnHeader,
        has_row_header: false,
        children: tableRows,
      },
    },
  ];
}

function parseTableRow(
  tokens: Token[],
  state: ParseState,
  options: MarkdownToNotionOptions,
): RichTextItemRequest[][] {
  const cells: RichTextItemRequest[][] = [];

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token.type === "tr_close") {
      state.index += 1;
      break;
    }

    if (token.type === "th_open" || token.type === "td_open") {
      state.index += 1;
      const cell = parseTableCell(tokens, state, options, token.type === "th_open");
      cells.push(cell);
      continue;
    }

    state.index += 1;
  }

  return cells;
}

function parseTableCell(
  tokens: Token[],
  state: ParseState,
  options: MarkdownToNotionOptions,
  isHeader: boolean,
): RichTextItemRequest[] {
  const richText: RichTextItemRequest[] = [];
  const closeType = isHeader ? "th_close" : "td_close";

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token.type === closeType) {
      state.index += 1;
      break;
    }

    if (token.type === "inline") {
      richText.push(...inlineToRichText(token, options));
      state.index += 1;
      continue;
    }

    if (token.type === "paragraph_open") {
      const inline = tokens[state.index + 1];
      if (inline && inline.type === "inline") {
        richText.push(...inlineToRichText(inline, options));
      }
      state.index += 3;
      continue;
    }

    state.index += 1;
  }

  return normalizeRichTextForCell(richText);
}

function parseListItem(
  tokens: Token[],
  state: ParseState,
  options: MarkdownToNotionOptions,
): { richText: RichTextItemRequest[]; children: BlockObjectRequest[] } {
  let richText: RichTextItemRequest[] = [];
  const children: BlockObjectRequest[] = [];

  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token.type === "list_item_close") {
      state.index += 1;
      break;
    }

    switch (token.type) {
      case "paragraph_open": {
        const inline = tokens[state.index + 1];
        const inlineRichText =
          inline && inline.type === "inline" ? inlineToRichText(inline, options) : [];
        if (richText.length === 0) {
          richText = inlineRichText;
        } else {
          children.push(...createParagraphBlocks(inlineRichText));
        }
        state.index += 3;
        break;
      }
      case "bullet_list_open": {
        state.index += 1;
        children.push(...parseList(tokens, state, "bulleted", options));
        break;
      }
      case "ordered_list_open": {
        state.index += 1;
        children.push(...parseList(tokens, state, "numbered", options));
        break;
      }
      case "table_open": {
        state.index += 1;
        children.push(...parseTable(tokens, state, options));
        break;
      }
      case "fence": {
        const language = normalizeCodeLanguage(token.info || "");
        const content = token.content || "";
        children.push(...createCodeBlocks(content, language));
        state.index += 1;
        break;
      }
      default: {
        state.index += 1;
        break;
      }
    }
  }

  return {
    richText,
    children,
  };
}

function inlineToRichText(inline: Token, options: MarkdownToNotionOptions): RichTextItemRequest[] {
  if (!inline.children || inline.children.length === 0) {
    const content = inline.content || "";
    return content.length > 0 ? [createText(content)] : [];
  }

  const richText: RichTextItemRequest[] = [];
  const annotations = {
    bold: false,
    italic: false,
    code: false,
    strikethrough: false,
    underline: false,
    color: "default",
  } as const;
  const current = { ...annotations };
  let currentLink: string | null = null;

  const pushText = (text: string, override?: Partial<typeof current>) => {
    if (text.length === 0) {
      return;
    }
    richText.push({
      type: "text",
      text: {
        content: text,
        link: currentLink ? { url: currentLink } : null,
      },
      annotations: {
        bold: override?.bold ?? current.bold,
        italic: override?.italic ?? current.italic,
        code: override?.code ?? current.code,
        strikethrough: override?.strikethrough ?? current.strikethrough,
        underline: override?.underline ?? current.underline,
        color: current.color,
      },
    });
  };

  for (const child of inline.children) {
    switch (child.type) {
      case "text":
        pushText(child.content || "");
        break;
      case "softbreak":
      case "hardbreak":
        pushText("\n");
        break;
      case "code_inline":
        pushText(child.content || "", { code: true });
        break;
      case "strong_open":
        current.bold = true;
        break;
      case "strong_close":
        current.bold = false;
        break;
      case "em_open":
        current.italic = true;
        break;
      case "em_close":
        current.italic = false;
        break;
      case "s_open":
      case "del_open":
        current.strikethrough = true;
        break;
      case "s_close":
      case "del_close":
        current.strikethrough = false;
        break;
      case "link_open": {
        const href = child.attrGet("href");
        currentLink = href ? normalizeLink(href, options) : null;
        break;
      }
      case "link_close":
        currentLink = null;
        break;
      case "image": {
        const alt = child.content || child.attrGet("alt") || "";
        if (alt.length > 0) {
          pushText(alt);
        }
        break;
      }
      default:
        break;
    }
  }

  return richText;
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

function createText(content: string): RichTextItemRequest {
  return {
    type: "text",
    text: {
      content,
      link: null,
    },
  };
}

function createParagraphBlocks(richText: RichTextItemRequest[]): BlockObjectRequest[] {
  return splitRichTextByLength(richText).map((chunk) => ({
    type: "paragraph",
    paragraph: {
      rich_text: chunk,
      color: "default",
    },
  }));
}

function createHeadingBlocks(
  level: 1 | 2 | 3,
  richText: RichTextItemRequest[],
): BlockObjectRequest[] {
  const chunks = splitRichTextByLength(richText);
  return chunks.map((chunk) => {
    const headingType = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
    return {
      type: headingType,
      [headingType]: {
        rich_text: chunk,
        color: "default",
      },
    } as BlockObjectRequest;
  });
}

function createCodeBlocks(content: string, language: string): BlockObjectRequest[] {
  const chunks = splitTextByLength(content);
  return chunks.map((chunk) => ({
    type: "code",
    code: {
      rich_text: [createText(chunk)],
      language,
    },
  }));
}

function wrapQuote(block: BlockObjectRequest): BlockObjectRequest {
  if (block.type === "paragraph") {
    return {
      type: "quote",
      quote: {
        rich_text: block.paragraph.rich_text,
        color: "default",
      },
    };
  }

  return block;
}

function parseHeadingLevel(tag: string): 1 | 2 | 3 {
  if (tag === "h1") {
    return 1;
  }
  if (tag === "h2") {
    return 2;
  }
  return 3;
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

function createTableOfContentsBlock(): BlockObjectRequest {
  return {
    type: "table_of_contents",
    table_of_contents: {
      color: "default",
    },
  };
}

function normalizeCodeLanguage(info: string): string {
  const raw = info.trim().toLowerCase();
  if (raw.length === 0) {
    return "plain text";
  }
  if (raw === "text" || raw === "plaintext") {
    return "plain text";
  }
  if (raw === "js") {
    return "javascript";
  }
  if (raw === "ts") {
    return "typescript";
  }
  if (raw === "sh" || raw === "shell" || raw === "zsh") {
    return "bash";
  }
  if (ALLOWED_CODE_LANGUAGES.has(raw)) {
    return raw;
  }
  return "plain text";
}

function splitRichTextByLength(richText: RichTextItemRequest[]): RichTextItemRequest[][] {
  const chunks: RichTextItemRequest[][] = [];
  let currentChunk: RichTextItemRequest[] = [];
  let currentLength = 0;

  for (const item of richText) {
    if (item.type !== "text") {
      continue;
    }

    const text = item.text.content || "";
    if (text.length === 0) {
      continue;
    }

    let remaining = text;
    while (remaining.length > 0) {
      const available = MAX_TEXT_LENGTH - currentLength;
      if (available === 0) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        currentChunk = [];
        currentLength = 0;
        continue;
      }

      const slice = remaining.slice(0, available);
      currentChunk.push({
        ...item,
        text: {
          ...item.text,
          content: slice,
        },
      });
      currentLength += slice.length;
      remaining = remaining.slice(slice.length);

      if (currentLength >= MAX_TEXT_LENGTH) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLength = 0;
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length === 0) {
    return [[]];
  }

  return chunks;
}

function normalizeRichTextForCell(
  richText: RichTextItemRequest[],
): RichTextItemRequest[] {
  const normalized: RichTextItemRequest[] = [];

  for (const item of richText) {
    if (item.type !== "text") {
      normalized.push(item);
      continue;
    }

    const content = item.text.content || "";
    if (content.length === 0) {
      normalized.push(item);
      continue;
    }

    let remaining = content;
    while (remaining.length > 0) {
      const slice = remaining.slice(0, MAX_TEXT_LENGTH);
      normalized.push({
        ...item,
        text: {
          ...item.text,
          content: slice,
        },
      });
      remaining = remaining.slice(slice.length);
    }
  }

  return normalized;
}

function splitTextByLength(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_TEXT_LENGTH));
    remaining = remaining.slice(MAX_TEXT_LENGTH);
  }
  return chunks;
}
