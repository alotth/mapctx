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
  }
]
