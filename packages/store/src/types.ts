export type WorkDomain = {
  key: string
  description: string
}

export type ProjectMetadata = {
  projectId: string
  boardTitle: string
  workDomains: WorkDomain[]
  notesMarkdown: string
  plansAuthority: "markdown" | "store"
  sourceSnapshotHash?: string | null
}

export type TaskRecord = {
  taskId: string
  positionKey: number
  title: string
  planningState: string
  executionState: string
  type?: string | null
  parentTaskId?: string | null
  priority?: string | null
  workload?: string | null
  tags: string[]
  domains: string[]
  startDate?: string | null
  dueDate?: string | null
  completedOn?: string | null
  externalId?: string | null
  externalLinks: string[]
  iteration?: string | null
  assignees: string[]
  milestone?: string | null
  specMode?: string | null
  detailPath?: string | null
  updatedOn?: string | null
}

export type TaskDetailRecord = {
  taskId: string
  role: string
  impact: string
  estimatedEffort: string
  prerequisites: string[]
  blocking: string[]
  filesAffected: string[]
  testsRequired: string[]
  summary: string
  descriptionGitHash?: string | null
}

export type DependencyKind = "blocks" | "depends-on"

export type DependencyRecord = {
  fromTaskId: string
  toTaskId: string
  kind: DependencyKind
}

export type ExternalRefOwnerKind = "project" | "epic" | "task" | "dispatch"

export type ExternalRefRecord = {
  refId: string
  ownerKind: ExternalRefOwnerKind
  ownerId: string
  provider: string
  entityKind: string
  externalKey: string
  uri: string
  metadata: Record<string, unknown>
  verified: boolean
}

export type ResourceClaimState = "active" | "released" | "expired"

export type ResourceClaimRecord = {
  claimId: string
  taskId: string
  leaseToken: string
  state: ResourceClaimState
  claimedAt: string
  expiresAt: string
  holder: Record<string, unknown>
  eventNode: string
  eventSequence: number
}

export type EventRevision = {
  node: string
  sequence: number
}

export type DispatchAttemptStatus = "claimed" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "expired"

export type DispatchAttemptRecord = {
  dispatchId: string
  taskId: string
  executorKind: string
  attempt: number
  contextHash: string
  status: DispatchAttemptStatus
  /**
   * T-071: the task's declared workload, frozen by the store at dispatch
   * creation (the PLANNED guess). Null for untagged tasks and pre-005 rows --
   * untagged stays untagged, never guessed. Store-stamped, never client-
   * supplied: the fact must be what the board believed at hand-off.
   */
  workloadAtDispatch?: string | null
  /**
   * T-071/D5: raw executor identity (e.g. "glm-4.7", "claude-opus-4-5"), a
   * captured FACT. Capability tiers are derived from this at analysis time by
   * a versioned lens; they are never stored, because model names evolve and a
   * frozen tier would rot while the raw id stays re-derivable.
   */
  executorModel?: string | null
}

/**
 * T-071: one accepted receipt joined with its workload stamps and the task's
 * current (latest) workload. The (planned, atReceipt, current) triple is the
 * estimation-quality signal: pools key on `current` (last-wins re-attribution),
 * the delta aggregate reads planned-vs-current for re-classified runs.
 */
export type WorkloadDeltaRow = {
  dispatchId: string
  attempt: number
  taskId: string
  plannedWorkload: string | null
  atReceiptWorkload: string | null
  currentWorkload: string | null
  executorModel: string | null
  startedAt: string
  endedAt: string
}

export type TaskSearchHit = {
  taskId: string
  title: string
  planningState: string
  completedOn: string | null
  tags: string[]
  domains: string[]
  summary: string | null
}

export type TaskSearchFilter = {
  query: string
  status?: string
  limit?: number
}
