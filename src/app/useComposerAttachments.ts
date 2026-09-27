import { uid, type TaskRecord } from "../models";
import { errorMessage } from "../lib/format";
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_SOURCE_BYTES,
  MAX_IMAGE_FILES,
  MAX_IMAGE_FILE_BYTES,
  imageMediaType,
  isBinaryContextFile,
  isSupportedContextFile,
  mergeContextFiles,
} from "../attachments";
import { directoryFromFilePath } from "../context-directory";
import type { ContextFile, ImageAttachment } from "../types";
import { fileDataUrl } from "./app-utils";

type ComposerAttachmentBindings = {
  setContextError: React.Dispatch<React.SetStateAction<string>>;
  effectiveContextDirectory: string | undefined;
  attachedFiles: ContextFile[];
  setAttachedFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  patchActiveTask: (patch: Partial<TaskRecord>) => void;
  activeTask: TaskRecord;
  attachedImages: ImageAttachment[];
  setAttachedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  composerDragDepthRef: React.RefObject<number>;
  setComposerDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  runningId: string | undefined;
  summaryBusy: boolean;
};

export function useComposerAttachments({
  setContextError,
  effectiveContextDirectory,
  attachedFiles,
  setAttachedFiles,
  patchActiveTask,
  activeTask,
  attachedImages,
  setAttachedImages,
  composerDragDepthRef,
  setComposerDragActive,
  runningId,
  summaryBusy,
}: ComposerAttachmentBindings) {
  async function pickContextFiles() {
    setContextError("");
    try {
      const files = window.kcode
        ? await window.kcode.context.pickFiles(effectiveContextDirectory)
        : [
            {
              id: uid(),
              name: "README.md",
              path: "D:/project/kcode/README.md",
              content: "# KCode\n\nMulti-provider desktop coding agent.",
              size: 55,
            },
          ];
      if (files[0]) rememberTaskContextDirectory(files[0].path);
      const merged = mergeContextFiles(attachedFiles, files);
      setAttachedFiles(merged.files);
      const warnings = merged.totalOverflow.map(
        (file) => `${file.name} 超出 2 MB 上下文文件总量限制`,
      );
      if (merged.countOverflow)
        warnings.push(
          `最多添加 ${MAX_CONTEXT_FILES} 个上下文文件，已忽略 ${merged.countOverflow} 个`,
        );
      setContextError(warnings.join("；"));
    } catch (error) {
      setContextError(errorMessage(error));
    }
  }

  function attachmentPath(file: File) {
    try {
      return window.kcode?.context.filePath?.(file) || file.name;
    } catch {
      return file.name;
    }
  }

  function rememberTaskContextDirectory(filePath: string) {
    const directory = directoryFromFilePath(filePath);
    if (directory && directory !== activeTask?.contextDirectory)
      patchActiveTask({ contextDirectory: directory });
  }

  async function addImageFiles(files: File[]) {
    const errors: string[] = [];
    if (!files.length) return errors;
    const remaining = Math.max(0, MAX_IMAGE_FILES - attachedImages.length);
    if (!remaining) return [`每次最多添加 ${MAX_IMAGE_FILES} 张图片`];
    const selectedFiles = files.slice(0, remaining);
    const settled = await Promise.allSettled(
      selectedFiles.map(async (file, index): Promise<ImageAttachment> => {
        const mediaType = imageMediaType(file.type, file.name);
        if (!mediaType)
          throw new Error(`${file.name || "图片"} 不是支持的图片格式`);
        if (file.size > MAX_IMAGE_FILE_BYTES)
          throw new Error(`${file.name || `图片 ${index + 1}`} 超过 5 MB`);
        return {
          id: uid(),
          name: file.name || `图片 ${Date.now()}-${index + 1}.png`,
          mediaType,
          dataUrl: await fileDataUrl(file),
          size: file.size,
        };
      }),
    );
    const images: ImageAttachment[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") images.push(result.value);
      else errors.push(errorMessage(result.reason));
    }
    if (images.length)
      setAttachedImages((current) =>
        [...current, ...images].slice(0, MAX_IMAGE_FILES),
      );
    if (files.length > remaining)
      errors.push(
        `最多添加 ${MAX_IMAGE_FILES} 张图片，已忽略 ${files.length - remaining} 张`,
      );
    return errors;
  }

  async function addDroppedContextFiles(files: File[]) {
    const errors: string[] = [];
    if (!files.length) return errors;
    const seenPaths = new Set(attachedFiles.map((file) => file.path));
    const eligible: { file: File; path: string }[] = [];
    for (const file of files) {
      const path = attachmentPath(file);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      if (!isSupportedContextFile(file.name)) {
        errors.push(`${file.name} 不是支持的文本或代码文件`);
        continue;
      }
      const binaryDocument = isBinaryContextFile(file.name);
      if (
        file.size >
        (binaryDocument ? MAX_CONTEXT_SOURCE_BYTES : MAX_CONTEXT_FILE_BYTES)
      ) {
        errors.push(
          binaryDocument
            ? `${file.name} 超过 ${Math.round(MAX_CONTEXT_SOURCE_BYTES / 1024 / 1024)} MB，无法解析`
            : `${file.name} 超过 512 KB，无法作为上下文添加`,
        );
        continue;
      }
      eligible.push({ file, path });
    }
    const selectedFiles = eligible.slice(0, MAX_CONTEXT_FILES);
    const settled = await Promise.allSettled(
      selectedFiles.map(async ({ file, path }): Promise<ContextFile> => {
        if (isBinaryContextFile(file.name)) {
          if (!window.kcode?.files?.parse)
            throw new Error(`${file.name} 需要桌面版文档解析支持`);
          return window.kcode.files.parse(path);
        }
        const content = await file.text();
        if (content.includes("\0"))
          throw new Error(`${file.name} 不是有效的文本文件`);
        return {
          id: uid(),
          name: file.name,
          path,
          content,
          size: file.size,
        };
      }),
    );
    const accepted: ContextFile[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(errorMessage(result.reason));
        continue;
      }
      accepted.push(result.value);
    }
    const merged = mergeContextFiles(attachedFiles, accepted);
    if (merged.files.length !== attachedFiles.length)
      setAttachedFiles(merged.files);
    errors.push(
      ...merged.totalOverflow.map(
        (file) => `${file.name} 超出 2 MB 上下文文件总量限制`,
      ),
    );
    const countOverflow =
      eligible.length - selectedFiles.length + merged.countOverflow;
    if (countOverflow)
      errors.push(
        `最多添加 ${MAX_CONTEXT_FILES} 个上下文文件，已忽略 ${countOverflow} 个`,
      );
    return errors;
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    setContextError((await addImageFiles(files)).join("；"));
  }

  function composerDragHasFiles(event: React.DragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    composerDragDepthRef.current += 1;
    if (!runningId && !summaryBusy) setComposerDragActive(true);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = runningId || summaryBusy ? "none" : "copy";
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    composerDragDepthRef.current = Math.max(
      0,
      composerDragDepthRef.current - 1,
    );
    if (!composerDragDepthRef.current) setComposerDragActive(false);
  }

  async function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    if (runningId || summaryBusy) {
      setContextError("当前任务运行时不能添加附件");
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const imageFiles: File[] = [];
    const contextFiles: File[] = [];
    for (const file of files) {
      if (imageMediaType(file.type, file.name)) imageFiles.push(file);
      else contextFiles.push(file);
    }
    const validSource = files.find(
      (file) =>
        Boolean(imageMediaType(file.type, file.name)) ||
        isSupportedContextFile(file.name),
    );
    if (validSource) rememberTaskContextDirectory(attachmentPath(validSource));
    const [imageErrors, fileErrors] = await Promise.all([
      addImageFiles(imageFiles),
      addDroppedContextFiles(contextFiles),
    ]);
    setContextError([...imageErrors, ...fileErrors].join("；"));
  }
  return {
    pickContextFiles,
    pasteImages,
    handleComposerDragEnter,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
  };
}
