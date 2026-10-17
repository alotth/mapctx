export type WorkDomain = {
  key: string
  description: string
}

import type { ClaimExclusivity, ClaimRole, DispatchKind, PredictedStart } from "@mapctx/protocol"

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
  /**
   * T-102 agent-authored start prediction (schema only, no predictor).
   * Null = none. Never exported to TASKS.md, never positions, never calibrates.
   */
  predictedStart?: PredictedStart | null
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
  /** Absent rows predate T-099 and mean `legacy-human`. */
  estimatedEffortSource?: "agent-active" | "legacy-human"
  waitReason?: "review" | "decision" | "parked" | "blocked-external"
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
  /**
   * T-142 (C3 / D2): the renew-only capability, minted independently of
   * `leaseToken` and scoped to this `claimId`. `null` for a claim made before
   * the capability existed (migration 12 adds the column with no backfill):
   * such a claim renews with its `leaseToken` and nothing else. Explicitly
   * `| null` rather than optional so a legacy row reads as a decision rather
   * than as a field somebody forgot to select.
   */
  renewToken: string | null
  state: ResourceClaimState
  /**
   * T-144 (C5 / D5): whether this claim excludes other claims on its task.
   * NOT optional, unlike `renewToken`: migration 13 adds the column with
   * `NOT NULL DEFAULT 'exclusive'`, which fills every historical row in the
   * same statement, so there is no row anywhere -- migrated or replayed --
   * that does not answer this. A nullable column here would be unsafe rather
   * than merely untidy: the new index predicate reads
   * `exclusivity = 'exclusive'`, so a NULL row would fall out of the
   * uniqueness constraint while the application layer still treated it as
   * exclusive, and a second explicitly-exclusive claim would insert beside it
   * with no UNIQUE violation -- two effective holders of one task.
   */
  exclusivity: ClaimExclusivity
  /** T-144: the lane this claim holds. Legacy rows are `implement`. */
  role: ClaimRole
  claimedAt: string
  expiresAt: string
  holder: Record<string, unknown>
  eventNode: string
  eventSequence: number
}

/**
 * T-134 (C0 of the coordination v2 design, operator decision D1): the claim
 * shape a REFUSAL may disclose about somebody else's claim.
 *
 * It is an allowlist by construction, not `Omit<ResourceClaimRecord,
 * "leaseToken">`: the next secret added to a claim -- the design already
 * foresees a renew token and a derived lease -- must fail to compile here
 * rather than start leaking through every refusal that echoes a claim.
 * `leaseToken` is the bearer credential for renew/release, so only the
 * holder that created it ever receives it.
 */
export type DisclosableClaimRecord = {
  claimId: string
  taskId: string
  state: ResourceClaimState
  /**
   * T-144: disclosed, deliberately. Neither field is a secret, and together
   * they are the answer a refused caller most needs: a `task start` turned away
   * by `active-claim-held` learns that an EXCLUSIVE IMPLEMENT claim holds the
   * task, rather than being left to guess which of two possible lanes refused
   * it. The allowlist above is about credentials, not about the shape of a
   * lane.
   */
  exclusivity: ClaimExclusivity
  role: ClaimRole
  claimedAt: string
  expiresAt: string
  holder: Record<string, unknown>
  eventNode: string
  eventSequence: number
  /**
   * Makes the redaction STRUCTURAL rather than aspirational. Without this,
   * `ResourceClaimRecord` is assignable to this type -- it has all the fields
   * above plus more, and excess-property checks only fire on fresh object
   * literals -- so `activeClaim: active` would have compiled and quietly
   * reintroduced the leak. The test agent's mutation proved exactly that.
   * Declaring the secret as `never` makes any record that actually carries a
   * token fail to compile here.
   */
  leaseToken?: never
  /**
   * T-142: the same structural guard for the second capability. A renewToken
   * cannot release a claim, but it can keep somebody else's lane alive
   * indefinitely, so a refusal must not hand it out either.
   */
  renewToken?: never
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
   * T-144 (C5 / D5): the lane this attempt runs in. Required for the same
   * reason `exclusivity` is: migration 13 fills every historical row with
   * `implement`, and the replay path normalizes an absent payload `kind` to the
   * same value, so a reader never has to decide what a missing lane means.
   *
   * Fixed per `dispatchId`, not per attempt: attempt N+1 of a dispatch is a
   * retry of the same lane, and `appendDispatchAttempt` refuses a kind that
   * contradicts the attempts already recorded under that id.
   */
  kind: DispatchKind
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

/**
 * T-120: acceptance criteria revisioned in the store. `condition` records the
 * honest state of the latest revision: 'criteria' when criterion rows exist,
 * 'empty' when the section was revised to zero criteria (prose-only/blank).
 * No revision header at all means acceptance revisioning never happened
 * ('absent') -- never confused with 'empty', and never filled from checkout.
 * How the revision came to be lives in the audit events (authored revise,
 * explicit approve/unapprove, or the cutover's import-observed mapping).
 */
export type AcceptanceCondition = "criteria" | "empty"

export type AcceptanceCriterionState = "pending" | "approved"

export type AcceptanceCriterionRecord = {
  criterionId: string
  revision: number
  position: number
  text: string
  state: AcceptanceCriterionState
  /** 'authored' | 'import-observed' | 'import-observed-unchecked' */
  source: string
  evidence?: Record<string, string> | null
  approvedAt?: string | null
  approvedBy?: string | null
}

export type AcceptanceRevisionRecord = {
  taskId: string
  revision: number
  condition: AcceptanceCondition
  criteria: AcceptanceCriterionRecord[]
}
