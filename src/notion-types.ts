export const NOTION_COLORS = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "default_background",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
] as const;

export type NotionColor = (typeof NOTION_COLORS)[number];

export const NOTION_CODE_LANGUAGES = [
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
] as const;

export type NotionCodeLanguage = (typeof NOTION_CODE_LANGUAGES)[number];

export type NotionRichText = {
  type: "text";
  text: {
    content: string;
    link?: { url: string } | null;
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: NotionColor;
  };
  plain_text?: string;
  href?: string | null;
};

export type ParagraphBlock = {
  type: "paragraph";
  paragraph: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type HeadingBlock = {
  type: "heading_1" | "heading_2" | "heading_3";
  heading_1?: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    is_toggleable?: boolean;
    children?: NotionBlock[];
  };
  heading_2?: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    is_toggleable?: boolean;
    children?: NotionBlock[];
  };
  heading_3?: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    is_toggleable?: boolean;
    children?: NotionBlock[];
  };
};

export type BulletedListItemBlock = {
  type: "bulleted_list_item";
  bulleted_list_item: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type NumberedListItemBlock = {
  type: "numbered_list_item";
  numbered_list_item: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type QuoteBlock = {
  type: "quote";
  quote: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type CalloutBlock = {
  type: "callout";
  callout: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    icon?:
      | { type: "emoji"; emoji: string }
      | { type: "external"; external: { url: string } }
      | {
          type: "file";
          file: { url: string; expiry_time?: string };
        };
    children?: NotionBlock[];
  };
};

export type ToggleBlock = {
  type: "toggle";
  toggle: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type ToDoBlock = {
  type: "to_do";
  to_do: {
    rich_text: NotionRichText[];
    checked?: boolean;
    color?: NotionColor;
    children?: NotionBlock[];
  };
};

export type DividerBlock = {
  type: "divider";
  divider: Record<string, never>;
};

export type CodeBlock = {
  type: "code";
  code: {
    rich_text: NotionRichText[];
    language: NotionCodeLanguage;
    caption?: NotionRichText[];
  };
};

export type TableRowBlock = {
  type: "table_row";
  table_row: {
    cells: NotionRichText[][];
  };
};

export type TableBlock = {
  type: "table";
  table: {
    table_width: number;
    has_column_header: boolean;
    has_row_header: boolean;
    children: TableRowBlock[];
  };
};

export type TableOfContentsBlock = {
  type: "table_of_contents";
  table_of_contents: {
    color?: NotionColor;
  };
};

export type NotionBlock =
  | ParagraphBlock
  | HeadingBlock
  | BulletedListItemBlock
  | NumberedListItemBlock
  | QuoteBlock
  | CalloutBlock
  | ToggleBlock
  | ToDoBlock
  | DividerBlock
  | CodeBlock
  | TableBlock
  | TableRowBlock
  | TableOfContentsBlock;
