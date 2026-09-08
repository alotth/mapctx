import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { parseTasksFile, readTaskDetailFile, type TaskBoard } from "@mapctx/core"
import { STATUS_TO_PLANNING } from "@mapctx/protocol"
import type {
  DependencyRecord,
  ExternalRefRecord,
  ProjectMetadata,
  TaskDetailRecord,
  TaskRecord,
  WorkDomain
} from "./types"

export type ImportIssueSeverity = "error" | "warning";

export type ImportIssue = {
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  taskId?: string;
};

export type ImportTaskItem = {
  task: TaskRecord;
  detail: TaskDetailRecord;
  outgoingEdges: DependencyRecord[];
  externalRefs: ExternalRefRecord[];
};

export type ImportPlan = {
  tasksFilePath: string;
  tasksRoot: string;
  inputHash: string;
  taskCount: number;
  ids: string[];
  project: ProjectMetadata;
  tasks: ImportTaskItem[];
  issues: ImportIssue[];
  errors: number;
  warnings: number;
};

const EXTERNAL_ID_RE = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):(.+)$/;
const KNOWN_PROVIDERS = new Set(["traycer", "github", "orca", "paperclip"]);
const KNOWN_ENTITY_KINDS = new Set(["epic", "artifact", "issue", "project-item", "run", "dispatch"]);

/**
 * The board renderer always separates "## Notes" from its content with one
 * blank line (matching the existing TASKS.md convention); the line-based
 * parser has no way to tell that separator apart from real content, so it
 * lands as notesSection[0] === "". Drop exactly that one leading blank --
 * not all blank lines, since interior ones are meaningful paragraph breaks.
 */
function joinNotesSection(lines: string[]): string {
  const withoutLeadingBlank = lines[0] === "" ? lines.slice(1) : lines;
  return withoutLeadingBlank.join("\n").replace(/\n+$/, "");
}

function parseWorkDomains(lines: string[]): WorkDomain[] {
  const out: WorkDomain[] = [];
  for (const line of lines) {
    const m = line.trim().match(/^-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    out.push({ key: m[1], description: m[2].trim() });
  }
  return out;
}

function externalRefFromId(taskId: string, externalId: string, refIdSeed: string): ExternalRefRecord {
  const m = externalId.match(EXTERNAL_ID_RE);
  const provider = m && KNOWN_PROVIDERS.has(m[1]) ? m[1] : "other";
  const entityKind = m && KNOWN_ENTITY_KINDS.has(m[2]) ? m[2] : "other";
  const externalKey = m ? m[3] : externalId;
  return {
    refId: crypto.createHash("sha256").update(refIdSeed).digest("hex").slice(0, 32),
    ownerKind: "task",
    ownerId: taskId,
    provider,
    entityKind,
    externalKey,
    uri: externalId,
    metadata: {},
    verified: false
  };
}

function externalRefsFromLinks(taskId: string, links: string[]): ExternalRefRecord[] {
  return links.map((link, index) => externalRefFromId(taskId, link, `${taskId}#externalLinks#${index}#${link}`));
}

function fileHash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8"), "utf8").digest("hex");
}

/**
 * Lexical confinement is necessary but not sufficient: the cutover writes
 * the regenerated detail file through this path and writeFileSync follows
 * symlinks, so a committed `tasks/T-101.md` symlink could redirect the write
 * at an unstaged in-repo file or a file outside the repository while the
 * cleanliness check only ever covered the symlink path itself. Fail closed:
 * no component of the path may be a symlink, and the file's realpath must
 * stay beneath the repository root's realpath.
 */
function assertRealDetailPath(tasksRoot: string, candidate: string, taskId: string, issues: ImportIssue[]): void {
  const resolved = path.resolve(tasksRoot, candidate);
  const relative = path.relative(tasksRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    issues.push({ severity: "error", code: "path-escapes-repo", message: `detail path escapes repository root: ${candidate}`, taskId });
    return;
  }
  let probe = tasksRoot;
  for (const part of relative.split(path.sep)) {
    if (part === "") continue;
    probe = path.join(probe, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(probe);
    } catch {
      return; // missing path component: reported by the missing-detail-file check
    }
    if (stats.isSymbolicLink()) {
      let target: string;
      try { target = fs.realpathSync(probe); } catch { target = "unreadable"; }
      issues.push({
        severity: "error",
        code: "symlinked-detail-path",
        taskId,
        message: `detail path component "${path.relative(tasksRoot, probe)}" is a symlink to ${target}; symlinks are refused so a cutover cannot write through them. Replace it with a real file and update the board reference.`
      });
      return;
    }
  }
  try {
    const realRoot = fs.realpathSync(tasksRoot);
    const realDetail = fs.realpathSync(resolved);
    const real = path.relative(realRoot, realDetail);
    if (real.startsWith("..") || path.isAbsolute(real)) {
      issues.push({
        severity: "error",
        code: "path-escapes-repo",
        taskId,
        message: `detail path resolves outside the repository: ${candidate} -> ${realDetail}`
      });
    }
  } catch {
    // unreadable realpath: reported by the missing-detail-file check
  }
}

