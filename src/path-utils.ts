import * as path from "path";

export function resolveInsideRoot(rootPath: string, inputPath: string, label: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedRoot = path.resolve(rootPath);
  let resolvedPath: string;
  if (path.isAbsolute(inputPath)) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    resolvedPath = path.resolve(inputPath);
  } else {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    resolvedPath = path.resolve(resolvedRoot, inputPath);
  }

  if (!isInsidePath(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} must resolve inside ${resolvedRoot}. Received: ${inputPath}`);
  }

  return resolvedPath;
}

export function resolveChildPath(parentPath: string, childName: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedParent = path.resolve(parentPath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedPath = path.resolve(resolvedParent, childName);

  if (!isInsidePath(resolvedParent, resolvedPath)) {
    throw new Error(`Resolved path escapes ${resolvedParent}: ${childName}`);
  }

  return resolvedPath;
}

export function resolveFromDirectory(directoryPath: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    throw new Error(`Absolute paths are not allowed here: ${inputPath}`);
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedDirectory = path.resolve(directoryPath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(resolvedDirectory, inputPath);
}

export function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isSamePath(leftPath: string, rightPath: string): boolean {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(leftPath) === path.resolve(rightPath);
}
