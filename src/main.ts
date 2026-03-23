import * as core from "@actions/core";
import * as github from "@actions/github";
import { Client } from "@notionhq/client";
import * as path from "path";

import {
  normalizeCommitStrategy,
  normalizePrBranchPrefix,
  normalizeTitlePrefixSeparator,
  readInput,
} from "./action-inputs.js";
import type { CommitStrategy } from "./action-inputs.js";
import { appendBlocksSafe, appendPageLinksAfterAnchor } from "./block-sync.js";
import {
  buildBlocksForDocument,
  buildNotionPageTitle,
  collectMarkdownFiles,
  ensureDirectoryExists,
  loadMarkdownDocuments,
} from "./documents.js";
import { commitAndPush, commitAndPushToBranch, getCurrentBranch } from "./git-utils.js";
import { createLogContext, describeError } from "./logging.js";
import {
  formatMappingFile,
  normalizeMappingKey,
  readMappingFile,
  resolveMappingFilePath,
  writeMappingFile,
} from "./mapping-file.js";
import {
  isNotionArchivedError,
  isNotionNotFoundError,
  normalizeNotionId,
  notionPageUrl,
} from "./notion-api.js";
import {
  createPage,
  getSyncDecision,
  resolveParentPageId,
  updatePageContent,
} from "./page-sync.js";
import type { SyncedPage } from "./sync-types.js";

async function run(): Promise<void> {
  try {
    const actionRef = process.env.ACTION_SOURCE_REF || process.env.GITHUB_ACTION_REF || "unknown";
    const actionRepo =
      process.env.ACTION_SOURCE_REPOSITORY || process.env.GITHUB_ACTION_REPOSITORY || "unknown";
    core.info(`Action source: ${actionRepo}@${actionRef}`);

    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const mappingFileInput = readInput("notion_mapping_file", ["NOTION_MAPPING_FILE"]);
    const pageBlockInput = readInput("page_block_id", ["PAGE_BLOCK_ID"]);
    const pageInput = readInput("page_id", ["PAGE_ID"]);
    const titlePrefixSeparatorInput = readInput("title_prefix_separator", [
      "TITLE_PREFIX_SEPARATOR",
    ]);
    const commitStrategyInput = readInput("commit_strategy", ["COMMIT_STRATEGY"]);
    const prBranchPrefixInput = readInput("pr_branch_prefix", ["PR_BRANCH_PREFIX"]);
    const githubToken = readInput("github_token", ["GITHUB_TOKEN"]);
    const commitStrategy = normalizeCommitStrategy(commitStrategyInput);

    if (!notionToken || !docsFolder) {
      throw new Error("Missing required inputs. Check notion_token and docs_folder.");
    }
    if (commitStrategy !== "none" && !githubToken) {
      throw new Error("github_token is required when commit_strategy is 'push' or 'pr'.");
    }

    core.setSecret(notionToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }

    const notion = new Client({ auth: notionToken });
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const docsFolderPath = path.resolve(workspaceRoot, docsFolder);
    await ensureDirectoryExists(docsFolderPath);
    const mappingFilePath = resolveMappingFilePath(docsFolderPath, workspaceRoot, mappingFileInput);

    const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
    const pageBlockParentId = pageBlockId ? await resolveParentPageId(notion, pageBlockId) : null;
    const pagesParentId = pageInput ? normalizeNotionId(pageInput) : pageBlockParentId;
    if (!pagesParentId) {
      throw new Error("Either page_block_id or page_id must be provided.");
    }

    const titlePrefixSeparator = normalizeTitlePrefixSeparator(titlePrefixSeparatorInput);
    const prBranchPrefix = normalizePrBranchPrefix(prBranchPrefixInput);

    const markdownFiles = await collectMarkdownFiles(docsFolderPath, mappingFilePath);
    if (!markdownFiles.length) {
      core.warning(`No markdown files found in ${docsFolderPath}.`);
    }

    const mappingEntries = await readMappingFile(mappingFilePath);
    const documents = await loadMarkdownDocuments(markdownFiles, docsFolderPath, mappingEntries);

    const knownPageUrls = new Map<string, string>();
    for (const documentEntry of documents) {
      if (documentEntry.notionPageId) {
        knownPageUrls.set(documentEntry.absPath, notionPageUrl(documentEntry.notionPageId));
      }
    }

    const changedFiles: string[] = [];
    const syncedPages: SyncedPage[] = [];
    let mappingDirty = false;

    for (const documentEntry of documents) {
      try {
        const documentLog = createLogContext(documentEntry.relPath);
        documentLog.info(`Sync start: ${documentEntry.title}`);
        const mappingKey = normalizeMappingKey(documentEntry.relPath);
        const pageTitle = buildNotionPageTitle(documentEntry, titlePrefixSeparator);
        let pageId = documentEntry.notionPageId;
        let pageUrl = documentEntry.notionUrl;
        let pageWasWritten = false;
        const existingMapping = mappingEntries.get(mappingKey);

        if (pageId) {
          if (existingMapping?.sourceHash === documentEntry.sourceHash) {
            documentLog.info("Skipping sync: source hash unchanged.");
            pageUrl = pageUrl ?? notionPageUrl(pageId);
          } else {
            const decision = await getSyncDecision(
              notion,
              pageId,
              documentEntry.absPath,
              githubToken,
              workspaceRoot,
              documentLog,
            );

            if (decision.archivedOrMissing) {
              documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
              pageId = undefined;
            } else if (decision.skipSync) {
              documentLog.info("Skipping sync: Notion is up to date.");
              pageUrl = pageUrl ?? notionPageUrl(pageId);
            } else {
              const blocks = await buildBlocksForDocument(
                notion,
                documentEntry,
                docsFolderPath,
                workspaceRoot,
                knownPageUrls,
                githubToken,
                documentLog,
              );

              try {
                await updatePageContent(notion, pageId, pageTitle, blocks, documentLog);
                pageUrl = notionPageUrl(pageId);
                pageWasWritten = true;
                documentLog.info(`Updated page: ${pageTitle}`);
              } catch (error) {
                if (!isNotionArchivedError(error) && !isNotionNotFoundError(error)) {
                  throw error;
                }
                documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
                pageId = undefined;
              }
            }
          }
        }

        if (!pageId) {
          const blocks = await buildBlocksForDocument(
            notion,
            documentEntry,
            docsFolderPath,
            workspaceRoot,
            knownPageUrls,
            githubToken,
            documentLog,
          );
          const created = await createPage(notion, pagesParentId, pageTitle);
          pageId = normalizeNotionId(created.id);
          pageUrl = created.url || notionPageUrl(pageId);
          documentLog.info(`Created page: ${pageTitle}`);
          if (pageUrl) {
            documentLog.info(`Page URL: ${pageUrl}`);
          }
          await appendBlocksSafe(notion, pageId, blocks, documentLog);
          pageWasWritten = true;
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(documentEntry.absPath, pageUrl);
          const normalizedPageId = normalizeNotionId(pageId);

          if (
            !existingMapping ||
            normalizeNotionId(existingMapping.pageId) !== normalizedPageId ||
            existingMapping.sourceHash !== documentEntry.sourceHash
          ) {
            mappingEntries.set(mappingKey, {
              pageId: normalizedPageId,
              sourceHash: documentEntry.sourceHash,
              title: pageWasWritten ? pageTitle : (existingMapping?.title ?? pageTitle),
            });
            mappingDirty = true;
          } else if (pageWasWritten && existingMapping.title !== pageTitle) {
            mappingEntries.set(mappingKey, {
              pageId: normalizedPageId,
              sourceHash: documentEntry.sourceHash,
              title: pageTitle,
            });
            mappingDirty = true;
          }

          syncedPages.push({ pageId, title: pageTitle });
        }
      } catch (error) {
        core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
      }
    }

    if (pageBlockId && pageBlockParentId && syncedPages.length > 0) {
      await appendPageLinksAfterAnchor(
        notion,
        pageBlockParentId,
        pageBlockId,
        syncedPages,
        createLogContext("index"),
      );
    }

    if (mappingDirty) {
      await writeMappingFile(mappingFilePath, mappingEntries);
      if (commitStrategy !== "none") {
        await formatMappingFile(mappingFilePath, workspaceRoot);
      }
      changedFiles.push(path.relative(workspaceRoot, mappingFilePath));
    }

    if (changedFiles.length > 0) {
      await persistNotionIds(
        changedFiles,
        githubToken,
        commitStrategy,
        workspaceRoot,
        prBranchPrefix,
      );
    }
  } catch (error) {
    core.setFailed(describeError(error));
  }
}

