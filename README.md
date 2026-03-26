# Markdown to Notion GitHub Action

Sync a folder of Markdown files to Notion pages and optionally maintain an index list block inside an existing Notion page.

This action:

- Creates or updates one Notion page per Markdown file.
- Stores `notion_page_id` mappings and `source_hash` values in a separate markdown table file (default: `_notion_links.md`).
- Archives stale Notion pages when their mapped Markdown file no longer exists, then removes the stale mapping row.
- Adds optional shortcut links after an anchor block (optional).
- Validates links to avoid Notion "Invalid URL" errors.

## Quick Start (Beginner)

1. **Create a Notion Integration**

- Go to Notion settings → Connections → Develop or manage integrations.
- Create a new integration and copy the **Internal Integration Token**.

2. **Share the target Notion page** with the integration

- Open the page in Notion.
- Click **Share** and invite the integration.

3. **Decide where pages will be created**

- **Default:** Provide `page_id`. Pages are created under this parent and will appear at the end of the page (Notion API limitation).
- **Optional:** Provide `page_block_id` to insert **shortcut links** after a specific block. Pages are still created under the parent page; only the shortcut list is inserted after the block.

4. **Add a GitHub workflow**

Example using `page_id`:

```yaml
name: Sync Docs to Notion

on:
  push:
    branches:
      - "main"
    paths:
      - "docs/**"

permissions:
  contents: write
  # Required when commit_strategy=pr
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Sync markdown to Notion
        uses: ./.github/actions/markdown-to-notion
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          notion_token: ${{ secrets.NOTION_TOKEN }}
          page_id: ${{ secrets.NOTION_PAGE_ID }}
          # Optional: folder containing markdown files (default: docs)
          docs_folder: docs
          # Optional: separator used between folder names and title (default: →)
          title_prefix_separator: "→"
          # Optional: pr (default), push, or none
          commit_strategy: pr
          # Optional: prefix for the PR branch (default: auto-notion-sync/)
          pr_branch_prefix: "auto-notion-sync/"
```

Example using `page_block_id` only:

```yaml
name: Sync Docs to Notion

on:
  push:
    branches:
      - "main"
    paths:
      - "docs/**"

permissions:
  contents: write
  # Required when commit_strategy=pr
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Sync markdown to Notion
        uses: ./.github/actions/markdown-to-notion
        with:
          notion_token: ${{ secrets.NOTION_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          page_block_id: ${{ secrets.NOTION_PAGE_BLOCK_ID }}
          # Optional: folder containing markdown files (default: docs)
          docs_folder: docs
          # Optional: separator used between folder names and title (default: →)
          title_prefix_separator: "→"
          # Optional: pr (default), push, or none
          commit_strategy: pr
          # Optional: prefix for the PR branch (default: auto-notion-sync/)
          pr_branch_prefix: "auto-notion-sync/"
```

## Inputs

| Input                    | Required | Description                                                                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `notion_token`           | Yes      | Notion Integration Secret.                                                                                        |
| `docs_folder`            | No       | Folder containing Markdown files (relative to the repository root). Default: `docs`.                              |
| `notion_mapping_file`    | No       | Markdown file that stores page mappings. Default: `<docs_folder>/_notion_links.md`.                               |
| `page_block_id`          | No       | Anchor block ID/URL. The action appends shortcut (`link_to_page`) blocks after this block.                        |
| `page_id`                | No       | Parent page ID/URL for new pages. Pages are created at the end of the parent page (Notion API limitation).        |
| `title_prefix_separator` | No       | Separator used between folder names and the title. Default: `→`.                                                  |
| `commit_strategy`        | No       | How to persist `notion_page_id` updates: `pr` (default), `push`, or `none`.                                       |
| `pr_branch_prefix`       | No       | Prefix for the PR branch when `commit_strategy=pr`. Default: `auto-notion-sync/`.                                 |
| `github_token`           | No       | Required when `commit_strategy` is `push` or `pr`. Used to push commits or open PRs for `notion_page_id` updates. |

**Requirement:** You must provide either `page_block_id` **or** `page_id`.

## How It Works

### 1) Identification

Each `.md` file is parsed for frontmatter:

- If `notion_page_id` exists (in the mapping file or frontmatter) → the page is updated.
- If missing → a new Notion page is created and the mapping file is updated.

**Mapping file:** Instead of writing `notion_page_id` into each Markdown file, the action stores mappings in a separate markdown table (default: `_notion_links.md`). This avoids modifying your docs content and lets repeated runs skip unchanged files by comparing the stored `source_hash` locally before calling GitHub or Notion.

