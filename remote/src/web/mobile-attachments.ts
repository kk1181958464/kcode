export const MAX_MOBILE_IMAGES = 9;
export const MAX_MOBILE_FILES = 9;
export const MAX_MOBILE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MOBILE_FILE_BYTES = 512 * 1024;
export const MAX_MOBILE_FILE_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_MOBILE_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export type MobileImageAttachment = {
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataUrl: string;
  size: number;
};

export type MobileContextAttachment = {
  id: string;
  name: string;
  content: string;
  size: number;
};

const CONTEXT_EXTENSIONS = [
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
];

const CONTEXT_NAMES = new Set([
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

function imageMediaType(
  file: File,
): MobileImageAttachment["mediaType"] | undefined {
  if (
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    return file.type as MobileImageAttachment["mediaType"];
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return undefined;
}

export function isMobileContextFile(name: string) {
  const lower = name.toLowerCase().replace(/\\/g, "/").split("/").at(-1) || "";
  if (CONTEXT_NAMES.has(lower) || lower.startsWith(".env.")) return true;
  return CONTEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function fileDataUrl(
  file: File,
  mediaType: MobileImageAttachment["mediaType"],
) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error(`${file.name} 的图片数据无效`));
      else resolve(`data:${mediaType};base64,${value.slice(comma + 1)}`);
    };
    reader.onerror = () =>
      reject(reader.error || new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}

function currentBytes(
  images: MobileImageAttachment[],
  files: MobileContextAttachment[],
) {
  return [...images, ...files].reduce((total, file) => total + file.size, 0);
}

export async function addMobileImages(
  current: MobileImageAttachment[],
  files: MobileContextAttachment[],
  selected: File[],
) {
  const images = [...current];
  const errors: string[] = [];
  const seen = new Set(current.map((file) => `${file.name}\0${file.size}`));
  let totalBytes = currentBytes(current, files);
  for (const file of selected) {
    if (images.length >= MAX_MOBILE_IMAGES) {
      errors.push(`每条消息最多上传 ${MAX_MOBILE_IMAGES} 张图片`);
      break;
    }
    const mediaType = imageMediaType(file);
    if (!mediaType) {
      errors.push(`${file.name || "图片"} 不是支持的图片格式`);
      continue;
    }
    if (file.size > MAX_MOBILE_IMAGE_BYTES) {
      errors.push(`${file.name || "图片"} 超过 5 MB`);
      continue;
    }
    const key = `${file.name}\0${file.size}`;
    if (seen.has(key)) continue;
    if (totalBytes + file.size > MAX_MOBILE_ATTACHMENT_BYTES) {
      errors.push("本条消息的附件总量不能超过 7 MB");
      break;
    }
    seen.add(key);
    try {
      images.push({
        id: crypto.randomUUID(),
        name: file.name || `image-${Date.now()}`,
        mediaType,
        dataUrl: await fileDataUrl(file, mediaType),
        size: file.size,
      });
      totalBytes += file.size;
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `${file.name} 读取失败`,
      );
    }
  }
  return { images, errors };
}

export async function addMobileContextFiles(
  current: MobileContextAttachment[],
  images: MobileImageAttachment[],
  selected: File[],
) {
  const files = [...current];
  const errors: string[] = [];
  const seen = new Set(current.map((file) => `${file.name}\0${file.size}`));
  let fileBytes = current.reduce((total, file) => total + file.size, 0);
  let totalBytes = currentBytes(images, current);
  for (const file of selected) {
    if (files.length >= MAX_MOBILE_FILES) {
      errors.push(`每条消息最多上传 ${MAX_MOBILE_FILES} 个文件`);
      break;
    }
    if (!isMobileContextFile(file.name)) {
      errors.push(`${file.name} 不是支持的文本或代码文件`);
      continue;
    }
    if (file.size > MAX_MOBILE_FILE_BYTES) {
      errors.push(`${file.name} 超过 512 KB`);
      continue;
    }
    const duplicateKey = `${file.name}\0${file.size}`;
    if (seen.has(duplicateKey)) continue;
    try {
      const content = await file.text();
      if (content.includes("\0"))
        throw new Error(`${file.name} 不是有效的文本文件`);
      const size = new TextEncoder().encode(content).byteLength;
      if (size > MAX_MOBILE_FILE_BYTES)
        throw new Error(`${file.name} 超过 512 KB`);
      if (fileBytes + size > MAX_MOBILE_FILE_TOTAL_BYTES) {
        errors.push("上下文文件总量不能超过 2 MB");
        break;
      }
      if (totalBytes + size > MAX_MOBILE_ATTACHMENT_BYTES) {
        errors.push("本条消息的附件总量不能超过 7 MB");
        break;
      }
      seen.add(duplicateKey);
      files.push({ id: crypto.randomUUID(), name: file.name, content, size });
      fileBytes += size;
      totalBytes += size;
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `${file.name} 读取失败`,
      );
    }
  }
  return { files, errors };
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
