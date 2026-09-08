export type MigrationClass = "persist" | "derive" | "drop";

export type FieldOrigin = "TASKS.md" | "tasks/<ID>.md";

export type MigrationRule = {
  origin: FieldOrigin;
  field: string;
  destination: string;
  classification: MigrationClass;
  notes: string;
};

export const MIGRATION_MAP: readonly MigrationRule[] = [
  {
    origin: "TASKS.md",
    field: "board.title",
    destination: "Project.title",
    classification: "persist",
    notes: "Board heading becomes project title."
  },
  {
    origin: "TASKS.md",
    field: "board.workDomains",
    destination: "Project.workDomains",
    classification: "persist",
    notes: "Declared domain catalog."
  },
  {
    origin: "TASKS.md",
    field: "board.notes",
    destination: "Project.notesMarkdown",
    classification: "persist",
    notes: "Trailing notes section."
  },
  {
    origin: "TASKS.md",
    field: "id",
    destination: "Task.id / Epic.id",
    classification: "persist",
    notes: "Stable MapCtx identity. Never rewritten on import."
  },
  {
    origin: "TASKS.md",
    field: "title",
    destination: "Task.title / Epic.title",
    classification: "persist",
    notes: "Human title."
  },
  {
    origin: "TASKS.md",
    field: "status",
    destination: "Task.planningState",
    classification: "persist",
    notes: "Maps through STATUS_TO_PLANNING. executionState starts unclaimed."
  },
  {
    origin: "TASKS.md",
    field: "type",
    destination: "Task.type",
    classification: "persist",
    notes: "epic|feature|task|bug|chore."
  },
  {
    origin: "TASKS.md",
    field: "parent",
    destination: "Task.parentId",
    classification: "persist",
    notes: "Hierarchy only; not a blocker."
  },
  {
    origin: "TASKS.md",
    field: "subIssueProgress",
    destination: "derived from children completion",
    classification: "derive",
    notes: "Never stored. Recomputed from parent + child planningState."
  },
  {
    origin: "TASKS.md",
    field: "priority",
    destination: "Task.priority",
    classification: "persist",
    notes: "Planning input."
  },
  {
    origin: "TASKS.md",
    field: "workload",
    destination: "Task.workload",
    classification: "persist",
    notes: "Subjective estimate input, not a derived duration."
  },
  {
    origin: "TASKS.md",
    field: "tags",
    destination: "Task.tags",
    classification: "persist",
    notes: "Labels."
  },
  {
    origin: "TASKS.md",
    field: "domains",
    destination: "Task.domains + ResourceClaim.domains",
    classification: "persist",
    notes: "Coarse conflict keys. Seed advisory claims."
  },
  {
    origin: "TASKS.md",
    field: "touch",
    destination: "ResourceClaim.paths",
    classification: "persist",
    notes: "Deprecated alias of path claims. Imported if present."
  },
  {
    origin: "TASKS.md",
    field: "dependsOn",
    destination: "DependencyEdge(kind=depends-on)",
    classification: "persist",
    notes: "Explicit execution blockers."
  },
  {
    origin: "TASKS.md",
    field: "start",
    destination: "Task.start",
    classification: "persist",
    notes: "Planning commitment only. Not telemetry."
  },
  {
    origin: "TASKS.md",
    field: "due",
    destination: "Task.due",
    classification: "persist",
    notes: "Planning commitment only. Not telemetry."
  },
  {
    origin: "TASKS.md",
    field: "completed",
    destination: "Task.completedOn",
    classification: "persist",
    notes: "Imported if set. Future values come from planningState=done events."
  },
  {
    origin: "TASKS.md",
    field: "externalId",
    destination: "ExternalRef",
    classification: "persist",
    notes: "Parsed as provider:entity:key when possible."
  },
  {
    origin: "TASKS.md",
    field: "updated",
    destination: "Task.updatedOn",
    classification: "persist",
    notes: "Imported as-is. Future mutations write occurredAt from the event, never a bulk stamp."
  },
  {
    origin: "TASKS.md",
    field: "detail",
    destination: "Task.detailPath",
    classification: "derive",
    notes: "Canonical path ./tasks/<ID>.md. Regenerated from id."
  },
  {
    origin: "TASKS.md",
    field: "iteration",
    destination: "Task.iteration",
    classification: "persist",
    notes: "Optional timebox."
  },
  {
    origin: "TASKS.md",
    field: "assignees",
    destination: "Task.assignees",
    classification: "persist",
    notes: "Optional handles."
  },
  {
    origin: "TASKS.md",
    field: "externalLinks",
    destination: "ExternalRef[]",
    classification: "persist",
    notes: "Additional provider links."
  },
  {
    origin: "TASKS.md",
    field: "milestone",
    destination: "Task.milestone",
    classification: "persist",
    notes: "Optional delivery marker."
  },
  {
    origin: "TASKS.md",
    field: "specMode",
    destination: "Task.specMode",
    classification: "persist",
    notes: "lite|standard|strict|null."
  },
  {
    origin: "TASKS.md",
    field: "defaultExpanded",
    destination: "",
    classification: "drop",
    notes: "UI-only presentation hint. Not planning state."
  },
  {
    origin: "tasks/<ID>.md",
    field: "role",
    destination: "TaskDetail.role",
    classification: "persist",
    notes: "Structured generated block under store authority."
  },
  {
    origin: "tasks/<ID>.md",
    field: "impact",
    destination: "TaskDetail.impact",
    classification: "persist",
    notes: "Structured generated block."
  },
  {
    origin: "tasks/<ID>.md",
    field: "estimatedEffort",
    destination: "TaskDetail.estimatedEffort",
    classification: "persist",
    notes: "Subjective effort string. Not a duration measure."
  },
  {
    origin: "tasks/<ID>.md",
    field: "prerequisites",
    destination: "DependencyEdge(kind=depends-on)",
    classification: "persist",
    notes: "Must agree with TASKS.md dependsOn after import."
  },
  {
    origin: "tasks/<ID>.md",
    field: "blocking",
    destination: "DependencyEdge(kind=blocks)",
    classification: "persist",
    notes: "Inverse edges."
  },
  {
    origin: "tasks/<ID>.md",
    field: "filesAffected",
    destination: "ResourceClaim.paths",
    classification: "persist",
    notes: "Predicted write set. Advisory."
  },
  {
    origin: "tasks/<ID>.md",
    field: "testsRequired",
    destination: "TaskDetail.testsRequired",
    classification: "persist",
    notes: "Verification list."
  },
  {
    origin: "tasks/<ID>.md",
    field: "summary",
    destination: "TaskDetail.summary",
    classification: "persist",
    notes: "One-line objective."
  },
  {
    origin: "tasks/<ID>.md",
    field: "steps",
    destination: "TaskDetail.steps",
    classification: "persist",
    notes: "Legacy checklist, if present."
  },
  {
    origin: "tasks/<ID>.md",
    field: "description",
    destination: "Git-authored prose at Task.detailPath",
    classification: "persist",
    notes: "Never stored as live state. Exporter preserves bytes from checkout."
  }
] as const;