If a path exists in `_notion_links.md` but the Markdown file no longer exists in `docs_folder`, the action treats that row as stale. It removes the row from `_notion_links.md` and archives the mapped Notion page. If the page was already deleted or archived manually in Notion, the action just removes the stale row and continues.

Example mapping file (the `title` column links to the Notion page URL):

```markdown
| path                         | notion_page_id                       | source_hash                                                      | title                                                                                 |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| getting-started.md           | 7754cf02-251f-4bc9-ab2f-9cc897765336 | 8f0f3d3c1c2c0531c8dc37d975d6e7c1f6f1b0ed3e3618b2af896cb8da4f8a7f | [Getting Started](https://www.notion.so/7754cf02251f4bc9ab2f9cc897765336)             |
| integrations/example-tags.md | 30c5e554-8603-8072-a733-d3bad8109a32 | 6e8a960b8a4e2ce4adac9b6f55b0b7159d4a6a7f7bfa815f6c0a3186fdcb1d06 | [integrations → Example Tags](https://www.notion.so/30c5e55486038072a733d3bad8109a32) |
```

### 2) Title Selection

The page title is chosen in this order:

1. First Markdown H1 heading
2. File name (without extension)

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

**Folder titles:**

- `docs/platform/overview.md` becomes a page titled `platform → Overview` (separator configurable).

**Safety rules:**

- Text is split into chunks ≤ 2000 characters.
- Links are validated. Invalid or relative links are dropped (text is preserved).

### 4) Index Block (Optional)

If `page_block_id` is provided, the action replaces the contiguous `link_to_page` shortcut blocks **after** that block. The anchor block itself is not modified, and full pages are still created at the end of the parent page.

### 5) Git Write-Back

If new pages are created (or page mappings change), the action persists the updated mapping file back to the repo based on `commit_strategy`:

- Commit message: `chore: store notion page ids`
- `push`: commits and pushes directly to the current branch.
- `pr`: commits to a new branch and opens a PR.
- `none`: skips any git updates.
- `_notion_links.md` is formatted with Prettier before the git update step.
- Uses the provided `github_token` for push/PR operations.

## Version Tags

This repository uses Git tags for versions. GitHub does not always show tag labels on the commits list, so use the Tags page to find the latest version:

- GitHub → **Releases → Tags** or **Code → Tags**
- The manual release workflow attempts to move the floating `v1` tag to the latest `v1.x.x` release.
- If that step fails or GitHub keeps the wrong ref cached, run `./.github/update-v1-tag.sh` locally as a fallback.

## Notion ID Tips

You can pass a block/page ID **or** a Notion URL. The action extracts the ID automatically.

Example formats:

- `b3c7a87c7eaa4ec4a23e1e6c20a12345`
- `b3c7a87c-7eaa-4ec4-a23e-1e6c20a12345`
- `https://www.notion.so/7754cf02251f4bc9ab2f9cc897765336` (URL that contains the ID)

To get a block ID:

- In Notion, click **Copy Link to Block**.

### Useful Scripts

- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run typecheck`
- `./.github/update-v1-tag.sh`

## Troubleshooting

### "Invalid URL for link"

This action validates links and drops invalid/relative URLs instead of crashing. If you want relative links to resolve to Notion pages, make sure those files have already been synced so their `notion_page_id` exists in the mapping file.

### "Either page_block_id or page_id must be provided"

Set one of the two inputs. `page_block_id` is only needed if you want links inserted after a specific block.

### "Missing permissions" on push

Ensure your workflow has:

```yaml
permissions:
  contents: write
```

If you use `commit_strategy: pr`, also add:

```yaml
permissions:
  pull-requests: write
```

### "Not found" errors from Notion

Make sure the integration has access to the target page/block (Share → invite the integration).

### "Nothing syncs even though I expected changes"

The action skips syncing a page if Notion's `last_edited_time` is newer than the file's last commit time.

In GitHub Actions it checks the latest commit for that file via the GitHub commits API first, so a full clone is not required.

If the GitHub API lookup is unavailable, it falls back to local `git log`, which may require enough local history to reach the file's last change.

## Behavior Notes

- The index link list after `page_block_id` is replaced each run (contiguous `link_to_page` blocks only).
- Pages are skipped when Notion is newer than the last Git commit time.
- If a mapped Markdown path is renamed or deleted, the old mapping row is removed. Its Notion page is archived unless that same page ID is still referenced by another active Markdown file.
- If a block append fails, the action logs a warning and continues.
- HTML in Markdown is not preserved.

## License

MIT
