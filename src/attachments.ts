import type { ContextFile, ImageAttachment } from "./types";

export const CONTEXT_FILE_EXTENSIONS = [
  ".txt",
  ".md",
  ".mdx",
  ".rst",
  ".tex",
  ".json",
  ".jsonc",
  ".json5",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".astro",
  ".svg",
  ".twig",
  ".njk",
  ".hbs",
  ".mustache",
  ".ejs",
  ".pug",
  ".php",
  ".py",
  ".ipynb",
  ".java",
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  ".go",
  ".rs",
  ".rb",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".dart",
  ".lua",
  ".r",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".plist",
  ".properties",
  ".gradle",
  ".lock",
  ".mod",
  ".sum",
  ".work",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".prisma",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".ini",
  ".conf",
  ".cfg",
  ".env",
  ".csv",
  ".tsv",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xlsm",
  ".pptx",
  ".ppsx",
] as const;

const CONTEXT_FILE_NAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "cmakelists.txt",
  "jenkinsfile",
  "procfile",
  "gemfile",
  "rakefile",
  "vagrantfile",
  "brewfile",
  "podfile",
  "fastfile",
  "license",
  "authors",
  "notice",
  "changelog",
  "readme",
  "todo",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".dockerignore",
  ".editorconfig",
  ".npmrc",
  ".yarnrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  ".stylelintrc",
  ".babelrc",
  ".browserslistrc",
]);

export const CONTEXT_FILE_DIALOG_EXTENSIONS = CONTEXT_FILE_EXTENSIONS.map(
  (extension) => extension.slice(1),
);
export const MAX_CONTEXT_FILES = 9;
export const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024;
/** Binary documents may be larger on disk; the extracted text still follows the context limits. */
export const MAX_CONTEXT_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTEXT_TOTAL_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGE_FILES = 9;
export const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;

export type ContextFileMergeResult = {
  files: ContextFile[];
  countOverflow: number;
  totalOverflow: ContextFile[];
};

const imageMediaTypes = new Set<ImageAttachment["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function isSupportedContextFile(name: string) {
  const lowerName =
    name.toLowerCase().replace(/\\/g, "/").split("/").at(-1) || "";
  if (CONTEXT_FILE_NAMES.has(lowerName) || lowerName.startsWith(".env."))
    return true;
  return CONTEXT_FILE_EXTENSIONS.some((extension) =>
    lowerName.endsWith(extension),
  );
}

export type ContextDocumentFormat = "pdf" | "docx" | "xlsx" | "pptx";

export function contextDocumentFormat(
  name: string,
): ContextDocumentFormat | undefined {
  const lowerName =
    name.toLowerCase().replace(/\\/g, "/").split("/").at(-1) || "";
  if (lowerName.endsWith(".pdf")) return "pdf";
  if (lowerName.endsWith(".docx")) return "docx";
  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xlsm")) return "xlsx";
  if (lowerName.endsWith(".pptx") || lowerName.endsWith(".ppsx")) return "pptx";
  return undefined;
}

export function isBinaryContextFile(name: string) {
  return Boolean(contextDocumentFormat(name));
}

export function mergeContextFiles(
  current: ContextFile[],
  incoming: ContextFile[],
): ContextFileMergeResult {
  const files = [...current];
  const seenPaths = new Set(current.map((file) => file.path));
  const totalOverflow: ContextFile[] = [];
  let countOverflow = 0;
  let totalBytes = current.reduce((total, file) => total + file.size, 0);

  for (const file of incoming) {
    if (seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);
    if (files.length >= MAX_CONTEXT_FILES) {
      countOverflow += 1;
      continue;
    }
    if (totalBytes + file.size > MAX_CONTEXT_TOTAL_BYTES) {
      totalOverflow.push(file);
      continue;
    }
    files.push(file);
    totalBytes += file.size;
  }

  return { files, countOverflow, totalOverflow };
}

export function imageMediaType(
  mimeType: string,
  name: string,
): ImageAttachment["mediaType"] | undefined {
  if (imageMediaTypes.has(mimeType as ImageAttachment["mediaType"]))
    return mimeType as ImageAttachment["mediaType"];
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  return undefined;
}