export const STATUS_TO_PLANNING: Record<string, string> = {
  backlog: "backlog",
  "ready-for-do": "ready",
  doing: "in-progress",
  review: "review",
  done: "done",
  paused: "paused"
};

export const REQUIRED_TASKS_MD_FIELDS = [
  "id",
  "status",
  "type",
  "parent",
  "subIssueProgress",
  "priority",
  "workload",
  "tags",
  "domains",
  "dependsOn",
  "start",
  "due",
  "completed",
  "externalId",
  "updated",
  "detail"
] as const;

export const OPTIONAL_TASKS_MD_FIELDS = [
  "iteration",
  "assignees",
  "externalLinks",
  "milestone",
  "specMode",
  "touch",
  "defaultExpanded"
] as const;

export const REQUIRED_DETAIL_FIELDS = [
  "role",
  "impact",
  "estimatedEffort",
  "prerequisites",
  "blocking",
  "filesAffected",
  "testsRequired",
  "summary",
  "description"
] as const;

export function migrationRuleFor(origin: FieldOrigin, field: string): MigrationRule | undefined {
  return MIGRATION_MAP.find((rule) => rule.origin === origin && rule.field === field);
}

export function assertMigrationCoverage(fields: { origin: FieldOrigin; field: string }[]): string[] {
  const missing: string[] = [];
  for (const item of fields) {
    if (!migrationRuleFor(item.origin, item.field)) {
      missing.push(`${item.origin}#${item.field}`);
    }
  }
  return missing;
}
