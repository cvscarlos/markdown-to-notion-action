# Markdown to Notion GitHub Action

Sync a folder of Markdown files to Notion pages and optionally maintain an index list block inside an existing Notion page.

This action:

- Creates or updates one Notion page per Markdown file.
- Writes back the `notion_page_id` into each file’s frontmatter (so future runs update instead of creating duplicates).
- Updates a specific index block with links to all synced pages (optional).
- Validates links to avoid Notion "Invalid URL" errors.

## Quick Start (Beginner)

1. **Create a Notion Integration**

- Go to Notion settings → Connections → Develop or manage integrations.
- Create a new integration and copy the **Internal Integration Token**.

2. **Share the target Notion page** with the integration

- Open the page in Notion.
- Click **Share** and invite the integration.

3. **Decide where pages will be created**

- **Option A (with index block):** Use a block on the index page and provide `index_block_id`.
- **Option B (without index block):** Provide `parent_page_id` only.

4. **Add a GitHub workflow**

Example using `index_block_id`:

```yaml
name: Sync Docs to Notion

on:
  push:
    branches: ["main"]
    paths:
      - "docs/**"

permissions:
  contents: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Sync markdown to Notion
        uses: ./.github/actions/markdown-to-notion
        with:
          notion_token: ${{ secrets.NOTION_TOKEN }}
          docs_folder: docs
          index_block_id: ${{ secrets.NOTION_INDEX_BLOCK_ID }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Example using `parent_page_id` only:

```yaml
name: Sync Docs to Notion

on:
  push:
    branches: ["main"]
    paths:
      - "docs/**"

permissions:
  contents: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Sync markdown to Notion
        uses: ./.github/actions/markdown-to-notion
        with:
          notion_token: ${{ secrets.NOTION_TOKEN }}
          docs_folder: docs
          parent_page_id: ${{ secrets.NOTION_PARENT_PAGE_ID }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input            | Required | Description                                                                                               |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `notion_token`   | Yes      | Notion Integration Secret.                                                                                |
| `docs_folder`    | Yes      | Folder containing Markdown files (relative to the repository root).                                       |
| `index_block_id` | No       | Block ID/URL for the index list container. If provided, the index block is cleared and rebuilt every run. |
| `parent_page_id` | No       | Parent page ID/URL for new pages (used when `index_block_id` is not provided).                            |
| `github_token`   | Yes      | GitHub token used to commit `notion_page_id` back to files.                                               |

**Requirement:** You must provide either `index_block_id` **or** `parent_page_id`.

## How It Works

### 1) Identification

Each `.md` file is parsed for frontmatter:

- If `notion_page_id` exists → the page is updated.
- If missing → a new Notion page is created and the ID is written back to the file.

### 2) Title Selection

The page title is chosen in this order:

1. Frontmatter `title`
2. First Markdown H1 heading
3. File name (without extension)

### 3) Markdown to Notion Blocks

Supported conversions include:

- Headings (H1/H2/H3)
- Paragraphs
- Bulleted and numbered lists (with nesting)
- Code fences
- Blockquotes (paragraphs inside)
- Horizontal rules
- Tables
- `Table of Contents` / `[TOC]` placeholders → Notion `table_of_contents` block

**Safety rules:**

- Text is split into chunks ≤ 2000 characters.
- Links are validated. Invalid or relative links are dropped (text is preserved).

### 4) Index Block Update (Optional)

If `index_block_id` is provided, the action:

- Clears the current children of that block.
- Appends a fresh bulleted list of links to all synced documents.

### 5) Git Write-Back

If new pages are created, the action commits updated Markdown files back to the repo:

- Commit message: `chore: store notion page ids`
- Uses the provided `github_token` for the push.

## Frontmatter Example

```yaml
---
title: Getting Started
notion_page_id: 01234567-89ab-cdef-0123-456789abcdef
---
# Getting Started

Welcome to the docs.
```

## Notion ID Tips

You can pass a block/page ID **or** a Notion URL. The action extracts the ID automatically.

Example formats:

- `b3c7a87c7eaa4ec4a23e1e6c20a12345`
- `b3c7a87c-7eaa-4ec4-a23e-1e6c20a12345`
- `https://www.notion.so/...` (URL that contains the ID)

To get a block ID:

- In Notion, click **Copy Link to Block**.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```env
NOTION_TOKEN=secret_xxx
DOCS_FOLDER=docs
INDEX_BLOCK_ID=your_block_or_url
PARENT_PAGE_ID=your_page_or_url
GITHUB_TOKEN=ghp_xxx
```

3. Run:

```bash
npm start
```

### Useful Scripts

- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run typecheck`

## Troubleshooting

### "Invalid URL for link"

This action validates links and drops invalid/relative URLs instead of crashing. If you want relative links to resolve to Notion pages, make sure those files have already been synced so their `notion_page_id` exists.

### "Either index_block_id or parent_page_id must be provided"

Set one of the two inputs. `index_block_id` is only needed if you want the index updated.

### "Missing permissions" on push

Ensure your workflow has:

```yaml
permissions:
  contents: write
```

### "Not found" errors from Notion

Make sure the integration has access to the target page/block (Share → invite the integration).

## Behavior Notes

- The index list is rebuilt on each run (block children are deleted and re-created).
- If a block fails to append, the action logs a warning and continues.
- HTML in Markdown is not preserved.

## License

MIT
