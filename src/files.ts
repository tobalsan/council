import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

export interface FileContent {
  path: string;
  content: string;
}

export interface FileSection {
  displayPath: string;
  sectionText: string;
  content: string;
}

export class FileInputError extends Error {}

interface PartitionedFileInputs {
  includeGlobs: string[];
  excludeGlobs: string[];
  literalFiles: string[];
  literalDirectories: string[];
}

export async function readFiles(
  fileInputs: string[],
  {
    cwd = process.cwd(),
    maxFileSizeBytes = MAX_FILE_SIZE_BYTES,
  }: {
    cwd?: string;
    maxFileSizeBytes?: number;
  } = {},
): Promise<FileContent[]> {
  if (!fileInputs || fileInputs.length === 0) {
    return [];
  }

  const partitioned = await partitionFileInputs(fileInputs, cwd);
  const matches = await expandWithGlob(partitioned, cwd);

  if (matches.length === 0) {
    throw new FileInputError("No files matched the provided --file patterns.");
  }

  const oversized: string[] = [];
  const accepted: string[] = [];

  for (const matchedPath of matches) {
    const stats = await fs.stat(matchedPath);
    if (!stats.isFile()) {
      continue;
    }

    if (stats.size > maxFileSizeBytes) {
      const rel = path.relative(cwd, matchedPath) || matchedPath;
      oversized.push(`${rel} (${formatBytes(stats.size)})`);
      continue;
    }

    accepted.push(matchedPath);
  }

  if (oversized.length > 0) {
    throw new FileInputError(
      `The following files exceed the 1 MB limit:\n- ${oversized.join("\n- ")}`,
    );
  }

  if (accepted.length === 0) {
    throw new FileInputError("No readable files remained after validation.");
  }

  const files: FileContent[] = [];
  for (const filePath of accepted) {
    const content = await fs.readFile(filePath, "utf8");
    files.push({ path: filePath, content });
  }

  return files;
}

export function createFileSections(files: FileContent[], cwd = process.cwd()): FileSection[] {
  return files.map((file) => {
    const displayPath = toPosix(path.relative(cwd, file.path) || file.path);
    return {
      displayPath,
      content: file.content,
      sectionText: ["### File: " + displayPath, "```", file.content.trimEnd(), "```"].join("\n"),
    };
  });
}

export function buildPromptWithFiles(basePrompt: string, files: FileContent[], cwd = process.cwd()): string {
  if (!files.length) {
    return basePrompt;
  }

  const sections = createFileSections(files, cwd);
  const sectionText = sections.map((section) => section.sectionText).join("\n\n");
  return `${basePrompt.trim()}\n\n${sectionText}`;
}

async function partitionFileInputs(rawInputs: string[], cwd: string): Promise<PartitionedFileInputs> {
  const partitioned: PartitionedFileInputs = {
    includeGlobs: [],
    excludeGlobs: [],
    literalFiles: [],
    literalDirectories: [],
  };

  for (const value of rawInputs) {
    const raw = value.trim();
    if (!raw) {
      continue;
    }

    if (raw.startsWith("!")) {
      const excludeRaw = raw.slice(1).trim();
      if (!excludeRaw) {
        continue;
      }
      partitioned.excludeGlobs.push(normalizeGlob(excludeRaw, cwd));
      continue;
    }

    if (fg.isDynamicPattern(raw)) {
      partitioned.includeGlobs.push(normalizeGlob(raw, cwd));
      continue;
    }

    const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(absolutePath);
    } catch {
      throw new FileInputError(`Missing file or directory: ${raw}`);
    }

    if (stats.isDirectory()) {
      partitioned.literalDirectories.push(absolutePath);
      continue;
    }

    if (stats.isFile()) {
      partitioned.literalFiles.push(absolutePath);
      continue;
    }

    throw new FileInputError(`Not a file or directory: ${raw}`);
  }

  return partitioned;
}

async function expandWithGlob(partitioned: PartitionedFileInputs, cwd: string): Promise<string[]> {
  const includes = [
    ...partitioned.includeGlobs,
    ...partitioned.literalFiles.map((filePath) => toPosixRelative(filePath, cwd)),
    ...partitioned.literalDirectories.map((dirPath) => `${toPosixRelative(dirPath, cwd).replace(/\/+$/g, "")}/**/*`),
  ].filter((value) => value.length > 0);

  if (includes.length === 0) {
    return [];
  }

  const matches = await fg(includes, {
    cwd,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: partitioned.excludeGlobs,
    dot: true,
    unique: true,
    suppressErrors: true,
  });

  return matches.map((filePath) => path.resolve(filePath));
}

function normalizeGlob(pattern: string, cwd: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return "";
  }

  if (path.isAbsolute(trimmed)) {
    return toPosix(path.relative(cwd, trimmed));
  }

  return toPosix(trimmed);
}

function toPosixRelative(targetPath: string, cwd: string): string {
  return toPosix(path.relative(cwd, targetPath) || targetPath);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${size} B`;
}
