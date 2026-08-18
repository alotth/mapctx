import * as fs from "fs"
import * as path from "path"
import type { DatabaseSync } from "node:sqlite"
import { generateTaskDetailFile, parseTaskDetailFile, type TaskDetailFile } from "@mapctx/core"
import { STATUS_TO_PLANNING } from "@mapctx/protocol"
import { getSingleProject, getTaskDetail, listOutgoingDependencies, listTasks } from "./projections"
import type { ProjectMetadata, TaskRecord } from "./types"

export type ExportedFile = {
  path: string;
  content: string;
};

export type ExportResult = {
  tasksMd: ExportedFile;
  taskDetailFiles: ExportedFile[];
};

const PLANNING_TO_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_TO_PLANNING).map(([status, planningState]) => [planningState, status])
);

function planningStateToStatus(planningState: string): string {
  const status = PLANNING_TO_STATUS[planningState];
  if (!status) {
    throw new Error(
      `Cannot export planningState "${planningState}": no TASKS.md status mapping exists (T-049 only ever writes states reachable through STATUS_TO_PLANNING).`
    );
  }
  return status;
}

function deriveSubIssueProgress(taskId: string, tasks: TaskRecord[]): string | null {
  const children = tasks.filter(t => t.parentTaskId === taskId);
  if (children.length === 0) return null;
  const done = children.filter(t => t.planningState === "done").length;
  return `${done}/${children.length}`;
}

function arr(items: string[]): string {
  return items.length === 0 ? "[]" : `[${items.join(", ")}]`;
}

function scalar(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "null" : value;
}

/**
 * Renders one task block with every REQUIRED_TASKS_MD_FIELDS key always
 * present (as a literal "null"/"[]" when unset), in canonical order --
 * board-tools.ts's validator (required-key + required-order checks) treats
 * a missing required key as an error even when its value would be null, so
 * a conditional/truthy emitter (as core.serializeTasksFile uses for its own,
 * looser round-trip purposes) cannot back a generated-and-validated snapshot.
 */
function renderTaskBlock(task: TaskRecord, dependsOn: string[], subIssueProgress: string | null): string {
  const lines: string[] = [];
  lines.push(`### ${task.title}`);
  lines.push("");
  lines.push(`  - id: ${task.taskId}`);
  lines.push(`  - status: ${planningStateToStatus(task.planningState)}`);
  lines.push(`  - type: ${scalar(task.type)}`);
  lines.push(`  - parent: ${scalar(task.parentTaskId)}`);
  lines.push(`  - subIssueProgress: ${scalar(subIssueProgress)}`);
  lines.push(`  - priority: ${scalar(task.priority)}`);
  lines.push(`  - workload: ${scalar(task.workload)}`);
  lines.push(`  - tags: ${arr(task.tags)}`);
  lines.push(`  - domains: ${arr(task.domains)}`);
  lines.push(`  - dependsOn: ${arr(dependsOn)}`);
  lines.push(`  - start: ${scalar(task.startDate)}`);
  lines.push(`  - due: ${scalar(task.dueDate)}`);
  lines.push(`  - completed: ${scalar(task.completedOn)}`);
  lines.push(`  - externalId: ${scalar(task.externalId)}`);
  lines.push(`  - updated: ${scalar(task.updatedOn)}`);
  lines.push(`  - detail: ${scalar(task.detailPath)}`);
  if (task.iteration) lines.push(`  - iteration: ${task.iteration}`);
  if (task.assignees.length > 0) lines.push(`  - assignees: ${arr(task.assignees)}`);
  if (task.externalLinks.length > 0) lines.push(`  - externalLinks: ${arr(task.externalLinks)}`);
  if (task.milestone) lines.push(`  - milestone: ${task.milestone}`);
  if (task.specMode) lines.push(`  - specMode: ${task.specMode}`);
  lines.push("");
  return lines.join("\n");
}

function renderTasksMd(project: ProjectMetadata, tasks: TaskRecord[], db: DatabaseSync): string {
  const out: string[] = [];
  out.push(`# ${project.boardTitle}`);
  out.push("");
  out.push("## Work Domains");
  out.push("");
  for (const domain of project.workDomains) out.push(`- ${domain.key}: ${domain.description}`);
  out.push("");
  out.push("## Tasks");
  out.push("");
  for (const task of tasks) {
    const dependsOn = listOutgoingDependencies(db, task.taskId).filter(e => e.kind === "depends-on").map(e => e.toTaskId);
    out.push(renderTaskBlock(task, dependsOn, deriveSubIssueProgress(task.taskId, tasks)));
  }
  out.push("## Notes");
  out.push("");
  if (project.notesMarkdown) {
    for (const line of project.notesMarkdown.split("\n")) out.push(line);
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Pure function over projections + Git-authored description prose. No clock,
 * no mtime, no new UUIDs: same store state + same prose bytes always yields
 * byte-identical output, which is what the drift check and checkpoint
 * determinism guarantees depend on.
 */
export function buildExport(db: DatabaseSync, options: { tasksRoot: string }): ExportResult {
  const project = getSingleProject(db);
  if (!project) {
    throw new Error("Cannot export: no project_projection row. Run `mapctx import` first.");
  }
  const tasks = listTasks(db);

  const tasksMd: ExportedFile = {
    path: path.join(options.tasksRoot, "TASKS.md"),
    content: renderTasksMd(project, tasks, db)
  };

  const taskDetailFiles: ExportedFile[] = [];
  for (const task of tasks) {
    if (!task.detailPath) continue;
    const detail = getTaskDetail(db, task.taskId);
    if (!detail) continue;
    const detailFilePath = path.resolve(options.tasksRoot, task.detailPath);
    const description = readExistingDescription(detailFilePath);
    const detailFile: TaskDetailFile = {
      id: task.taskId,
      role: detail.role,
      impact: detail.impact,
      estimatedEffort: detail.estimatedEffort,
      prerequisites: listOutgoingDependencies(db, task.taskId).filter(e => e.kind === "depends-on").map(e => e.toTaskId),
      blocking: listOutgoingDependencies(db, task.taskId).filter(e => e.kind === "blocks").map(e => e.toTaskId),
      filesAffected: detail.filesAffected,
      testsRequired: detail.testsRequired,
      summary: detail.summary,
      description
    };
    taskDetailFiles.push({ path: detailFilePath, content: generateTaskDetailFile(detailFile) });
  }

  return { tasksMd, taskDetailFiles };
}

/**
 * The description prose block is Git-authored and never reconstructed from
 * store state (T-049 durability decision). We read it back from whatever is
 * currently checked out -- on the very first export after import this is
 * still the pre-cutover file, so the prose carries over byte-for-byte.
 */
function readExistingDescription(detailFilePath: string): string {
  if (!fs.existsSync(detailFilePath)) return "";
  return parseTaskDetailFile(fs.readFileSync(detailFilePath, "utf8")).description;
}