/**
 * Reads TASKS.md and every task's detail file, and builds a fully validated
 * ImportPlan without writing anything. Used by both `import --dry-run` and
 * as the first phase of `import --commit`.
 */
export function planImport(tasksFilePath: string): ImportPlan {
  const tasksRoot = path.dirname(tasksFilePath);
  const issues: ImportIssue[] = [];

  let board: TaskBoard;
  try {
    board = parseTasksFile(tasksFilePath);
  } catch (error) {
    issues.push({ severity: "error", code: "unreadable-tasks-file", message: (error as Error).message });
    return emptyPlanWithIssues(tasksFilePath, tasksRoot, issues);
  }

  const ids = board.tasks.map(task => task.id);
  const idSet = new Set(ids);
  const idCounts = new Map<string, number>();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) issues.push({ severity: "error", code: "duplicate-id", message: `Duplicate task id: ${id}`, taskId: id });
  }

  // task_projection enforces externalId uniqueness (two tasks cannot claim
  // the same external issue/artifact); catch it here with a clear per-task
  // error instead of letting it surface as a raw SQL constraint failure
  // partway through the commit transaction.
  const externalIdOwners = new Map<string, string[]>();
  for (const boardTask of board.tasks) {
    if (!boardTask.externalId) continue;
    const owners = externalIdOwners.get(boardTask.externalId) ?? [];
    owners.push(boardTask.id);
    externalIdOwners.set(boardTask.externalId, owners);
  }
  for (const [externalId, owners] of externalIdOwners) {
    if (owners.length <= 1) continue;
    for (const taskId of owners) {
      issues.push({
        severity: "error",
        code: "duplicate-external-id",
        message: `externalId "${externalId}" is claimed by multiple tasks: ${owners.join(", ")}`,
        taskId
      });
    }
  }

  const items: ImportTaskItem[] = [];

  board.tasks.forEach((boardTask, index) => {
    const taskId = boardTask.id;

    if (boardTask.parent && !idSet.has(boardTask.parent)) {
      issues.push({ severity: "error", code: "missing-parent", message: `Parent not found: ${boardTask.parent}`, taskId });
    }
    for (const dep of boardTask.dependsOn ?? []) {
      if (!idSet.has(dep)) {
        issues.push({ severity: "error", code: "missing-dependency", message: `Dependency not found: ${dep}`, taskId });
      }
    }

    if (!boardTask.detail) {
      issues.push({ severity: "error", code: "missing-detail-field", message: "Task has no detail path.", taskId });
      return;
    }
    assertRealDetailPath(tasksRoot, boardTask.detail, taskId, issues);
    const detailPath = path.resolve(tasksRoot, boardTask.detail);
    if (!fs.existsSync(detailPath)) {
      issues.push({ severity: "error", code: "missing-detail-file", message: `Detail file not found: ${boardTask.detail}`, taskId });
      return;
    }

    const detailFile = readTaskDetailFile(detailPath);
    if (!detailFile.description || detailFile.description.trim() === "") {
      issues.push({ severity: "error", code: "missing-description", message: "description is required and must be non-empty.", taskId });
    }

    const prerequisiteSet = new Set(detailFile.prerequisites);
    const dependsOnSet = new Set(boardTask.dependsOn ?? []);
    if (prerequisiteSet.size !== dependsOnSet.size || [...prerequisiteSet].some(id => !dependsOnSet.has(id))) {
      issues.push({
        severity: "warning",
        code: "prerequisites-dependson-mismatch",
        message: `detail prerequisites ${JSON.stringify([...prerequisiteSet])} do not match TASKS.md dependsOn ${JSON.stringify([...dependsOnSet])}.`,
        taskId
      });
    }
    for (const blockedId of detailFile.blocking) {
      if (!idSet.has(blockedId)) {
        issues.push({ severity: "error", code: "missing-blocking-target", message: `blocking target not found: ${blockedId}`, taskId });
      }
    }

    for (const [field, value] of Object.entries(boardTask.droppedFields ?? {})) {
      issues.push({
        severity: "error",
        code: "unrepresentable-field-value",
        message: `${field} value ${JSON.stringify(value)} is outside the accepted set; importing it would silently discard the authored value.`,
        taskId
      });
    }

    const planningState = STATUS_TO_PLANNING[boardTask.status] ?? null;
    if (!planningState) {
      issues.push({ severity: "error", code: "unmapped-status", message: `Status has no planningState mapping: ${boardTask.status}`, taskId });
    }

    const canonicalDetailPath = `./tasks/${taskId}.md`;
    if (path.resolve(detailPath) !== path.resolve(tasksRoot, canonicalDetailPath)) {
      issues.push({ severity: "error", code: "noncanonical-detail-path", taskId,
        message: `Detail must be at ${canonicalDetailPath}; move the authored file and update its board reference before importing.` });
    }

    const task: TaskRecord = {
      taskId,
      positionKey: index,
      title: boardTask.title,
      planningState: planningState ?? "backlog",
      executionState: "unclaimed",
      type: boardTask.type ?? null,
      parentTaskId: boardTask.parent ?? null,
      priority: boardTask.priority ?? null,
      workload: boardTask.workload ?? null,
      tags: boardTask.tags ?? [],
      domains: boardTask.domains ?? boardTask.touch ?? [],
      startDate: boardTask.start ?? null,
      dueDate: boardTask.due ?? null,
      completedOn: boardTask.completed ?? null,
      externalId: boardTask.externalId ?? null,
      externalLinks: boardTask.externalLinks ?? [],
      iteration: boardTask.iteration ?? null,
      assignees: boardTask.assignees ?? [],
      milestone: boardTask.milestone ?? null,
      specMode: boardTask.specMode ?? null,
      detailPath: canonicalDetailPath,
      updatedOn: boardTask.updated ?? null
    };

    const detail: TaskDetailRecord = {
      taskId,
      role: detailFile.role,
      impact: detailFile.impact,
      estimatedEffort: detailFile.estimatedEffort,
      prerequisites: detailFile.prerequisites,
      blocking: detailFile.blocking,
      filesAffected: detailFile.filesAffected,
      testsRequired: detailFile.testsRequired,
      summary: detailFile.summary,
      descriptionGitHash: fileHash(detailPath)
    };

    const outgoingEdges: DependencyRecord[] = [
      ...(boardTask.dependsOn ?? []).map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "depends-on" as const })),
      ...detailFile.blocking.map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "blocks" as const }))
    ];

    const externalRefs: ExternalRefRecord[] = [
      ...(boardTask.externalId ? [externalRefFromId(taskId, boardTask.externalId, `${taskId}#externalId#${boardTask.externalId}`)] : []),
      ...externalRefsFromLinks(taskId, boardTask.externalLinks ?? [])
    ];

    items.push({ task, detail, outgoingEdges, externalRefs });
  });

  const project: ProjectMetadata = {
    projectId: "",
    boardTitle: board.title,
    workDomains: parseWorkDomains(board.workDomainsSection ?? []),
    notesMarkdown: joinNotesSection(board.notesSection ?? []),
    plansAuthority: "markdown"
  };

  const rawInput = fs.readFileSync(tasksFilePath, "utf8");
  const inputHash = crypto.createHash("sha256").update(rawInput, "utf8").digest("hex");

  const errors = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;

  return {
    tasksFilePath,
    tasksRoot,
    inputHash,
    taskCount: items.length,
    ids,
    project,
    tasks: items,
    issues,
    errors,
    warnings
  };
}

function emptyPlanWithIssues(tasksFilePath: string, tasksRoot: string, issues: ImportIssue[]): ImportPlan {
  return {
    tasksFilePath,
    tasksRoot,
    inputHash: "",
    taskCount: 0,
    ids: [],
    project: { projectId: "", boardTitle: "", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" },
    tasks: [],
    issues,
    errors: issues.filter(i => i.severity === "error").length,
    warnings: issues.filter(i => i.severity === "warning").length
  };
}
