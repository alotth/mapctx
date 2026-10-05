import type { DatabaseSync } from "node:sqlite"
import {
  assertTransition,
  type Account,
  type Budget,
  type ClaimViolation,
  type CostEvent,
  type EstimateSnapshot,
  type PlanPeriod,
  type RunEvent,
  type RunReceipt,
  type UsageEvent
} from "@mapctx/protocol"
import type {
  AcceptanceCondition,
  AcceptanceCriterionRecord,
  AcceptanceCriterionState,
  AcceptanceRevisionRecord,
  DependencyRecord,
  EventRevision,
  ExternalRefRecord,
  ProjectMetadata,
  ResourceClaimRecord,
  ResourceClaimState,
  TaskDetailRecord,
  TaskRecord,
  TaskSearchFilter,
  TaskSearchHit,
  WorkDomain,
  WorkloadDeltaRow,
  DispatchAttemptRecord
} from "./types"

function nullableStr(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

// ---- project_projection ----

export function upsertProject(db: DatabaseSync, meta: ProjectMetadata): void {
  db.prepare(`
    INSERT INTO project_projection (project_id, board_title, work_domains_json, notes_markdown, plans_authority, source_snapshot_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      board_title = excluded.board_title,
      work_domains_json = excluded.work_domains_json,
      notes_markdown = excluded.notes_markdown,
      plans_authority = excluded.plans_authority,
      source_snapshot_hash = excluded.source_snapshot_hash
  `).run(
    meta.projectId,
    meta.boardTitle,
    JSON.stringify(meta.workDomains),
    meta.notesMarkdown,
    meta.plansAuthority,
    meta.sourceSnapshotHash ?? null
  );
}

export function getProject(db: DatabaseSync, projectId: string): ProjectMetadata | undefined {
  const row = db.prepare("SELECT * FROM project_projection WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    projectId: row.project_id as string,
    boardTitle: row.board_title as string,
    workDomains: JSON.parse(row.work_domains_json as string) as WorkDomain[],
    notesMarkdown: row.notes_markdown as string,
    plansAuthority: row.plans_authority as "markdown" | "store",
    sourceSnapshotHash: (row.source_snapshot_hash as string | null) ?? null
  };
}

export function getSingleProject(db: DatabaseSync): ProjectMetadata | undefined {
  const row = db.prepare("SELECT project_id FROM project_projection LIMIT 1").get() as { project_id: string } | undefined;
  if (!row) return undefined;
  return getProject(db, row.project_id);
}

// ---- task_projection ----

export function upsertTask(db: DatabaseSync, task: TaskRecord, revision: EventRevision): void {
  // Shared mutation/replay boundary also covers import and reconcile upserts.
  const visited = new Set([task.taskId]);
  let ancestor = task.parentTaskId;
  while (ancestor) {
    if (visited.has(ancestor)) throw new Error(`Parent cycle detected for ${task.taskId}: ${ancestor}`);
    visited.add(ancestor);
    ancestor = getTask(db, ancestor)?.parentTaskId;
  }
  db.prepare(`
    INSERT INTO task_projection (
      task_id, position_key, title, planning_state, execution_state, type, parent_task_id,
      priority, workload, tags_json, domains_json, start_date, due_date, predicted_start,
      predicted_method, predicted_confidence, completed_on,
      external_id, external_links_json, iteration, assignees_json, milestone, spec_mode,
      detail_path, updated_on, revision_event_node, revision_event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      position_key = excluded.position_key,
      title = excluded.title,
      planning_state = excluded.planning_state,
      execution_state = excluded.execution_state,
      type = excluded.type,
      parent_task_id = excluded.parent_task_id,
      priority = excluded.priority,
      workload = excluded.workload,
      tags_json = excluded.tags_json,
      domains_json = excluded.domains_json,
      start_date = excluded.start_date,
      due_date = excluded.due_date,
      predicted_start = excluded.predicted_start,
      predicted_method = excluded.predicted_method,
      predicted_confidence = excluded.predicted_confidence,
      completed_on = excluded.completed_on,
      external_id = excluded.external_id,
      external_links_json = excluded.external_links_json,
      iteration = excluded.iteration,
      assignees_json = excluded.assignees_json,
      milestone = excluded.milestone,
      spec_mode = excluded.spec_mode,
      detail_path = excluded.detail_path,
      updated_on = excluded.updated_on,
      revision_event_node = excluded.revision_event_node,
      revision_event_sequence = excluded.revision_event_sequence
  `).run(
    task.taskId,
    task.positionKey,
    task.title,
    task.planningState,
    task.executionState,
    nullableStr(task.type),
    nullableStr(task.parentTaskId),
    nullableStr(task.priority),
    nullableStr(task.workload),
    JSON.stringify(task.tags ?? []),
    JSON.stringify(task.domains ?? []),
    nullableStr(task.startDate),
    nullableStr(task.dueDate),
    nullableStr(task.predictedStart?.start),
    nullableStr(task.predictedStart?.method),
    nullableStr(task.predictedStart?.confidence),
    nullableStr(task.completedOn),
    nullableStr(task.externalId),
    JSON.stringify(task.externalLinks ?? []),
    nullableStr(task.iteration),
    JSON.stringify(task.assignees ?? []),
    nullableStr(task.milestone),
    nullableStr(task.specMode),
    nullableStr(task.detailPath),
    nullableStr(task.updatedOn),
    revision.node,
    revision.sequence
  );
}

export function patchTask(db: DatabaseSync, taskId: string, patch: Partial<TaskRecord>, revision: EventRevision): void {
  const current = getTask(db, taskId);
  if (!current) {
    throw new Error(`Cannot patch unknown task: ${taskId}`);
  }
  const merged: TaskRecord = { ...current, ...patch, taskId };
  upsertTask(db, merged, revision);
}

export function getTask(db: DatabaseSync, taskId: string): TaskRecord | undefined {
  const row = db.prepare("SELECT * FROM task_projection WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToTask(row);
}

export function listTasks(db: DatabaseSync): TaskRecord[] {
  const rows = db.prepare("SELECT * FROM task_projection ORDER BY position_key ASC, task_id ASC").all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function filterTaskSearchHits(hits: TaskSearchHit[], options: TaskSearchFilter): TaskSearchHit[] {
  const terms = foldSearchText(options.query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : 20;
  const ranked: { hit: TaskSearchHit; rank: number }[] = [];
  for (const hit of hits) {
    if (options.status && hit.planningState !== options.status) continue;
    const foldedTitle = foldSearchText(hit.title);
    const haystack = [
      foldedTitle,
      foldSearchText(hit.tags.join(" ")),
      foldSearchText(hit.domains.join(" ")),
      foldSearchText(hit.summary ?? "")
    ].join("\n");
    if (!terms.every(term => haystack.includes(term))) continue;
    ranked.push({ hit, rank: terms.every(term => foldedTitle.includes(term)) ? 0 : 1 });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, limit).map(entry => entry.hit);
}

export function searchTasks(db: DatabaseSync, options: TaskSearchFilter): TaskSearchHit[] {
  const rows = db.prepare(`
    SELECT t.task_id, t.title, t.planning_state, t.completed_on, t.tags_json, t.domains_json, d.summary
    FROM task_projection t
    LEFT JOIN task_detail_projection d ON d.task_id = t.task_id
    ORDER BY t.position_key ASC, t.task_id ASC
  `).all() as Record<string, unknown>[];
  const hits: TaskSearchHit[] = rows.map(row => ({
    taskId: row.task_id as string,
    title: row.title as string,
    planningState: row.planning_state as string,
    completedOn: (row.completed_on as string | null) ?? null,
    tags: JSON.parse(row.tags_json as string),
    domains: JSON.parse(row.domains_json as string),
    summary: (row.summary as string | null) ?? null
  }));
  return filterTaskSearchHits(hits, options);
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    taskId: row.task_id as string,
    positionKey: row.position_key as number,
    title: row.title as string,
    planningState: row.planning_state as string,
    executionState: row.execution_state as string,
    type: row.type as string | null,
    parentTaskId: row.parent_task_id as string | null,
    priority: row.priority as string | null,
    workload: row.workload as string | null,
    tags: JSON.parse(row.tags_json as string),
    domains: JSON.parse(row.domains_json as string),
    startDate: row.start_date as string | null,
    dueDate: row.due_date as string | null,
    // Pre-T-102 rows (migration 8 not yet applied) read as no prediction.
    predictedStart: (row.predicted_start as string | null | undefined)
      ? ({
          start: row.predicted_start as string,
          method: ((row.predicted_method as string | null | undefined) ?? "manual") as "manual" | "heuristic" | "model",
          confidence: ((row.predicted_confidence as string | null | undefined) ?? "low") as "low" | "medium" | "high"
        })
      : null,
    completedOn: row.completed_on as string | null,
    externalId: row.external_id as string | null,
    externalLinks: JSON.parse(row.external_links_json as string),
    iteration: row.iteration as string | null,
    assignees: JSON.parse(row.assignees_json as string),
    milestone: row.milestone as string | null,
    specMode: row.spec_mode as string | null,
    detailPath: row.detail_path as string | null,
    updatedOn: row.updated_on as string | null
  };
}

// ---- task_detail_projection ----

export function upsertTaskDetail(db: DatabaseSync, detail: TaskDetailRecord): void {
  db.prepare(`
    INSERT INTO task_detail_projection (
      task_id, role, impact, estimated_effort, estimated_effort_source, wait_reason, prerequisites_json, blocking_json,
      files_affected_json, tests_required_json, summary, description_git_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      role = excluded.role,
      impact = excluded.impact,
      estimated_effort = excluded.estimated_effort,
      estimated_effort_source = excluded.estimated_effort_source,
      wait_reason = excluded.wait_reason,
      prerequisites_json = excluded.prerequisites_json,
      blocking_json = excluded.blocking_json,
      files_affected_json = excluded.files_affected_json,
      tests_required_json = excluded.tests_required_json,
      summary = excluded.summary,
      description_git_hash = excluded.description_git_hash
  `).run(
    detail.taskId,
    detail.role,
    detail.impact,
    detail.estimatedEffort,
    detail.estimatedEffortSource === "agent-active" ? "agent-active" : null,
    detail.waitReason ?? null,
    JSON.stringify(detail.prerequisites ?? []),
    JSON.stringify(detail.blocking ?? []),
    JSON.stringify(detail.filesAffected ?? []),
    JSON.stringify(detail.testsRequired ?? []),
    detail.summary,
    detail.descriptionGitHash ?? null
  );
}

export function getTaskDetail(db: DatabaseSync, taskId: string): TaskDetailRecord | undefined {
  const row = db.prepare("SELECT * FROM task_detail_projection WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    taskId: row.task_id as string,
    role: row.role as string,
    impact: row.impact as string,
    estimatedEffort: row.estimated_effort as string,
    ...(row.estimated_effort_source === "agent-active" ? { estimatedEffortSource: "agent-active" as const } : {}),
    ...(row.wait_reason ? { waitReason: row.wait_reason as TaskDetailRecord["waitReason"] } : {}),
    prerequisites: JSON.parse(row.prerequisites_json as string),
    blocking: JSON.parse(row.blocking_json as string),
    filesAffected: JSON.parse(row.files_affected_json as string),
    testsRequired: JSON.parse(row.tests_required_json as string),
    summary: row.summary as string,
    descriptionGitHash: (row.description_git_hash as string | null) ?? null
  };
}

// ---- dependency_projection ----

export function replaceOutgoingDependencies(db: DatabaseSync, fromTaskId: string, edges: DependencyRecord[]): void {
  db.prepare("DELETE FROM dependency_projection WHERE from_task_id = ?").run(fromTaskId);
  const insert = db.prepare("INSERT INTO dependency_projection (from_task_id, to_task_id, kind) VALUES (?, ?, ?)");
  for (const edge of edges) {
    insert.run(edge.fromTaskId, edge.toTaskId, edge.kind);
  }
}

export function listDependencies(db: DatabaseSync): DependencyRecord[] {
  const rows = db.prepare("SELECT from_task_id, to_task_id, kind FROM dependency_projection ORDER BY from_task_id, kind, to_task_id").all() as Record<string, unknown>[];
  return rows.map(row => ({
    fromTaskId: row.from_task_id as string,
    toTaskId: row.to_task_id as string,
    kind: row.kind as DependencyRecord["kind"]
  }));
}

export function listOutgoingDependencies(db: DatabaseSync, fromTaskId: string): DependencyRecord[] {
  return listDependencies(db).filter(edge => edge.fromTaskId === fromTaskId);
}

// ---- external_ref_projection ----

export function replaceOwnerExternalRefs(db: DatabaseSync, ownerKind: string, ownerId: string, refs: ExternalRefRecord[]): void {
  db.prepare("DELETE FROM external_ref_projection WHERE owner_kind = ? AND owner_id = ?").run(ownerKind, ownerId);
  const insert = db.prepare(`
    INSERT INTO external_ref_projection (ref_id, owner_kind, owner_id, provider, entity_kind, external_key, uri, metadata_json, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ref of refs) {
    insert.run(ref.refId, ref.ownerKind, ref.ownerId, ref.provider, ref.entityKind, ref.externalKey, ref.uri, JSON.stringify(ref.metadata ?? {}), ref.verified ? 1 : 0);
  }
}

export function listExternalRefsForOwner(db: DatabaseSync, ownerKind: string, ownerId: string): ExternalRefRecord[] {
  const rows = db.prepare("SELECT * FROM external_ref_projection WHERE owner_kind = ? AND owner_id = ?").all(ownerKind, ownerId) as Record<string, unknown>[];
  return rows.map(row => ({
    refId: row.ref_id as string,
    ownerKind: row.owner_kind as ExternalRefRecord["ownerKind"],
    ownerId: row.owner_id as string,
    provider: row.provider as string,
    entityKind: row.entity_kind as string,
    externalKey: row.external_key as string,
    uri: row.uri as string,
    metadata: JSON.parse(row.metadata_json as string),
    verified: Boolean(row.verified)
  }));
}

// ---- resource_claim_projection ----

export function insertClaim(db: DatabaseSync, claim: ResourceClaimRecord): void {
  db.prepare(`
    INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    claim.claimId,
    claim.taskId,
    claim.leaseToken,
    claim.state,
    claim.claimedAt,
    claim.expiresAt,
    JSON.stringify(claim.holder ?? {}),
    claim.eventNode,
    claim.eventSequence
  );
}

export function updateClaimState(db: DatabaseSync, claimId: string, state: ResourceClaimState, expiresAt?: string): void {
  if (expiresAt !== undefined) {
    db.prepare("UPDATE resource_claim_projection SET state = ?, expires_at = ? WHERE claim_id = ?").run(state, expiresAt, claimId);
  } else {
    db.prepare("UPDATE resource_claim_projection SET state = ? WHERE claim_id = ?").run(state, claimId);
  }
}

export function getActiveClaimForTask(db: DatabaseSync, taskId: string): ResourceClaimRecord | undefined {
  const row = db.prepare("SELECT * FROM resource_claim_projection WHERE task_id = ? AND state = 'active'").get(taskId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToClaim(row);
}

export function getClaim(db: DatabaseSync, claimId: string): ResourceClaimRecord | undefined {
  const row = db.prepare("SELECT * FROM resource_claim_projection WHERE claim_id = ?").get(claimId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToClaim(row);
}

function rowToClaim(row: Record<string, unknown>): ResourceClaimRecord {
  return {
    claimId: row.claim_id as string,
    taskId: row.task_id as string,
    leaseToken: row.lease_token as string,
    state: row.state as ResourceClaimState,
    claimedAt: row.claimed_at as string,
    expiresAt: row.expires_at as string,
    holder: JSON.parse(row.holder_json as string),
    eventNode: row.event_node as string,
    eventSequence: row.event_sequence as number
  };
}

// ---- dispatch_projection / run_receipt_projection ----

export function insertDispatchAttempt(db: DatabaseSync, dispatch: DispatchAttemptRecord): void {
  db.prepare(`
    INSERT INTO dispatch_projection (dispatch_id, task_id, executor_kind, attempt, context_hash, status, workload_at_dispatch, executor_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dispatch_id, attempt) DO UPDATE SET
      task_id = excluded.task_id,
      executor_kind = excluded.executor_kind,
      context_hash = excluded.context_hash,
      status = excluded.status,
      workload_at_dispatch = excluded.workload_at_dispatch,
      executor_model = excluded.executor_model
  `).run(
    dispatch.dispatchId,
    dispatch.taskId,
    dispatch.executorKind,
    dispatch.attempt,
    dispatch.contextHash,
    dispatch.status,
    dispatch.workloadAtDispatch ?? null,
    dispatch.executorModel ?? null
  );
}

export function getDispatchAttempt(db: DatabaseSync, dispatchId: string, attempt: number): DispatchAttemptRecord | undefined {
  const row = db.prepare("SELECT * FROM dispatch_projection WHERE dispatch_id = ? AND attempt = ?").get(dispatchId, attempt) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToDispatchAttempt(row);
}

export function listDispatchAttempts(db: DatabaseSync, dispatchId?: string, taskId?: string): DispatchAttemptRecord[] {
  let sql = "SELECT * FROM dispatch_projection";
  const args: string[] = [];
  if (dispatchId !== undefined) {
    sql += " WHERE dispatch_id = ?";
    args.push(dispatchId);
  } else if (taskId !== undefined) {
    sql += " WHERE task_id = ?";
    args.push(taskId);
  }
  sql += " ORDER BY dispatch_id ASC, attempt ASC";
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(rowToDispatchAttempt);
}

function rowToDispatchAttempt(row: Record<string, unknown>): DispatchAttemptRecord {
  return {
    dispatchId: row.dispatch_id as string,
    taskId: row.task_id as string,
    executorKind: row.executor_kind as string,
    attempt: row.attempt as number,
    contextHash: row.context_hash as string,
    status: row.status as DispatchAttemptRecord["status"],
    workloadAtDispatch: (row.workload_at_dispatch as string | null) ?? null,
    executorModel: (row.executor_model as string | null) ?? null
  };
}

function updateDispatchStatus(db: DatabaseSync, dispatchId: string, attempt: number, status: DispatchAttemptRecord["status"]): void {
  db.prepare("UPDATE dispatch_projection SET status = ? WHERE dispatch_id = ? AND attempt = ?").run(status, dispatchId, attempt);
}

export function insertRunReceipt(db: DatabaseSync, receipt: RunReceipt, workloadAtReceipt: string | null = null): void {
  db.prepare(`
    INSERT INTO run_receipt_projection (
      dispatch_id, attempt, schema_version, outcome, started_at, ended_at,
      changed_files_json, usage_events_json, evidence_json, failure_json, receipt_json,
      workload_at_receipt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.dispatchId,
    receipt.attempt,
    receipt.schemaVersion,
    receipt.outcome,
    receipt.startedAt,
    receipt.endedAt,
    JSON.stringify(receipt.changedFiles),
    JSON.stringify(receipt.usageEvents),
    JSON.stringify(receipt.evidence),
    receipt.failure === null ? null : JSON.stringify(receipt.failure),
    JSON.stringify(receipt),
    workloadAtReceipt
  );

  const insertUsage = db.prepare(`
    INSERT INTO usage_event_projection (
      usage_event_id, dispatch_id, provider, model, input_tokens, cache_tokens,
      output_tokens, source, coverage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const usage of receipt.usageEvents) {
    insertUsage.run(
      usage.usageEventId,
      usage.dispatchId,
      usage.provider,
      usage.model,
      usage.inputTokens,
      usage.cacheTokens,
      usage.outputTokens,
      usage.source,
      usage.coverage
    );
  }
}

export function getUsageEvent(db: DatabaseSync, usageEventId: string): UsageEvent | undefined {
  const row = db.prepare("SELECT * FROM usage_event_projection WHERE usage_event_id = ?").get(usageEventId) as Record<string, unknown> | undefined
  return row ? rowToUsageEvent(row) : undefined
}

export function listUsageEvents(db: DatabaseSync, dispatchId?: string, taskId?: string): UsageEvent[] {
  let sql = "SELECT u.* FROM usage_event_projection u"
  const args: string[] = []
  if (taskId !== undefined) {
    sql += " JOIN dispatch_projection d ON d.dispatch_id = u.dispatch_id WHERE d.task_id = ?"
    args.push(taskId)
  } else if (dispatchId !== undefined) {
    sql += " WHERE u.dispatch_id = ?"
    args.push(dispatchId)
  }
  sql += " ORDER BY u.dispatch_id ASC, u.usage_event_id ASC"
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToUsageEvent)
}

function rowToUsageEvent(row: Record<string, unknown>): UsageEvent {
  return {
    usageEventId: row.usage_event_id as string,
    dispatchId: row.dispatch_id as string,
    provider: row.provider as string,
    model: row.model as string,
    inputTokens: row.input_tokens as number,
    cacheTokens: row.cache_tokens as number,
    outputTokens: row.output_tokens as number,
    source: row.source as UsageEvent["source"],
    coverage: row.coverage as UsageEvent["coverage"]
  }
}

export function insertCostEvent(db: DatabaseSync, cost: CostEvent): void {
  db.prepare(`
    INSERT INTO cost_event_projection (
      cost_event_id, dispatch_id, usage_event_id, billing_type, cost_status,
      cash_cents, shadow_micros, allocated_micros, plan_period_id,
      price_table_version, applied_rate_micros_per_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cost.costEventId,
    cost.dispatchId,
    cost.usageEventId,
    cost.billingType,
    cost.costStatus,
    cost.cashCents,
    cost.shadowMicros,
    cost.allocatedMicros,
    cost.planPeriodId,
    cost.priceTableVersion,
    cost.appliedRateMicrosPerToken
  )
}

export function getCostEvent(db: DatabaseSync, costEventId: string): CostEvent | undefined {
  const row = db.prepare("SELECT * FROM cost_event_projection WHERE cost_event_id = ?").get(costEventId) as Record<string, unknown> | undefined
  return row ? rowToCostEvent(row) : undefined
}

export function listCostEvents(db: DatabaseSync, dispatchId?: string, taskId?: string): CostEvent[] {
  let sql = "SELECT c.* FROM cost_event_projection c"
  const args: string[] = []
  if (taskId !== undefined) {
    sql += " JOIN dispatch_projection d ON d.dispatch_id = c.dispatch_id WHERE d.task_id = ?"
    args.push(taskId)
  } else if (dispatchId !== undefined) {
    sql += " WHERE c.dispatch_id = ?"
    args.push(dispatchId)
  }
  sql += " ORDER BY c.dispatch_id ASC, c.cost_event_id ASC"
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToCostEvent)
}

function rowToCostEvent(row: Record<string, unknown>): CostEvent {
  return {
    costEventId: row.cost_event_id as string,
    dispatchId: row.dispatch_id as string,
    usageEventId: (row.usage_event_id as string | null) ?? null,
    billingType: row.billing_type as CostEvent["billingType"],
    costStatus: row.cost_status as CostEvent["costStatus"],
    cashCents: row.cash_cents as number,
    shadowMicros: row.shadow_micros as number,
    allocatedMicros: (row.allocated_micros as number | null) ?? null,
    planPeriodId: (row.plan_period_id as string | null) ?? null,
    priceTableVersion: row.price_table_version as string,
    appliedRateMicrosPerToken: row.applied_rate_micros_per_token as number
  }
}

export function insertPlanPeriod(db: DatabaseSync, period: PlanPeriod): void {
  db.prepare(`
    INSERT INTO plan_period_projection (
      plan_period_id, account_id, biller, plan_name, period_start, period_end,
      fixed_cents, seats, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_period_id) DO UPDATE SET
      account_id = excluded.account_id,
      biller = excluded.biller,
      plan_name = excluded.plan_name,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      fixed_cents = excluded.fixed_cents,
      seats = excluded.seats,
      status = excluded.status
  `).run(period.planPeriodId, period.accountId ?? null, period.biller, period.planName, period.periodStart, period.periodEnd, period.fixedCents, period.seats, period.status)
}

export function getPlanPeriod(db: DatabaseSync, planPeriodId: string): PlanPeriod | undefined {
  const row = db.prepare("SELECT * FROM plan_period_projection WHERE plan_period_id = ?").get(planPeriodId) as Record<string, unknown> | undefined
  return row ? rowToPlanPeriod(row) : undefined
}

export function listPlanPeriods(db: DatabaseSync, accountId?: string): PlanPeriod[] {
  const sql = accountId === undefined
    ? "SELECT * FROM plan_period_projection ORDER BY period_start ASC, plan_period_id ASC"
    : "SELECT * FROM plan_period_projection WHERE account_id = ? ORDER BY period_start ASC, plan_period_id ASC"
  const rows = (accountId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(accountId)) as Record<string, unknown>[]
  return rows.map(rowToPlanPeriod)
}

function rowToPlanPeriod(row: Record<string, unknown>): PlanPeriod {
  return {
    planPeriodId: row.plan_period_id as string,
    accountId: (row.account_id as string | null) ?? undefined,
    biller: row.biller as string,
    planName: row.plan_name as string,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    fixedCents: row.fixed_cents as number,
    seats: row.seats as number,
    status: row.status as PlanPeriod["status"]
  }
}

// ---- account_projection (T-070) ----

export function insertAccount(db: DatabaseSync, account: Account): void {
  db.prepare(`
    INSERT INTO account_projection (account_id, name, currency, created_at, note)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      name = excluded.name,
      currency = excluded.currency,
      created_at = excluded.created_at,
      note = excluded.note
  `).run(account.accountId, account.name, account.currency, account.createdAt, account.note)
}

export function getAccount(db: DatabaseSync, accountId: string): Account | undefined {
  const row = db.prepare("SELECT * FROM account_projection WHERE account_id = ?").get(accountId) as Record<string, unknown> | undefined
  return row ? rowToAccount(row) : undefined
}

export function listAccounts(db: DatabaseSync): Account[] {
  const rows = db.prepare("SELECT * FROM account_projection ORDER BY created_at ASC, account_id ASC").all() as Record<string, unknown>[]
  return rows.map(rowToAccount)
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    accountId: row.account_id as string,
    name: row.name as string,
    currency: row.currency as string,
    createdAt: row.created_at as string,
    note: (row.note as string | null) ?? null
  }
}

/**
 * Replace-all declaration of which accounts a project draws from (the same
 * replace semantics as dependency edges): each project declares its account
 * set in one event, so the projection is always exactly the last declaration.
 */
export function setProjectAccountBindings(db: DatabaseSync, projectId: string, accountIds: string[], logicalClock: number): void {
  db.prepare("DELETE FROM project_account_binding WHERE project_id = ?").run(projectId);
  const insert = db.prepare("INSERT INTO project_account_binding (project_id, account_id, logical_clock) VALUES (?, ?, ?)");
  for (const accountId of [...accountIds].sort()) {
    insert.run(projectId, accountId, logicalClock);
  }
}

export function listProjectAccountIds(db: DatabaseSync, projectId: string): string[] {
  const rows = db.prepare("SELECT account_id FROM project_account_binding WHERE project_id = ? ORDER BY account_id ASC").all(projectId) as Array<{ account_id: string }>;
  return rows.map(row => row.account_id);
}

// ---- budget_projection (T-070) ----

/**
 * Every budget.set appends a row: revisions/top-ups stay queryable as
 * history. `logicalClock` is the setting event's logical clock, so
 * latest-wins resolution is event-order-correct even for same-instant sets.
 */
export function insertBudget(db: DatabaseSync, budget: Budget, logicalClock: number): void {
  db.prepare(`
    INSERT INTO budget_projection (
      budget_id, owner_kind, owner_id, unit, money_json, minutes,
      period_start, period_end, set_at, note, logical_clock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    budget.budgetId,
    budget.ownerKind,
    budget.ownerId,
    budget.unit,
    budget.money === null ? null : JSON.stringify(budget.money),
    budget.minutes,
    budget.periodStart,
    budget.periodEnd,
    budget.setAt,
    budget.note,
    logicalClock
  )
}

export function getBudget(db: DatabaseSync, budgetId: string): Budget | undefined {
  const row = db.prepare("SELECT * FROM budget_projection WHERE budget_id = ?").get(budgetId) as Record<string, unknown> | undefined
  return row ? rowToBudget(row) : undefined
}

export function listBudgets(db: DatabaseSync, ownerKind?: string, ownerId?: string): Budget[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (ownerKind !== undefined) { clauses.push("owner_kind = ?"); args.push(ownerKind); }
  if (ownerId !== undefined) { clauses.push("owner_id = ?"); args.push(ownerId); }
  let sql = "SELECT * FROM budget_projection";
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY logical_clock ASC, budget_id ASC";
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(rowToBudget);
}

/** Latest budget for an owner: max event logical clock, deterministic tiebreak on id. */
export function getLatestBudgetFor(db: DatabaseSync, ownerKind: string, ownerId: string): Budget | undefined {
  const rows = db.prepare(
    "SELECT * FROM budget_projection WHERE owner_kind = ? AND owner_id = ? ORDER BY logical_clock DESC, budget_id DESC LIMIT 1"
  ).all(ownerKind, ownerId) as Record<string, unknown>[];
  return rows.length > 0 ? rowToBudget(rows[0]) : undefined;
}

function rowToBudget(row: Record<string, unknown>): Budget {
  const moneyJson = row.money_json as string | null;
  return {
    budgetId: row.budget_id as string,
    ownerKind: row.owner_kind as Budget["ownerKind"],
    ownerId: row.owner_id as string,
    unit: row.unit as Budget["unit"],
    money: moneyJson === null ? null : JSON.parse(moneyJson),
    minutes: (row.minutes as number | null) ?? null,
    periodStart: (row.period_start as string | null) ?? null,
    periodEnd: (row.period_end as string | null) ?? null,
    setAt: row.set_at as string,
    note: (row.note as string | null) ?? null
  }
}

export function insertEstimateSnapshot(db: DatabaseSync, snapshot: EstimateSnapshot): void {
  db.prepare(`
    INSERT INTO estimate_snapshot_projection (estimate_id, task_id, created_at, method, confidence, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(snapshot.estimateId, snapshot.taskId, snapshot.createdAt, snapshot.method, snapshot.confidence, JSON.stringify(snapshot))
}

export function getEstimateSnapshot(db: DatabaseSync, estimateId: string): EstimateSnapshot | undefined {
  const row = db.prepare("SELECT payload_json FROM estimate_snapshot_projection WHERE estimate_id = ?").get(estimateId) as { payload_json: string } | undefined
  return row ? JSON.parse(row.payload_json) as EstimateSnapshot : undefined
}

export function listEstimateSnapshots(db: DatabaseSync, taskId?: string): EstimateSnapshot[] {
  const sql = taskId === undefined
    ? "SELECT payload_json FROM estimate_snapshot_projection ORDER BY created_at ASC, estimate_id ASC"
    : "SELECT payload_json FROM estimate_snapshot_projection WHERE task_id = ? ORDER BY created_at ASC, estimate_id ASC"
  const rows = (taskId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(taskId)) as Array<{ payload_json: string }>
  return rows.map(row => JSON.parse(row.payload_json) as EstimateSnapshot)
}

export function getRunReceipt(db: DatabaseSync, dispatchId: string, attempt: number): RunReceipt | undefined {
  const row = db.prepare("SELECT receipt_json FROM run_receipt_projection WHERE dispatch_id = ? AND attempt = ?").get(dispatchId, attempt) as { receipt_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.receipt_json) as RunReceipt;
}

/** Append-only projection of every schema-valid executor event. */
export function insertRunEvent(db: DatabaseSync, event: RunEvent): void {
  db.prepare(`
    INSERT INTO run_event_projection (
      dispatch_id, attempt, sequence, schema_version, type, timestamp, payload_json, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.dispatchId,
    event.attempt,
    event.sequence,
    event.schemaVersion,
    event.type,
    event.timestamp,
    JSON.stringify(event.payload),
    JSON.stringify(event)
  );
}

export function getRunEvent(db: DatabaseSync, dispatchId: string, attempt: number, sequence: number): RunEvent | undefined {
  const row = db.prepare(
    "SELECT event_json FROM run_event_projection WHERE dispatch_id = ? AND attempt = ? AND sequence = ?"
  ).get(dispatchId, attempt, sequence) as { event_json: string } | undefined;
  return row ? JSON.parse(row.event_json) as RunEvent : undefined;
}

export function listRunEvents(db: DatabaseSync, dispatchId?: string, attempt?: number): RunEvent[] {
  let sql = "SELECT event_json FROM run_event_projection";
  const args: (string | number)[] = [];
  if (dispatchId !== undefined) {
    sql += " WHERE dispatch_id = ?";
    args.push(dispatchId);
    if (attempt !== undefined) {
      sql += " AND attempt = ?";
      args.push(attempt);
    }
  } else if (attempt !== undefined) {
    sql += " WHERE attempt = ?";
    args.push(attempt);
  }
  sql += " ORDER BY dispatch_id ASC, attempt ASC, sequence ASC";
  const rows = db.prepare(sql).all(...args) as Array<{ event_json: string }>;
  return rows.map(row => JSON.parse(row.event_json) as RunEvent);
}

export function listRunReceipts(db: DatabaseSync, dispatchId?: string, taskId?: string): RunReceipt[] {
  let sql = `
    SELECT r.receipt_json
    FROM run_receipt_projection r
    LEFT JOIN dispatch_projection d ON d.dispatch_id = r.dispatch_id AND d.attempt = r.attempt
  `;
  const args: string[] = [];
  if (dispatchId !== undefined) {
    sql += " WHERE r.dispatch_id = ?";
    args.push(dispatchId);
  } else if (taskId !== undefined) {
    sql += " WHERE d.task_id = ?";
    args.push(taskId);
  }
  sql += " ORDER BY r.dispatch_id ASC, json_extract(r.receipt_json, '$.attempt') ASC";
  const rows = db.prepare(sql).all(...args) as Array<{ receipt_json: string }>;
  return rows.map(row => JSON.parse(row.receipt_json) as RunReceipt);
}

export function applyRunReceipt(db: DatabaseSync, receipt: RunReceipt, revision: EventRevision, workloadAtReceipt: string | null = null): void {
  const dispatch = getDispatchAttempt(db, receipt.dispatchId, receipt.attempt);
  if (!dispatch) throw new Error(`Cannot record receipt for unknown dispatch attempt: ${receipt.dispatchId}/${receipt.attempt}`);
  const task = getTask(db, dispatch.taskId);
  if (!task) throw new Error(`Cannot record receipt for unknown task: ${dispatch.taskId}`);

  const targetExecution = receipt.outcome;
  let currentExecution = task.executionState;
  let currentDispatch = dispatch.status;
  if (currentDispatch === "claimed") {
    assertTransition("dispatch", currentDispatch, "running");
    currentDispatch = "running";
    if (currentExecution !== "running") {
      assertTransition("execution", currentExecution, "running");
      currentExecution = "running";
      patchTask(db, task.taskId, { executionState: currentExecution }, revision);
    }
  }
  assertTransition("dispatch", currentDispatch, targetExecution);
  assertTransition("execution", currentExecution, targetExecution);
  updateDispatchStatus(db, receipt.dispatchId, receipt.attempt, targetExecution);

  const taskPatch: Partial<TaskRecord> = { executionState: targetExecution };
  // R9: a blocked RUN is recorded (dispatch + execution carry blocked), but
  // the planning projection must stay exportable: "blocked" has no TASKS.md
  // status vocabulary (see EXPORTABLE_PLANNING_STATES in tasks.ts), so moving
  // planning there would make every export/validate fail closed. The blocked
  // attempt is fully visible in the store; planning stays where the operator
  // left it until an explicit move.
  const targetPlanning = targetExecution === "completed"
    ? "review"
    : targetExecution === "failed"
      ? (task.planningState === "in-progress" || task.planningState === "blocked" ? "ready" : undefined)
      : undefined;
  if (targetPlanning !== undefined && task.planningState !== targetPlanning) {
    // T-118: no admission re-adjudication on the shared applier. The FSM
    // legality of a receipt's planning move is checked where NEW receipts are
    // admitted (dispatch.ts validateReceiptTransition); here the journal event
    // is an immutable historical fact -- replays of pre-machine history (e.g.
    // a receipt completed while the task was already archived) must project
    // what was recorded, not be rejected by today's rules.
    taskPatch.planningState = targetPlanning;
  }
  patchTask(db, task.taskId, taskPatch, revision);
  insertRunReceipt(db, receipt, workloadAtReceipt);
}

// ---- T-071 workload delta (planned vs discovered) ----

/**
 * One accepted receipt per row, joined with its workload stamps and the task's
 * CURRENT workload. Deterministic order: dispatch_id ASC, attempt ASC. This is
 * the raw material for the estimation-error aggregate; the last-wins pooling
 * key is `currentWorkload` (a later re-classification re-attributes the
 * actual), while `plannedWorkload` keeps the at-hand-off guess frozen.
 */
export function listWorkloadDeltaRows(db: DatabaseSync, taskId?: string): WorkloadDeltaRow[] {
  let sql = `
    SELECT r.dispatch_id, r.attempt, r.started_at, r.ended_at,
           d.workload_at_dispatch, d.executor_model, r.workload_at_receipt,
           d.task_id, t.workload AS current_workload
    FROM run_receipt_projection r
    JOIN dispatch_projection d ON d.dispatch_id = r.dispatch_id AND d.attempt = r.attempt
    JOIN task_projection t ON t.task_id = d.task_id
  `;
  const args: string[] = [];
  if (taskId !== undefined) {
    sql += " WHERE d.task_id = ?";
    args.push(taskId);
  }
  sql += " ORDER BY r.dispatch_id ASC, r.attempt ASC";
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(row => ({
    dispatchId: row.dispatch_id as string,
    attempt: row.attempt as number,
    taskId: row.task_id as string,
    plannedWorkload: (row.workload_at_dispatch as string | null) ?? null,
    atReceiptWorkload: (row.workload_at_receipt as string | null) ?? null,
    currentWorkload: (row.current_workload as string | null) ?? null,
    executorModel: (row.executor_model as string | null) ?? null,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string
  }));
}

// ---- claim_violation_projection ----

export function insertClaimViolation(db: DatabaseSync, violation: ClaimViolation): void {
  db.prepare(`
    INSERT INTO claim_violation_projection (id, wave_id, kind, task_a_id, task_b_id, path, detected_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    violation.id,
    violation.waveId,
    violation.kind,
    violation.taskAId,
    violation.taskBId,
    violation.path,
    violation.detectedAt,
    violation.source
  );
}

export type ClaimViolationQuery = {
  id?: string;
  waveId?: string;
  kind?: ClaimViolation["kind"];
  taskId?: string;
  taskAId?: string;
  taskBId?: string;
  path?: string;
  pathPattern?: string;
  detectedAfter?: string;
  detectedBefore?: string;
};

export function getClaimViolation(db: DatabaseSync, id: string): ClaimViolation | undefined {
  const row = db.prepare("SELECT * FROM claim_violation_projection WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToClaimViolation(row) : undefined;
}

function rowToClaimViolation(row: Record<string, unknown>): ClaimViolation {
  return {
    id: row.id as string,
    waveId: row.wave_id as string,
    kind: row.kind as ClaimViolation["kind"],
    taskAId: row.task_a_id as string,
    taskBId: row.task_b_id as string,
    path: row.path as string,
    detectedAt: row.detected_at as string,
    source: row.source as "derived-from-receipts"
  };
}

/** Query derived feedback by task, kind, exact path, or SQL-free path pattern. */
export function listClaimViolations(db: DatabaseSync, query: ClaimViolationQuery = {}): ClaimViolation[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (query.id !== undefined) { clauses.push("id = ?"); args.push(query.id); }
  if (query.waveId !== undefined) { clauses.push("wave_id = ?"); args.push(query.waveId); }
  if (query.kind !== undefined) { clauses.push("kind = ?"); args.push(query.kind); }
  if (query.taskId !== undefined) { clauses.push("(task_a_id = ? OR task_b_id = ?)"); args.push(query.taskId, query.taskId); }
  if (query.taskAId !== undefined) { clauses.push("task_a_id = ?"); args.push(query.taskAId); }
  if (query.taskBId !== undefined) { clauses.push("task_b_id = ?"); args.push(query.taskBId); }
  if (query.path !== undefined) { clauses.push("path = ?"); args.push(query.path); }
  if (query.detectedAfter !== undefined) { clauses.push("detected_at >= ?"); args.push(query.detectedAfter); }
  if (query.detectedBefore !== undefined) { clauses.push("detected_at <= ?"); args.push(query.detectedBefore); }
  let sql = "SELECT * FROM claim_violation_projection";
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY detected_at ASC, id ASC";
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  const violations = rows.map(rowToClaimViolation);
  if (query.pathPattern === undefined) return violations;
  const pattern = query.pathPattern;
  const escaped = [...pattern].map(char => char === "*" ? ".*" : char.replace(/[.+^${}()|[\\\]]/g, "\\$&")).join("");
  const regex = new RegExp(`^${escaped}$`);
  return violations.filter(violation => regex.test(violation.path));
}

export const queryClaimViolations = listClaimViolations;

// ---- export_checkpoint ----

export function insertExportCheckpoint(db: DatabaseSync, checkpoint: {
  exportId: string;
  eventCursor: EventRevision;
  generatedAt: string;
  filesHash: Record<string, string>;
  reason: string;
  sourceState?: Record<string, unknown> | null;
}): void {
  db.prepare(`
    INSERT INTO export_checkpoint (export_id, event_cursor_json, generated_at, files_hash_json, reason, source_state_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.exportId,
    JSON.stringify(checkpoint.eventCursor),
    checkpoint.generatedAt,
    JSON.stringify(checkpoint.filesHash),
    checkpoint.reason,
    checkpoint.sourceState ? JSON.stringify(checkpoint.sourceState) : null
  );
}

export function listExportCheckpoints(db: DatabaseSync): Array<{
  exportId: string;
  eventCursor: EventRevision;
  generatedAt: string;
  filesHash: Record<string, string>;
  reason: string;
  sourceState: Record<string, unknown> | null;
}> {
  const rows = db.prepare("SELECT * FROM export_checkpoint ORDER BY generated_at ASC").all() as Record<string, unknown>[];
  return rows.map(row => ({
    exportId: row.export_id as string,
    eventCursor: JSON.parse(row.event_cursor_json as string),
    generatedAt: row.generated_at as string,
    filesHash: JSON.parse(row.files_hash_json as string),
    reason: row.reason as string,
    sourceState: row.source_state_json ? JSON.parse(row.source_state_json as string) as Record<string, unknown> : null
  }));
}

// ---- T-120 acceptance revision + criteria ----

export function upsertAcceptanceRevision(db: DatabaseSync, input: {
  taskId: string;
  revision: number;
  condition: "criteria" | "empty";
  revisionEventNode: string;
  revisionEventSequence: number;
}): void {
  db.prepare(`
    INSERT INTO acceptance_revision_projection (task_id, revision, condition, revision_event_node, revision_event_sequence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      revision = excluded.revision,
      condition = excluded.condition,
      revision_event_node = excluded.revision_event_node,
      revision_event_sequence = excluded.revision_event_sequence
  `).run(input.taskId, input.revision, input.condition, input.revisionEventNode, input.revisionEventSequence);
}

export function replaceAcceptanceCriteria(db: DatabaseSync, taskId: string, revision: number, criteria: AcceptanceCriterionRecord[]): void {
  db.prepare("DELETE FROM acceptance_criterion_projection WHERE task_id = ?").run(taskId);
  const insert = db.prepare(`
    INSERT INTO acceptance_criterion_projection (
      task_id, criterion_id, revision, position, text, state, source,
      evidence_json, approved_at, approved_by, approval_event_node, approval_event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const criterion of criteria) {
    insert.run(
      taskId,
      criterion.criterionId,
      revision,
      criterion.position,
      criterion.text,
      criterion.state,
      criterion.source,
      criterion.evidence ? JSON.stringify(criterion.evidence) : null,
      criterion.approvedAt ?? null,
      criterion.approvedBy ?? null,
      null,
      null
    );
  }
}

function criterionRowToRecord(row: Record<string, unknown>): AcceptanceCriterionRecord {
  return {
    criterionId: row.criterion_id as string,
    revision: row.revision as number,
    position: row.position as number,
    text: row.text as string,
    state: row.state as AcceptanceCriterionState,
    source: row.source as string,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json as string) as Record<string, string> : null,
    approvedAt: (row.approved_at as string | null) ?? null,
    approvedBy: (row.approved_by as string | null) ?? null
  };
}

export function getAcceptanceRevisionHeader(db: DatabaseSync, taskId: string): { revision: number; condition: AcceptanceCondition; revisionEventNode: string; revisionEventSequence: number } | undefined {
  const row = db.prepare("SELECT * FROM acceptance_revision_projection WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    revision: row.revision as number,
    condition: row.condition as "criteria" | "empty",
    revisionEventNode: row.revision_event_node as string,
    revisionEventSequence: row.revision_event_sequence as number
  };
}

export function listAcceptanceCriteria(db: DatabaseSync, taskId: string): AcceptanceCriterionRecord[] {
  const rows = db.prepare("SELECT * FROM acceptance_criterion_projection WHERE task_id = ? ORDER BY position ASC").all(taskId) as Record<string, unknown>[];
  return rows.map(criterionRowToRecord);
}

export function getAcceptance(db: DatabaseSync, taskId: string): AcceptanceRevisionRecord | null {
  const header = getAcceptanceRevisionHeader(db, taskId);
  if (!header) return null;
  return {
    taskId,
    revision: header.revision,
    condition: header.condition,
    criteria: listAcceptanceCriteria(db, taskId)
  };
}

export function setCriterionApproval(db: DatabaseSync, taskId: string, criterionId: string, revision: number, approval: {
  state: AcceptanceCriterionState;
  evidence?: Record<string, string> | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
}): boolean {
  const result = db.prepare(`
    UPDATE acceptance_criterion_projection
    SET state = ?, evidence_json = ?, approved_at = ?, approved_by = ?
    WHERE task_id = ? AND criterion_id = ? AND revision = ?
  `).run(
    approval.state,
    approval.evidence ? JSON.stringify(approval.evidence) : null,
    approval.approvedAt ?? null,
    approval.approvedBy ?? null,
    taskId,
    criterionId,
    revision
  );
  return Number(result.changes) === 1;
}

// ---- T-116 history evidence + corrections ----

export type HistoryEvidenceRecord = {
  evidenceId: string;
  taskId: string;
  harness: string;
  sessionId: string;
  tier: "measured" | "inferred";
  confidence: "high" | "medium" | "low";
  repoRoot: string | null;
  repoOrigin: string | null;
  signals: string[];
  spanStart: string | null;
  spanEnd: string | null;
  activeMs: number | null;
  sourceHash: string | null;
  recordedAt: string;
};

export type HistoryEvidenceRow = HistoryEvidenceRecord & {
  status: "active" | "invalid";
  revisionEventNode: string;
  revisionEventSequence: number;
};

export function insertHistoryEvidence(db: DatabaseSync, evidence: HistoryEvidenceRecord, revision: EventRevision): void {
  db.prepare(`
    INSERT INTO history_evidence_projection (
      evidence_id, task_id, harness, session_id, tier, confidence, repo_root, repo_origin,
      signals_json, span_start, span_end, active_ms, source_hash, recorded_at, status,
      revision_event_node, revision_event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(evidence_id) DO UPDATE SET
      tier = excluded.tier,
      confidence = excluded.confidence,
      repo_root = excluded.repo_root,
      repo_origin = excluded.repo_origin,
      signals_json = excluded.signals_json,
      span_start = excluded.span_start,
      span_end = excluded.span_end,
      active_ms = excluded.active_ms,
      source_hash = excluded.source_hash,
      recorded_at = excluded.recorded_at,
      status = 'active',
      revision_event_node = excluded.revision_event_node,
      revision_event_sequence = excluded.revision_event_sequence
  `).run(
    evidence.evidenceId,
    evidence.taskId,
    evidence.harness,
    evidence.sessionId,
    evidence.tier,
    evidence.confidence,
    evidence.repoRoot,
    evidence.repoOrigin,
    JSON.stringify(evidence.signals),
    evidence.spanStart,
    evidence.spanEnd,
    evidence.activeMs,
    evidence.sourceHash,
    evidence.recordedAt,
    revision.node,
    revision.sequence
  );
}

export function getHistoryEvidence(db: DatabaseSync, evidenceId: string): HistoryEvidenceRow | undefined {
  const row = db.prepare("SELECT * FROM history_evidence_projection WHERE evidence_id = ?").get(evidenceId) as Record<string, unknown> | undefined;
  return row ? rowToHistoryEvidence(row) : undefined;
}

export function listHistoryEvidence(db: DatabaseSync, taskId?: string): HistoryEvidenceRow[] {
  const rows = taskId !== undefined
    ? db.prepare("SELECT * FROM history_evidence_projection WHERE task_id = ? ORDER BY recorded_at ASC, evidence_id ASC").all(taskId) as Record<string, unknown>[]
    : db.prepare("SELECT * FROM history_evidence_projection ORDER BY recorded_at ASC, evidence_id ASC").all() as Record<string, unknown>[];
  return rows.map(rowToHistoryEvidence);
}

export function invalidateHistoryEvidence(db: DatabaseSync, evidenceId: string): void {
  db.prepare("UPDATE history_evidence_projection SET status = 'invalid' WHERE evidence_id = ?").run(evidenceId);
}

function rowToHistoryEvidence(row: Record<string, unknown>): HistoryEvidenceRow {
  return {
    evidenceId: row.evidence_id as string,
    taskId: row.task_id as string,
    harness: row.harness as string,
    sessionId: row.session_id as string,
    tier: row.tier as HistoryEvidenceRecord["tier"],
    confidence: row.confidence as HistoryEvidenceRecord["confidence"],
    repoRoot: row.repo_root as string | null,
    repoOrigin: row.repo_origin as string | null,
    signals: JSON.parse(row.signals_json as string) as string[],
    spanStart: row.span_start as string | null,
    spanEnd: row.span_end as string | null,
    activeMs: row.active_ms as number | null,
    sourceHash: row.source_hash as string | null,
    recordedAt: row.recorded_at as string,
    status: row.status as HistoryEvidenceRow["status"],
    revisionEventNode: row.revision_event_node as string,
    revisionEventSequence: row.revision_event_sequence as number
  };
}

export type HistoryCorrectionRecord = {
  correctionId: string;
  taskId: string;
  targetKind: "receipt" | "evidence";
  targetId: string;
  verdict: "invalid";
  reason: string;
  recordedAt: string;
};

export type HistoryCorrectionRow = HistoryCorrectionRecord & {
  eventNode: string;
  eventSequence: number;
};

export function insertHistoryCorrection(db: DatabaseSync, correction: HistoryCorrectionRecord, revision: EventRevision): void {
  db.prepare(`
    INSERT INTO history_correction_projection (
      correction_id, task_id, target_kind, target_id, verdict, reason, recorded_at, event_node, event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(correction_id) DO NOTHING
  `).run(
    correction.correctionId,
    correction.taskId,
    correction.targetKind,
    correction.targetId,
    correction.verdict,
    correction.reason,
    correction.recordedAt,
    revision.node,
    revision.sequence
  );
}

export function listHistoryCorrections(db: DatabaseSync, query: { taskId?: string; targetKind?: string; targetId?: string } = {}): HistoryCorrectionRow[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (query.taskId !== undefined) { clauses.push("task_id = ?"); args.push(query.taskId); }
  if (query.targetKind !== undefined) { clauses.push("target_kind = ?"); args.push(query.targetKind); }
  if (query.targetId !== undefined) { clauses.push("target_id = ?"); args.push(query.targetId); }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM history_correction_projection${where} ORDER BY recorded_at ASC, correction_id ASC`).all(...args) as Record<string, unknown>[];
  return rows.map(row => ({
    correctionId: row.correction_id as string,
    taskId: row.task_id as string,
    targetKind: row.target_kind as HistoryCorrectionRecord["targetKind"],
    targetId: row.target_id as string,
    verdict: row.verdict as HistoryCorrectionRecord["verdict"],
    reason: row.reason as string,
    recordedAt: row.recorded_at as string,
    eventNode: row.event_node as string,
    eventSequence: row.event_sequence as number
  }));
}

/**
 * Receipt identity keys (dispatchId/attempt) invalidated by an accepted
 * history correction. Original receipt rows stay untouched and queryable;
 * roadmap display and duration/accuracy calibration use this list to
 * exclude them.
 */
export function listInvalidatedReceiptKeys(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT target_id FROM history_correction_projection WHERE target_kind = 'receipt' AND verdict = 'invalid'").all() as Array<{ target_id: string }>;
  return new Set(rows.map(row => row.target_id));
}

/**
 * T-118: the receipt planning ADMISSION rule, shared by the command-level
 * receipt path (dispatch.ts) and the new-event writer gate (events.ts via
 * assertNewEventAdmission) so the two can never drift. For every outcome
 * that implies a planning target -- completed -> review, blocked -> blocked,
 * failed -> ready from in-progress/blocked -- the task's current planning
 * state must be able to reach it; in-progress reaches ready through blocked
 * by design. This is admission only: the projection (applyRunReceipt) keeps
 * R9 semantics and never moves planning for a blocked RUN.
 */
export function assertReceiptPlanningAdmission(planningState: string, outcome: string): void {
  const targetPlanning = outcome === "completed"
    ? "review"
    : outcome === "failed"
      ? (planningState === "in-progress" || planningState === "blocked" ? "ready" : undefined)
      : outcome === "blocked"
        ? "blocked"
        : undefined;
  if (targetPlanning === undefined || planningState === targetPlanning) return;
  if (planningState === "in-progress" && targetPlanning === "ready") {
    assertTransition("planning", "in-progress", "blocked");
    assertTransition("planning", "blocked", "ready");
    return;
  }
  assertTransition("planning", planningState, targetPlanning);
}
