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
}
