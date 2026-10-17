/**
 * Schema migration 001: initial physical schema. Journal (events/<nodeId>/<sequence>.json)
 * is canonical; every table here is either an index over event_log or a projection
 * that can be dropped and rebuilt from the journal alone (see repair.ts).
 */
export const MIGRATION_001_INITIAL = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  node_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  logical_clock INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  causation_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  journal_path TEXT NOT NULL,
  PRIMARY KEY (node_id, sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_event_log_logical_order ON event_log(logical_clock, node_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_occurred_at ON event_log(occurred_at);

CREATE TABLE IF NOT EXISTS project_projection (
  project_id TEXT PRIMARY KEY,
  board_title TEXT NOT NULL,
  work_domains_json TEXT NOT NULL,
  notes_markdown TEXT NOT NULL,
  plans_authority TEXT NOT NULL,
  source_snapshot_hash TEXT
);

CREATE TABLE IF NOT EXISTS task_projection (
  task_id TEXT PRIMARY KEY,
  position_key INTEGER NOT NULL,
  title TEXT NOT NULL,
  planning_state TEXT NOT NULL,
  execution_state TEXT NOT NULL,
  type TEXT,
  parent_task_id TEXT,
  priority TEXT,
  workload TEXT,
  tags_json TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  start_date TEXT,
  due_date TEXT,
  completed_on TEXT,
  external_id TEXT,
  external_links_json TEXT NOT NULL,
  iteration TEXT,
  assignees_json TEXT NOT NULL,
  milestone TEXT,
  spec_mode TEXT,
  detail_path TEXT,
  updated_on TEXT,
  revision_event_node TEXT NOT NULL,
  revision_event_sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_projection_planning ON task_projection(planning_state, position_key);
CREATE INDEX IF NOT EXISTS idx_task_projection_parent ON task_projection(parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_projection_external_id ON task_projection(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_projection_updated ON task_projection(updated_on);

CREATE TABLE IF NOT EXISTS task_detail_projection (
  task_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  impact TEXT NOT NULL,
  estimated_effort TEXT NOT NULL,
  prerequisites_json TEXT NOT NULL,
  blocking_json TEXT NOT NULL,
  files_affected_json TEXT NOT NULL,
  tests_required_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  description_git_hash TEXT
);

CREATE TABLE IF NOT EXISTS dependency_projection (
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_projection(from_task_id);
CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_projection(to_task_id);

CREATE TABLE IF NOT EXISTS external_ref_projection (
  ref_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  external_key TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_ref_unique ON external_ref_projection(provider, entity_kind, external_key);
CREATE INDEX IF NOT EXISTS idx_external_ref_owner ON external_ref_projection(owner_kind, owner_id);

CREATE TABLE IF NOT EXISTS resource_claim_projection (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  holder_json TEXT NOT NULL,
  event_node TEXT NOT NULL,
  event_sequence INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_claim_active_task ON resource_claim_projection(task_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_resource_claim_state_expiry ON resource_claim_projection(state, expires_at);

-- Schema-ready shells for T-052+ (dispatch/run/usage/cost/forecast). T-049 creates
-- and indexes them; it does not populate them.
CREATE TABLE IF NOT EXISTS artifact_ref_projection (
  artifact_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT,
  content_hash TEXT,
  promoted_path TEXT
);
CREATE TABLE IF NOT EXISTS workflow_gate_projection (
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (task_id, name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dispatch_projection (
  dispatch_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, attempt)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_projection(task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_latest ON dispatch_projection(dispatch_id, attempt DESC);
CREATE TABLE IF NOT EXISTS run_receipt_projection (
  dispatch_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  usage_events_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  failure_json TEXT,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, attempt)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS usage_event_projection (
  usage_event_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  source TEXT NOT NULL,
  coverage TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_event_dispatch ON usage_event_projection(dispatch_id);
CREATE TABLE IF NOT EXISTS cost_event_projection (
  cost_event_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  usage_event_id TEXT,
  billing_type TEXT NOT NULL,
  cost_status TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  shadow_micros INTEGER NOT NULL,
  allocated_micros INTEGER,
  plan_period_id TEXT,
  price_table_version TEXT NOT NULL,
  applied_rate_micros_per_token INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_event_dispatch ON cost_event_projection(dispatch_id);
CREATE TABLE IF NOT EXISTS plan_period_projection (
  plan_period_id TEXT PRIMARY KEY,
  biller TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  fixed_cents INTEGER NOT NULL,
  seats INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS estimate_snapshot_projection (
  estimate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_estimate_snapshot_task ON estimate_snapshot_projection(task_id);

CREATE TABLE IF NOT EXISTS export_checkpoint (
  export_id TEXT PRIMARY KEY,
  event_cursor_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  files_hash_json TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_checkpoint_generated_at ON export_checkpoint(generated_at);
CREATE INDEX IF NOT EXISTS idx_export_checkpoint_reason ON export_checkpoint(reason);
`.trim()

export type Migration = {
  version: number
  sql: string
}

/** Additive claim feedback projection. Versioned as migration 002. */
export const CLAIM_VIOLATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_violation_projection (
  id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_a_id TEXT NOT NULL,
  task_b_id TEXT NOT NULL,
  path TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_violation_wave ON claim_violation_projection(wave_id);
CREATE INDEX IF NOT EXISTS idx_claim_violation_tasks ON claim_violation_projection(task_a_id, task_b_id);
CREATE INDEX IF NOT EXISTS idx_claim_violation_kind_path ON claim_violation_projection(kind, path);
`.trim();

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: MIGRATION_001_INITIAL },
  { version: 2, sql: CLAIM_VIOLATION_SCHEMA },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS run_event_projection (
  dispatch_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, attempt, sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_run_event_dispatch ON run_event_projection(dispatch_id, attempt, sequence);
`.trim()
  },
  {
    // T-070: Account owns the plan; projects consume it. PlanPeriod is
    // re-scoped from project-scoped to account-scoped (account_id nullable so
    // pre-004 rows survive as valid data), and the budget ledger projection
    // lands alongside it. Additive only -- never edit 001 in place post-cutover.
    version: 4,
    sql: `
ALTER TABLE plan_period_projection ADD COLUMN account_id TEXT;
CREATE TABLE IF NOT EXISTS account_projection (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS project_account_binding (
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  logical_clock INTEGER NOT NULL,
  PRIMARY KEY (project_id, account_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_project_account_account ON project_account_binding(account_id);
CREATE TABLE IF NOT EXISTS budget_projection (
  budget_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  money_json TEXT,
  minutes INTEGER,
  period_start TEXT,
  period_end TEXT,
  set_at TEXT NOT NULL,
  note TEXT,
  logical_clock INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_owner ON budget_projection(owner_kind, owner_id, logical_clock);
`.trim()
  },
  {
    // T-071: planned-vs-discovered workload stamps. workload_at_dispatch is
    // frozen at hand-off (the planned guess); workload_at_receipt is frozen at
    // receipt (the discovered value at run end). Both ride in their events, so
    // replay rebuilds them. Nullable: pre-005 rows and untagged tasks are null
    // and stay null -- never guessed. executor_model is the raw executor
    // identity fact; tiers are derived later, never stored (D5).
    version: 5,
    sql: `
ALTER TABLE dispatch_projection ADD COLUMN workload_at_dispatch TEXT;
ALTER TABLE dispatch_projection ADD COLUMN executor_model TEXT;
ALTER TABLE run_receipt_projection ADD COLUMN workload_at_receipt TEXT;
`.trim()
  },
  {
    // T-099: historic estimates retain their human-working-time provenance;
    // only estimates authored after the convention change are agent-active.
    // Nullable preserves every existing row as legacy-human without a rewrite.
    version: 6,
    sql: `
ALTER TABLE task_detail_projection ADD COLUMN estimated_effort_source TEXT;
`.trim()
  },
  {
    version: 7,
    sql: `ALTER TABLE task_detail_projection ADD COLUMN wait_reason TEXT;`
  },
  {
    // T-102: agent-authored start prediction (schema only, no predictor).
    // Nullable triple preserves every existing row as "no prediction".
    version: 8,
    sql: `
ALTER TABLE task_projection ADD COLUMN predicted_start TEXT;
ALTER TABLE task_projection ADD COLUMN predicted_method TEXT;
ALTER TABLE task_projection ADD COLUMN predicted_confidence TEXT;
`.trim()
  },
  {
    // T-116: historical evidence + auditable corrections. Evidence registers
    // session linkage for ANY planning state (including done) without claims,
    // dispatches or receipts, so done history never mutates lifecycle.
    // Corrections never rewrite or delete originals (receipts/events stay);
    // they journal an auditable verdict that readers use to exclude invalid
    // evidence from roadmap display and duration/accuracy calibration.
    version: 9,
    sql: `
CREATE TABLE IF NOT EXISTS history_evidence_projection (
  evidence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  confidence TEXT NOT NULL,
  repo_root TEXT,
  repo_origin TEXT,
  signals_json TEXT NOT NULL,
  span_start TEXT,
  span_end TEXT,
  active_ms INTEGER,
  source_hash TEXT,
  recorded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision_event_node TEXT NOT NULL,
  revision_event_sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_evidence_task ON history_evidence_projection(task_id);
CREATE INDEX IF NOT EXISTS idx_history_evidence_session ON history_evidence_projection(harness, session_id);
CREATE TABLE IF NOT EXISTS history_correction_projection (
  correction_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_node TEXT NOT NULL,
  event_sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_correction_task ON history_correction_projection(task_id);
CREATE INDEX IF NOT EXISTS idx_history_correction_target ON history_correction_projection(target_kind, target_id);
`.trim()
  },
  {
    // T-120: acceptance criteria live in the store. The per-task revision
    // header is the minimal fix for revision-counter loss: removing every
    // criterion (condition 'empty') keeps the revision, so a later revise
    // never reuses an old revision number and stale approvals can never be
    // re-attached by revision confusion. No header row = no acceptance
    // revisioning has ever happened (honest 'absent'). Criteria rows carry
    // the revision they belong to; approval facts (who/when/evidence) ride
    // on the row and the distinguishing audit events. Additive only --
    // never edit earlier migrations in place post-cutover.
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS acceptance_revision_projection (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  condition TEXT NOT NULL,
  revision_event_node TEXT NOT NULL,
  revision_event_sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS acceptance_criterion_projection (
  task_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  evidence_json TEXT,
  approved_at TEXT,
  approved_by TEXT,
  approval_event_node TEXT,
  approval_event_sequence INTEGER,
  PRIMARY KEY (task_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_criterion_task ON acceptance_criterion_projection(task_id, revision, position);
ALTER TABLE export_checkpoint ADD COLUMN source_state_json TEXT;
`.trim()
  },
  {
    // T-126: auditable redaction of sensitive evidence. One row per applied
    // redaction, keyed by the redaction event itself, naming the target event
    // and the exact field paths whose CONTENT was destroyed. The row carries
    // the preserved hash of the original payload plus the resulting hash, so
    // repair can verify the chain target -> redacted state without ever
    // holding the removed content. Field-level hashes are deliberately NOT
    // stored (a hash of a low-entropy identifier is brute-forceable).
    // Additive only -- never edit earlier migrations in place post-cutover.
    //
    // `logical_clock` is the redaction event's own clock: the chain over one
    // target is ordered causally by it, as every other journal merge in this
    // codebase is (review MEDIA-2). This migration is edited in place rather
    // than followed by a 12th because version 11 ships with T-126 and has
    // never been applied to any real store -- there is no deployed schema 11
    // for a later migration to upgrade FROM, so adding the column here keeps
    // the table definition in one piece instead of splitting one feature's
    // ledger across two versions. It remains additive, idempotent and
    // downgrade-safe: CREATE ... IF NOT EXISTS, and an older CLI that only
    // knows versions <= 10 inspects only the versions it knows.
    version: 11,
    sql: `
CREATE TABLE IF NOT EXISTS redaction_projection (
  event_node TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  logical_clock INTEGER NOT NULL,
  target_node TEXT NOT NULL,
  target_sequence INTEGER NOT NULL,
  field_paths_json TEXT NOT NULL,
  requested_field_path TEXT NOT NULL,
  prior_payload_sha256 TEXT NOT NULL,
  redacted_payload_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  redacted_at TEXT NOT NULL,
  PRIMARY KEY (event_node, event_sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_redaction_target ON redaction_projection(target_node, target_sequence, logical_clock, event_sequence);
`.trim()
  },
  {
    // T-142 (C3 / D2): a claim carries a second, independent capability --
    // `renewToken` renews the lease, `leaseToken` renews AND releases it. The
    // column is a NEW version because schema 11 is deployed: the real store
    // is on 11, so 11 is frozen and this is additive on top of it.
    //
    // NULLABLE on purpose, and this is the whole legacy story. The column has
    // no backfill and no default:
    //   - a historical row (claimed before this migration) has no renewToken
    //     and never will -- its holder was handed one token, and inventing a
    //     second one now would mint a capability nobody was ever given;
    //   - a DEFAULT would be worse than useless, it would be a universal key:
    //     every legacy row would share one value, and presenting it would
    //     renew any of them.
    // So NULL means "this claim has no renew capability", `renewClaim`
    // refuses a presented renewToken against such a row by name
    // (`renew-token-unavailable`) instead of comparing against NULL, and the
    // legacy holder keeps renewing with `--token` exactly as before.
    //
    // Downgrade-safe: a CLI that only knows versions <= 11 never selects the
    // column, and `SELECT *` readers tolerate the extra field.
    version: 12,
    sql: `
ALTER TABLE resource_claim_projection ADD COLUMN renew_token TEXT;
`.trim()
  },
  {
    // T-144 (C5 / D5): the review lane becomes a first-class lane. A dispatch
    // declares which lane it runs in (`kind`), and a claim declares whether it
    // excludes other claims (`exclusivity`) and which lane it holds (`role`),
    // so a review can run concurrently with the implementation it reviews
    // instead of being refused by `active-claim-held`.
    //
    // A NEW version, like 12 before it: 11 and 12 are applied to the real
    // store, and editing an applied migration trips the checksum guard and
    // refuses to open the store at all (`db.ts:37-42`). Order within
    // MIGRATIONS is load-bearing here beyond the usual reason -- on a fresh
    // database migration 001 still creates
    // `idx_resource_claim_active_task` with the OLD predicate, and this
    // migration is what swaps it.
    //
    // NOT NULL DEFAULT + CHECK, not nullable, and that choice is the whole
    // safety argument rather than a style preference. SQLite accepts
    // `NOT NULL DEFAULT` with a `CHECK` on `ADD COLUMN` and fills every
    // existing row with the default as part of the same statement, so there is
    // never a NULL window and no separate backfill. With a NULLABLE column the
    // new predicate (`exclusivity = 'exclusive'`) would not match a legacy
    // NULL row, that row would silently stop being covered by the uniqueness
    // constraint while the application layer still treated it as exclusive, and
    // a second explicitly-exclusive claim would insert on the same task with no
    // UNIQUE violation: two effective holders. Verified in a scratch database,
    // not reasoned about -- with a nullable column the second insert succeeds.
    //
    // Statement ORDER is likewise load-bearing, and in the direction that is
    // easy to get backwards: the columns are added BEFORE anything references
    // them. An `UPDATE ... SET exclusivity = 'exclusive'` placed first fails
    // with `no such column: exclusivity`, and since the runner wraps each
    // migration in one `BEGIN IMMEDIATE` with `ROLLBACK` on error
    // (`db.ts:45-53`) the whole migration aborts and the store fails to open.
    // Atomicity was never the problem; order was.
    //
    // The index is dropped and recreated under the EXACT SAME NAME. One name
    // holds exactly one definition, so reusing it is what makes the old
    // predicate impossible to leave behind anywhere -- there is no second
    // index for a stale `WHERE state = 'active'` to survive in. (It is not,
    // as an earlier draft of the design claimed, because 001 re-runs its
    // `CREATE ... IF NOT EXISTS` on every open: it does not. `runMigrations`
    // skips any version already recorded with a matching checksum, so 001
    // executes once per database.)
    //
    // `dispatch_projection.kind` gets the identical treatment even though it
    // sits in no unique index -- one migration pattern for this change, not
    // two null-handling philosophies for an operator to reconcile.
    //
    // Downgrade-safe: a CLI that only knows versions <= 12 never selects the
    // new columns, and `SELECT *` readers tolerate the extra fields. Such a
    // binary would, however, read the swapped index as the old constraint it
    // no longer is -- it would permit a second exclusive claim only if it also
    // wrote `exclusivity` values, which it cannot, so its inserts land as
    // `exclusive` by default and the index still refuses them.
    version: 13,
    sql: `
ALTER TABLE resource_claim_projection ADD COLUMN exclusivity TEXT NOT NULL DEFAULT 'exclusive' CHECK (exclusivity IN ('exclusive', 'shared'));
ALTER TABLE resource_claim_projection ADD COLUMN role TEXT NOT NULL DEFAULT 'implement' CHECK (role IN ('implement', 'review'));
ALTER TABLE dispatch_projection ADD COLUMN kind TEXT NOT NULL DEFAULT 'implement' CHECK (kind IN ('implement', 'review'));
DROP INDEX IF EXISTS idx_resource_claim_active_task;
CREATE UNIQUE INDEX idx_resource_claim_active_task ON resource_claim_projection(task_id) WHERE state = 'active' AND exclusivity = 'exclusive';
`.trim()
  }
]
