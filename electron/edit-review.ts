/**
 * Edit review — per-file Keep/Undo for the current agent turn, plus
 * turn-scoped file restore checkpoints that roll files back without wiping chat.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type PendingEditRecord = {
  root: string;
  requestId: string;
  taskId?: string;
  relativePath: string;
  absolutePath: string;
  /** Content before the first mutation in this request. */
  before: string;
  existed: boolean;
  activityIds: string[];
  status: "pending" | "kept" | "undone";
};

export type EditCheckpoint = {
  id: string;
  requestId: string;
  taskId?: string;
  label: string;
  createdAt: number;
  root: string;
  /** relative path -> original content at checkpoint creation */
  files: Record<
    string,
    {
      absolutePath: string;
      before: string;
      existed: boolean;
    }
  >;
};

export type EditReviewBatchResult = {
  success: boolean;
  message: string;
  conflict?: boolean;
  paths: string[];
  activityIds: string[];
};

export type EditCheckpointInfo = {
  id: string;
  requestId: string;
  taskId?: string;
  label: string;
  createdAt: number;
  fileCount: number;
  paths: string[];
};

const pendingEdits = new Map<string, PendingEditRecord>();
const checkpoints = new Map<string, EditCheckpoint>();

function normalizeRel(root: string, absoluteOrRelative: string) {
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? path.resolve(absoluteOrRelative)
    : path.resolve(root, absoluteOrRelative);
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function editKey(requestId: string, relativePath: string) {
  return `${requestId}::${relativePath}`;
}

function ensureCheckpoint(
  root: string,
  requestId: string,
  taskId: string | undefined,
  createdAt: number,
) {
  for (const checkpoint of checkpoints.values()) {
    if (checkpoint.requestId === requestId && checkpoint.root === root)
      return checkpoint;
  }
  const id = `edit-cp-${requestId}`;
  const checkpoint: EditCheckpoint = {
    id,
    requestId,
    taskId,
    label: "本轮改动前",
    createdAt,
    root,
    files: {},
  };
  checkpoints.set(id, checkpoint);
  return checkpoint;
}

/** Record the pre-mutation baseline the first time a file is touched in a request. */
export function recordPendingEdit(input: {
  root: string;
  requestId: string;
  taskId?: string;
  activityId: string;
  file: string;
  before: string;
  existed: boolean;
}) {
  const root = path.resolve(input.root);
  const absolutePath = path.isAbsolute(input.file)
    ? path.resolve(input.file)
    : path.resolve(root, input.file);
  const relativePath = normalizeRel(root, absolutePath);
  const key = editKey(input.requestId, relativePath);
  const existing = pendingEdits.get(key);
  if (existing) {
    if (!existing.activityIds.includes(input.activityId))
      existing.activityIds.push(input.activityId);
    // Keep the earliest baseline; later mutations only attach activity ids.
    if (existing.status === "kept" || existing.status === "undone") {
      existing.status = "pending";
      existing.before = input.before;
      existing.existed = input.existed;
    }
    const checkpoint = ensureCheckpoint(
      root,
      input.requestId,
      input.taskId ?? existing.taskId,
      Date.now(),
    );
    if (!checkpoint.files[relativePath]) {
      checkpoint.files[relativePath] = {
        absolutePath,
        before: existing.before,
        existed: existing.existed,
      };
    }
    return existing;
  }

  const record: PendingEditRecord = {
    root,
    requestId: input.requestId,
    taskId: input.taskId,
    relativePath,
    absolutePath,
    before: input.before,
    existed: input.existed,
    activityIds: [input.activityId],
    status: "pending",
  };
  pendingEdits.set(key, record);
  const checkpoint = ensureCheckpoint(
    root,
    input.requestId,
    input.taskId,
    Date.now(),
  );
  checkpoint.files[relativePath] = {
    absolutePath,
    before: input.before,
    existed: input.existed,
  };
  return record;
}

export function listPendingEdits(requestId?: string, root?: string) {
  const resolvedRoot = root ? path.resolve(root) : undefined;
  return [...pendingEdits.values()].filter((record) => {
    if (requestId && record.requestId !== requestId) return false;
    if (resolvedRoot && record.root !== resolvedRoot) return false;
    return true;
  });
}

export function listEditCheckpoints(requestId?: string): EditCheckpointInfo[] {
  return [...checkpoints.values()]
    .filter((checkpoint) =>
      requestId ? checkpoint.requestId === requestId : true,
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((checkpoint) => ({
      id: checkpoint.id,
      requestId: checkpoint.requestId,
      taskId: checkpoint.taskId,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      fileCount: Object.keys(checkpoint.files).length,
      paths: Object.keys(checkpoint.files),
    }));
}

function matchingRecords(
  workspaceRoot: string,
  requestId: string,
  paths?: string[],
) {
  const root = path.resolve(workspaceRoot);
  const wanted = paths?.length
    ? new Set(paths.map((item) => normalizeRel(root, item)))
    : undefined;
  return listPendingEdits(requestId, root).filter((record) => {
    if (wanted && !wanted.has(record.relativePath)) return false;
    return true;
  });
}

async function restoreRecord(
  record: PendingEditRecord,
  force: boolean,
): Promise<{ ok: boolean; conflict?: boolean; message: string }> {
  let current = "";
  let currentExists = true;
  try {
    current = await readFile(record.absolutePath, "utf8");
  } catch {
    currentExists = false;
  }

  if (!force) {
    // Soft conflict: file differs from what we last thought was the end state
    // of pending edits. Callers that know the activity after-image can force.
    if (record.status === "kept") {
      return { ok: false, message: "该文件已标记为保留" };
    }
    if (record.status === "undone") {
      return { ok: false, message: "该文件已经撤销" };
    }
  }

  try {
    if (!record.existed) {
      if (currentExists) await unlink(record.absolutePath);
    } else {
      await mkdir(path.dirname(record.absolutePath), { recursive: true });
      await writeFile(record.absolutePath, record.before, "utf8");
    }
    record.status = "undone";
    return {
      ok: true,
      message: record.existed ? "已恢复修改前内容" : "已删除本次新建的文件",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function keepPendingFiles(
  workspaceRoot: string,
  requestId: string,
  paths?: string[],
): Promise<EditReviewBatchResult> {
  const records = matchingRecords(workspaceRoot, requestId, paths).filter(
    (record) => record.status === "pending",
  );
  if (!records.length) {
    return {
      success: true,
      message: "没有待保留的文件改动",
      paths: [],
      activityIds: [],
    };
  }
  const activityIds = new Set<string>();
  const keptPaths: string[] = [];
  for (const record of records) {
    record.status = "kept";
    keptPaths.push(record.relativePath);
    for (const id of record.activityIds) activityIds.add(id);
  }
  return {
    success: true,
    message: `已保留 ${keptPaths.length} 个文件的改动`,
    paths: keptPaths,
    activityIds: [...activityIds],
  };
}

export async function undoPendingFiles(
  workspaceRoot: string,
  requestId: string,
  paths?: string[],
  force = false,
): Promise<EditReviewBatchResult> {
  const records = matchingRecords(workspaceRoot, requestId, paths).filter(
    (record) => record.status === "pending" || force,
  );
  if (!records.length) {
    return {
      success: false,
      message: "没有可撤销的文件改动",
      paths: [],
      activityIds: [],
    };
  }

  const activityIds = new Set<string>();
  const undonePaths: string[] = [];
  const failures: string[] = [];
  let conflict = false;

  for (const record of records) {
    if (record.status === "kept" && !force) {
      failures.push(`${record.relativePath}: 已保留`);
      continue;
    }
    if (record.status === "undone" && !force) continue;
    const result = await restoreRecord(record, force);
    if (!result.ok) {
      failures.push(`${record.relativePath}: ${result.message}`);
      if (result.conflict) conflict = true;
      continue;
    }
    undonePaths.push(record.relativePath);
    for (const id of record.activityIds) activityIds.add(id);
  }

  if (!undonePaths.length) {
    return {
      success: false,
      conflict,
      message: failures[0] || "撤销失败",
      paths: [],
      activityIds: [],
    };
  }

  return {
    success: true,
    conflict: failures.length > 0 ? conflict : undefined,
    message:
      failures.length > 0
        ? `已撤销 ${undonePaths.length} 个文件；${failures.length} 个失败`
        : `已撤销 ${undonePaths.length} 个文件的改动`,
    paths: undonePaths,
    activityIds: [...activityIds],
  };
}

export async function restoreEditCheckpoint(
  checkpointId: string,
  force = false,
): Promise<EditReviewBatchResult> {
  const checkpoint = checkpoints.get(checkpointId);
  if (!checkpoint) {
    return {
      success: false,
      message: "还原点不存在或已失效",
      paths: [],
      activityIds: [],
    };
  }

  const paths = Object.keys(checkpoint.files);
  // Ensure pending records exist so activity linkage is preserved when possible.
  for (const relativePath of paths) {
    const file = checkpoint.files[relativePath];
    const key = editKey(checkpoint.requestId, relativePath);
    if (!pendingEdits.has(key)) {
      pendingEdits.set(key, {
        root: checkpoint.root,
        requestId: checkpoint.requestId,
        taskId: checkpoint.taskId,
        relativePath,
        absolutePath: file.absolutePath,
        before: file.before,
        existed: file.existed,
        activityIds: [],
        status: "pending",
      });
    } else {
      const record = pendingEdits.get(key)!;
      // Restore uses the checkpoint baseline, which is the turn-start content.
      record.before = file.before;
      record.existed = file.existed;
      record.status = "pending";
    }
  }

  return undoPendingFiles(
    checkpoint.root,
    checkpoint.requestId,
    paths,
    force,
  );
}

export function clearEditReview(
  requestIds: string[] = [],
  activityIds: string[] = [],
) {
  const requests = new Set(requestIds);
  const activities = new Set(activityIds);
  for (const [key, record] of pendingEdits) {
    if (
      requests.has(record.requestId) ||
      record.activityIds.some((id) => activities.has(id))
    )
      pendingEdits.delete(key);
  }
  for (const [id, checkpoint] of checkpoints) {
    if (requests.has(checkpoint.requestId)) checkpoints.delete(id);
  }
}

/** Test helper — wipe in-memory review state. */
export function resetEditReviewForTests() {
  pendingEdits.clear();
  checkpoints.clear();
}
