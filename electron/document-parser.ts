import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  contextDocumentFormat,
  isSupportedContextFile,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_SOURCE_BYTES,
} from "../src/attachments";
import type { ContextFile } from "../src/types";

function trimText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function limitText(value: string) {
  const normalized = trimText(value);
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength <= MAX_CONTEXT_FILE_BYTES)
    return { content: normalized, truncated: false };
  const content = bytes
    .subarray(0, MAX_CONTEXT_FILE_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return {
    content: `${content}\n\n[文档内容过长，已截断至 ${MAX_CONTEXT_FILE_BYTES.toLocaleString()} 字节]`,
    truncated: true,
  };
}

async function wordText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function spreadsheetText(buffer: Buffer) {
  const XLSX = await import("xlsx-republish");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sections: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][];
    if (!rows.length) continue;
    sections.push(`## ${sheetName}`);
    sections.push(
      rows
        .map(
          (row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`,
        )
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

async function pdfText(buffer: Buffer) {
  const pdf = await import("pdf-parse");
  const parser = new pdf.PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function collectStrings(value: unknown, output: string[]) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text && text.length < 20_000 && !/^rId\d+$/.test(text))
      output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, output);
}

async function presentationText(filePath: string) {
  const module = await import("pptx2json");
  const Constructor =
    (
      module as unknown as {
        default?: new () => { toJson(path: string): Promise<unknown> };
      }
    ).default ??
    (module as unknown as new () => { toJson(path: string): Promise<unknown> });
  const json = await new Constructor().toJson(filePath);
  const strings: string[] = [];
  collectStrings(json, strings);
  return [...new Set(strings)].join("\n");
}

export async function parseContextFile(filePath: string): Promise<ContextFile> {
  const absolutePath = path.resolve(filePath);
  if (!isSupportedContextFile(absolutePath))
    throw new Error(`${path.basename(absolutePath)} 不是支持的上下文文件`);
  const info = await stat(absolutePath);
  if (!info.isFile())
    throw new Error(`${path.basename(absolutePath)} 不是普通文件`);
  if (info.size > MAX_CONTEXT_SOURCE_BYTES)
    throw new Error(
      `${path.basename(absolutePath)} 超过 ${Math.round(MAX_CONTEXT_SOURCE_BYTES / 1024 / 1024)} MB，无法解析`,
    );

  const format = contextDocumentFormat(absolutePath);
  const buffer = await readFile(absolutePath);
  let extracted: string;
  if (!format) extracted = buffer.toString("utf8");
  else if (format === "docx") extracted = await wordText(buffer);
  else if (format === "xlsx") extracted = await spreadsheetText(buffer);
  else if (format === "pptx") extracted = await presentationText(absolutePath);
  else extracted = await pdfText(buffer);

  if (extracted.includes("\u0000"))
    throw new Error(`${path.basename(absolutePath)} 无法转换为文本`);
  const limited = limitText(extracted);
  return {
    id: randomUUID(),
    name: path.basename(absolutePath),
    path: absolutePath,
    content: limited.content,
    size: Buffer.byteLength(limited.content, "utf8"),
    sourceSize: info.size,
    format: format ?? "text",
    truncated: limited.truncated,
  };
}
