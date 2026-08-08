import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx-republish";
import { parseContextFile } from "./document-parser";

test("parses text files into context attachments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-document-"));
  try {
    const file = path.join(directory, "notes.md");
    await writeFile(file, "# Notes\n\nhello", "utf8");
    const parsed = await parseContextFile(file);
    assert.equal(parsed.format, "text");
    assert.equal(parsed.content, "# Notes\n\nhello");
    assert.equal(parsed.truncated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("converts spreadsheet rows to readable markdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-sheet-"));
  try {
    const file = path.join(directory, "report.xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "count"],
        ["alpha", 3],
      ]),
      "Summary",
    );
    XLSX.writeFile(workbook, file);
    const parsed = await parseContextFile(file);
    assert.equal(parsed.format, "xlsx");
    assert.match(parsed.content, /## Summary/);
    assert.match(parsed.content, /\| alpha \| 3 \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
