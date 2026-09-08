import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { DatabaseSync } from "node:sqlite"
import { parseTasksFile } from "@mapctx/core"
import { buildExport } from "./export"

export type DriftIssue = {
  taskId: string;
  file: string;
  reason: string;
};

export type DriftReport = {
  hasDrift: boolean;
  issues: DriftIssue[];
};

const BOARD_METADATA_SENTINEL = "__board__";

function normalizeBytes(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(line => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Regenerate-and-compare drift check (ADR 0003 "Authority and cutover"):
 * no mtime, no persisted hash -- byte-for-byte comparison after
 * LF-normalization and trailing-whitespace trimming, enumerated per task ID.
 */
export function checkDrift(db: DatabaseSync, tasksRoot: string): DriftReport {
  const exported = buildExport(db, { tasksRoot });
  const issues: DriftIssue[] = [];

  const onDiskTasksMd = fs.existsSync(exported.tasksMd.path) ? fs.readFileSync(exported.tasksMd.path, "utf8") : "";
  if (normalizeBytes(onDiskTasksMd) !== normalizeBytes(exported.tasksMd.content)) {
    const attributed = diffTasksMdPerTask(exported.tasksMd.path, onDiskTasksMd, exported.tasksMd.content);
    // R8: the boolean decision is byte-mismatch driven, independent of
    // attribution. Swapped task blocks, parser-ignored prose, or equivalent
    // heading spellings can vanish under per-task map comparison -- they
    // still drift, and must surface as a board-level issue rather than a
    // silent "no drift".
    if (attributed.length === 0) {
      issues.push({
        taskId: BOARD_METADATA_SENTINEL,
        file: exported.tasksMd.path,
        reason: "TASKS.md bytes differ from store authority but parsed tasks/metadata match (order swap, ignored prose, or equivalent spelling)"
      });
    } else {
      issues.push(...attributed);
    }
  }

  for (const file of exported.taskDetailFiles) {
    const onDisk = fs.existsSync(file.path) ? fs.readFileSync(file.path, "utf8") : "";
    if (normalizeBytes(onDisk) !== normalizeBytes(file.content)) {
      issues.push({ taskId: path.basename(file.path, ".md"), file: file.path, reason: "detail file drift" });
    }
  }

  return { hasDrift: issues.length > 0, issues };
}

function diffTasksMdPerTask(onDiskPath: string, onDiskContent: string, exportedContent: string): DriftIssue[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-drift-"));
  try {
    const exportedTmpPath = path.join(tmpDir, "TASKS.md");
    fs.writeFileSync(exportedTmpPath, exportedContent, "utf8");

    const onDiskTmpPath = path.join(tmpDir, "TASKS.on-disk.md");
    fs.writeFileSync(onDiskTmpPath, onDiskContent, "utf8");

    const onDiskBoard = parseTasksFile(onDiskTmpPath);
    const exportedBoard = parseTasksFile(exportedTmpPath);

    const issues: DriftIssue[] = [];
    const onDiskById = new Map(onDiskBoard.tasks.map(t => [t.id, t]));
    const exportedById = new Map(exportedBoard.tasks.map(t => [t.id, t]));
    const allIds = new Set([...onDiskById.keys(), ...exportedById.keys()]);

    for (const id of allIds) {
      const a = onDiskById.get(id);
      const b = exportedById.get(id);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const reason = !a ? "task present in store but missing on disk" : !b ? "task present on disk but missing in store" : "task field drift";
        issues.push({ taskId: id, file: onDiskPath, reason });
      }
    }

    const boardMetaChanged =
      onDiskBoard.title !== exportedBoard.title ||
      normalizeBytes((onDiskBoard.workDomainsSection ?? []).join("\n")) !== normalizeBytes((exportedBoard.workDomainsSection ?? []).join("\n")) ||
      normalizeBytes((onDiskBoard.notesSection ?? []).join("\n")) !== normalizeBytes((exportedBoard.notesSection ?? []).join("\n"));
    if (boardMetaChanged) {
      issues.push({ taskId: BOARD_METADATA_SENTINEL, file: onDiskPath, reason: "board title/work domains/notes drift" });
    }

    // Explicit order comparison: identical task sets in a different order
    // preserve every per-task field, so map comparison cannot see it.
    const onDiskOrder = onDiskBoard.tasks.map(t => t.id).join(",");
    const exportedOrder = exportedBoard.tasks.map(t => t.id).join(",");
    if (onDiskOrder !== exportedOrder) {
      issues.push({ taskId: BOARD_METADATA_SENTINEL, file: onDiskPath, reason: "task block order drift" });
    }

    return issues;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