async function persistNotionIds(
  changedFiles: string[],
  githubToken: string,
  commitStrategy: CommitStrategy,
  workspaceRoot: string,
  prBranchPrefix: string,
): Promise<void> {
  const commitMessage = "chore: store notion page ids";

  if (commitStrategy === "none") {
    core.info("Skipping git update: commit_strategy='none'.");
    return;
  }

  if (commitStrategy === "push") {
    await commitAndPush(
      changedFiles,
      commitMessage,
      githubToken,
      (message) => core.info(message),
      workspaceRoot,
    );
    return;
  }

  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    throw new Error("GITHUB_REPOSITORY is required for commit_strategy='pr'.");
  }

  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${ownerRepo}`);
  }

  const baseBranch = process.env.GITHUB_REF_NAME || (await getCurrentBranch(workspaceRoot));
  const branchName = `${prBranchPrefix}${baseBranch}`;
  const pushed = await commitAndPushToBranch(
    changedFiles,
    commitMessage,
    githubToken,
    branchName,
    (message) => core.info(message),
    workspaceRoot,
    true,
  );
  if (!pushed) {
    core.info("No git changes to commit. Skipping PR update.");
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branchName}`,
    state: "open",
  });
  if (existing.data.length > 0) {
    core.info(`PR already exists: ${existing.data[0].html_url}`);
    return;
  }

  const pullRequest = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base: baseBranch,
    title: "docs: store notion page ids [auto generated]",
    body: "Automated update of notion_page_id frontmatter for synced docs.",
  });
  core.info(`Opened PR: ${pullRequest.data.html_url}`);
}

run();
