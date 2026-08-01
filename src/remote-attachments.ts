import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
  MAX_IMAGE_FILES,
  MAX_IMAGE_FILE_BYTES,
  imageMediaType,
  isSupportedContextFile,
} from "./attachments";
import {
  MAX_REMOTE_ATTACHMENT_BYTES,
  type RemoteAttachments,
} from "./remote-types";
import type { ContextFile, ImageAttachment } from "./types";

function base64ByteLength(value: string) {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function attachmentId(value: string) {
  const id = value.trim();
  if (!id || id.length > 128) throw new Error("手机附件 ID 无效");
  return id;
}

function attachmentName(value: string) {
  const name = value.trim().replace(/^.*[\\/]/, "");
  if (!name || name.length > 240) throw new Error("手机附件名称无效");
  return name;
}

export function materializeRemoteAttachments(attachments?: RemoteAttachments): {
  images: ImageAttachment[];
  files: ContextFile[];
} {
  if (!attachments) return { images: [], files: [] };
  const sourceImages = attachments.images ?? [];
  const sourceFiles = attachments.files ?? [];
  if (sourceImages.length > MAX_IMAGE_FILES)
    throw new Error(`手机消息最多包含 ${MAX_IMAGE_FILES} 张图片`);
  if (sourceFiles.length > MAX_CONTEXT_FILES)
    throw new Error(`手机消息最多包含 ${MAX_CONTEXT_FILES} 个文件`);

  const seen = new Set<string>();
  let totalBytes = 0;
  const images = sourceImages.map((image) => {
    const id = attachmentId(image.id);
    if (seen.has(id)) throw new Error("手机附件 ID 重复");
    seen.add(id);
    const name = attachmentName(image.name);
    const mediaType = imageMediaType(image.mediaType, name);
    if (!mediaType || mediaType !== image.mediaType)
      throw new Error(`${name} 不是支持的图片格式`);
    const prefix = `data:${mediaType};base64,`;
    if (!image.dataUrl.startsWith(prefix))
      throw new Error(`${name} 的图片数据无效`);
    const size = base64ByteLength(image.dataUrl.slice(prefix.length));
    if (size <= 0 || size > MAX_IMAGE_FILE_BYTES)
      throw new Error(`${name} 超过 5 MB 或图片数据无效`);
    totalBytes += size;
    return { id, name, mediaType, dataUrl: image.dataUrl, size };
  });

  let fileBytes = 0;
  const encoder = new TextEncoder();
  const files = sourceFiles.map((file) => {
    const id = attachmentId(file.id);
    if (seen.has(id)) throw new Error("手机附件 ID 重复");
    seen.add(id);
    const name = attachmentName(file.name);
    if (!isSupportedContextFile(name))
      throw new Error(`${name} 不是支持的文本或代码文件`);
    if (file.content.includes("\0"))
      throw new Error(`${name} 不是有效的文本文件`);
    const size = encoder.encode(file.content).byteLength;
    if (size > MAX_CONTEXT_FILE_BYTES)
      throw new Error(`${name} 超过 512 KB，无法作为上下文添加`);
    fileBytes += size;
    if (fileBytes > MAX_CONTEXT_TOTAL_BYTES)
      throw new Error("手机消息中的上下文文件总量超过 2 MB");
    totalBytes += size;
    return {
      id,
      name,
      path: `remote://${id}/${encodeURIComponent(name)}`,
      content: file.content,
      size,
    };
  });

  if (totalBytes > MAX_REMOTE_ATTACHMENT_BYTES)
    throw new Error("手机消息的附件总量超过 7 MB");
  return { images, files };
}

export function remoteAttachmentPrompt(
  content: string,
  imageCount: number,
  fileCount: number,
) {
  const text = content.trim();
  if (text) return text;
  if (imageCount && fileCount) return "请分析这些图片和文件";
  if (imageCount) return "请分析这些图片";
  return "请分析这些文件";
}
