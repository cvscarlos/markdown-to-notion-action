export type MarkdownDocument = {
  absPath: string;
  attributes: Record<string, unknown>;
  body: string;
  relPath: string;
  sourceHash: string;
  title: string;
  notionPageId?: string;
  notionUrl?: string;
};

export type MappingEntry = {
  pageId: string;
  sourceHash?: string;
  title?: string;
};

export type SyncedPage = {
  pageId: string;
  title: string;
};
