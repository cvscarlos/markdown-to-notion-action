type NotionColor =
  | "blue"
  | "blue_background"
  | "brown"
  | "brown_background"
  | "default"
  | "default_background"
  | "gray"
  | "gray_background"
  | "green"
  | "green_background"
  | "orange"
  | "orange_background"
  | "pink"
  | "pink_background"
  | "purple"
  | "purple_background"
  | "red"
  | "red_background"
  | "yellow"
  | "yellow_background";

type NotionCodeLanguage =
  | "abap"
  | "arduino"
  | "bash"
  | "basic"
  | "c"
  | "c#"
  | "c++"
  | "clojure"
  | "coffeescript"
  | "css"
  | "dart"
  | "diff"
  | "docker"
  | "elixir"
  | "elm"
  | "erlang"
  | "f#"
  | "flow"
  | "fortran"
  | "gherkin"
  | "glsl"
  | "go"
  | "graphql"
  | "groovy"
  | "haskell"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "julia"
  | "kotlin"
  | "latex"
  | "less"
  | "lisp"
  | "livescript"
  | "lua"
  | "makefile"
  | "markdown"
  | "markup"
  | "matlab"
  | "mermaid"
  | "nix"
  | "objective-c"
  | "ocaml"
  | "pascal"
  | "perl"
  | "php"
  | "plain text"
  | "powershell"
  | "prolog"
  | "protobuf"
  | "python"
  | "r"
  | "reason"
  | "ruby"
  | "rust"
  | "sass"
  | "scala"
  | "scheme"
  | "scss"
  | "shell"
  | "solidity"
  | "sql"
  | "swift"
  | "toml"
  | "typescript"
  | "vb.net"
  | "verilog"
  | "vhdl"
  | "visual basic"
  | "webassembly"
  | "xml"
  | "yaml";

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

type NotionBlockBase = {
  object?: "block";
};

type ParagraphBlock = {
  type: "paragraph";
  paragraph: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type HeadingBlock = {
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
} & NotionBlockBase;

type BulletedListItemBlock = {
  type: "bulleted_list_item";
  bulleted_list_item: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type NumberedListItemBlock = {
  type: "numbered_list_item";
  numbered_list_item: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type QuoteBlock = {
  type: "quote";
  quote: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type CalloutBlock = {
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
} & NotionBlockBase;

type ToggleBlock = {
  type: "toggle";
  toggle: {
    rich_text: NotionRichText[];
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type ToDoBlock = {
  type: "to_do";
  to_do: {
    rich_text: NotionRichText[];
    checked?: boolean;
    color?: NotionColor;
    children?: NotionBlock[];
  };
} & NotionBlockBase;

type DividerBlock = {
  type: "divider";
  divider: Record<string, never>;
} & NotionBlockBase;

type CodeBlock = {
  type: "code";
  code: {
    rich_text: NotionRichText[];
    language: NotionCodeLanguage;
    caption?: NotionRichText[];
  };
} & NotionBlockBase;

type EquationBlock = {
  type: "equation";
  equation: {
    expression: string;
  };
} & NotionBlockBase;

type ImageBlock = {
  type: "image";
  image: {
    type: "external" | "file" | "file_upload";
    external?: { url: string };
    file?: { url: string; expiry_time?: string };
    file_upload?: { id: string };
    caption?: NotionRichText[];
  };
} & NotionBlockBase;

type TableRowBlock = {
  type: "table_row";
  table_row: {
    cells: NotionRichText[][];
  };
} & NotionBlockBase;

type TableBlock = {
  type: "table";
  table: {
    table_width: number;
    has_column_header: boolean;
    has_row_header: boolean;
    children: TableRowBlock[];
  };
} & NotionBlockBase;

type TableOfContentsBlock = {
  type: "table_of_contents";
  table_of_contents: {
    color?: NotionColor;
  };
} & NotionBlockBase;

type LinkToPageBlock = {
  type: "link_to_page";
  link_to_page: {
    type: "page_id" | "database_id";
    page_id?: string;
    database_id?: string;
  };
} & NotionBlockBase;

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
  | EquationBlock
  | ImageBlock
  | TableBlock
  | TableRowBlock
  | TableOfContentsBlock
  | LinkToPageBlock;
