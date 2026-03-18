export type MarkdownDocument = {
  absPath: string;
  relPath: string;
  body: string;
  attributes: Record<string, unknown>;
  title: string;
  notionPageId?: string;
  notionUrl?: string;
};

export type MappingEntry = {
  pageId: string;
  title?: string;
};

export type SyncedPage = {
  pageId: string;
  title: string;
};
