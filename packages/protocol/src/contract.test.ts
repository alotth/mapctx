import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { z } from "zod";
import { canonicalJson } from "./canonical";
import { ENTITY_SCHEMAS } from "./entities";
import { ENVELOPE_SCHEMAS } from "./envelopes";
import { ENTITY_FIXTURES, ENVELOPE_FIXTURES, externalRefsFixture } from "./fixtures";
import {
  OPTIONAL_TASKS_MD_FIELDS,
  REQUIRED_DETAIL_FIELDS,
  REQUIRED_TASKS_MD_FIELDS,
  assertMigrationCoverage,
  migrationRuleFor
} from "./migration-map";
import {
  PROTOCOL_SCHEMA_VERSION,
  assertCompatibleSchemaVersion,
  checkSchemaCompatibility
} from "./schema-version";
import {
  assertTransition,
  canTransitionExecution,
  canTransitionPlanning,
  illegalExecutionTransitions,
  illegalPlanningTransitions
} from "./state-machines";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "fixtures");
const SCHEMA_DIR = path.join(ROOT, "schemas");

const ALL_SCHEMAS = { ...ENTITY_SCHEMAS, ...ENVELOPE_SCHEMAS };
const ALL_FIXTURES = { ...ENTITY_FIXTURES, ...ENVELOPE_FIXTURES };

test("every entity and envelope has a schema and a versioned golden fixture", () => {
  for (const name of Object.keys(ALL_SCHEMAS)) {
    const fixturePath = path.join(FIXTURE_DIR, `${name}.v${PROTOCOL_SCHEMA_VERSION}.json`);
    const schemaPath = path.join(SCHEMA_DIR, `${name}.v${PROTOCOL_SCHEMA_VERSION}.json`);
    assert.equal(fs.existsSync(fixturePath), true, `missing fixture ${fixturePath}`);
    assert.equal(fs.existsSync(schemaPath), true, `missing generated schema ${schemaPath}`);
  }
});

test("golden fixtures parse and stay byte-stable", () => {
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    const fixturePath = path.join(FIXTURE_DIR, `${name}.v${PROTOCOL_SCHEMA_VERSION}.json`);
    const raw = fs.readFileSync(fixturePath, "utf8");
    const parsed = JSON.parse(raw);
    const result = (schema as z.ZodType).safeParse(parsed);
    assert.equal(result.success, true, `${name} fixture failed schema: ${JSON.stringify(result)}`);
    assert.equal(raw, canonicalJson(ALL_FIXTURES[name as keyof typeof ALL_FIXTURES]), `${name} drifted from source fixture`);
  }
});

test("schemaVersion is required on dispatch/run envelopes and incompatible versions are rejected", () => {
  for (const name of ["DispatchEnvelope", "RunEvent", "RunReceipt"] as const) {
    const fixture = { ...ENVELOPE_FIXTURES[name] };
    assert.equal(fixture.schemaVersion, PROTOCOL_SCHEMA_VERSION);
    const missing = { ...fixture } as Record<string, unknown>;
    delete missing.schemaVersion;
    assert.equal(ENVELOPE_SCHEMAS[name].safeParse(missing).success, false, `${name} accepted missing schemaVersion`);
  }

  assert.equal(checkSchemaCompatibility(PROTOCOL_SCHEMA_VERSION).ok, true);
  assert.equal(checkSchemaCompatibility(PROTOCOL_SCHEMA_VERSION + 1).ok, false);
  assert.equal(checkSchemaCompatibility(0).ok, false);
  assert.throws(() => assertCompatibleSchemaVersion(PROTOCOL_SCHEMA_VERSION + 1), /Incompatible schemaVersion/);
});

test("identity scheme links MapCtx task, Traycer epic/artifact, and GitHub issue", () => {
  const byProvider = Object.fromEntries(externalRefsFixture.map((ref) => [ref.provider + ":" + ref.entityKind, ref]));
  assert.equal(byProvider["other:other"].externalKey, "T-048");
  assert.equal(byProvider["traycer:epic"].uri.includes("e8873251-f6f0-490d-be16-8e5655300237"), true);
  assert.equal(byProvider["traycer:artifact"].entityKind, "artifact");
  assert.equal(byProvider["github:issue"].externalKey, "42");
  for (const ref of externalRefsFixture) {
    ENTITY_SCHEMAS.ExternalRef.parse(ref);
  }
});

test("planning and execution are separate machines; illegal transitions fail", () => {
  assert.equal(canTransitionPlanning("backlog", "ready"), true);
  assert.equal(canTransitionPlanning("done", "backlog"), false);
  assert.equal(canTransitionExecution("unclaimed", "claimed"), true);
  assert.equal(canTransitionExecution("completed", "running"), false);
  assert.throws(() => assertTransition("planning", "done", "ready"), /Illegal planning transition/);
  assert.throws(() => assertTransition("execution", "completed", "claimed"), /Illegal execution transition/);

  const planningIllegal = illegalPlanningTransitions();
  const executionIllegal = illegalExecutionTransitions();
  assert.ok(planningIllegal.length > 0);
  assert.ok(executionIllegal.length > 0);
  for (const { from, to } of planningIllegal) {
    assert.equal(canTransitionPlanning(from, to), false);
  }
  for (const { from, to } of executionIllegal) {
    assert.equal(canTransitionExecution(from, to), false);
  }
});

test("event log identity is (nodeId, sequence) and forbids autoincrement fields", () => {
  const entry = ENTITY_FIXTURES.EventLogEntry;
  ENTITY_SCHEMAS.EventLogEntry.parse(entry);
  assert.equal(typeof entry.nodeId, "string");
  assert.equal(typeof entry.sequence, "number");
  const schemaText = fs.readFileSync(
    path.join(SCHEMA_DIR, `EventLogEntry.v${PROTOCOL_SCHEMA_VERSION}.json`),
    "utf8"
  );
  assert.equal(/autoincrement/i.test(schemaText), false);
  assert.equal(/INTEGER PRIMARY KEY/i.test(schemaText), false);
});

test("UsageEvent carries source and coverage", () => {
  const parsed = ENTITY_SCHEMAS.UsageEvent.parse(ENTITY_FIXTURES.UsageEvent);
  assert.equal(parsed.source, "harness-transcript");
  assert.equal(parsed.coverage, "partial");
  assert.equal(
    ENTITY_SCHEMAS.UsageEvent.safeParse({ ...parsed, source: "made-up" }).success,
    false
  );
});

test("CostEvent has three measures and PlanPeriod is open|closed", () => {
  const cost = ENTITY_SCHEMAS.CostEvent.parse(ENTITY_FIXTURES.CostEvent);
  assert.equal(typeof cost.cashCents, "number");
  assert.equal(typeof cost.shadowMicros, "number");
  assert.equal(typeof cost.allocatedMicros, "number");
  assert.equal(cost.billingType, "subscription_included");
  assert.equal(cost.costStatus, "allocated");
  const period = ENTITY_SCHEMAS.PlanPeriod.parse(ENTITY_FIXTURES.PlanPeriod);
  assert.equal(period.status, "open");
  assert.equal(ENTITY_SCHEMAS.PlanPeriod.safeParse({ ...period, status: "maybe" }).success, false);
});

test("duration measures and estimate snapshots are explicit data", () => {
  const duration = ENTITY_SCHEMAS.DurationMeasures.parse(ENTITY_FIXTURES.DurationMeasures);
  assert.ok(duration.idleThresholdMs > 0);
  assert.ok(duration.activeTimeMs <= duration.sessionWallClockMs);
  const estimate = ENTITY_SCHEMAS.EstimateSnapshot.parse(ENTITY_FIXTURES.EstimateSnapshot);
  assert.equal(estimate.method, "expert-guess");
  assert.equal(estimate.confidence, "low");
  assert.equal(estimate.estimatorVersion, "v1");
  assert.equal(estimate.idleThresholdMs, duration.idleThresholdMs);
  assert.equal(estimate.costCoverage, "partial");
});

test("workflow gates model approved and skipped-with-reason", () => {
  ENTITY_SCHEMAS.WorkflowGate.parse(ENTITY_FIXTURES.WorkflowGate);
  const skipped = {
    name: "architecture",
    status: "skipped",
    reason: "localized-low-risk",
    evidence: []
  };
  ENTITY_SCHEMAS.WorkflowGate.parse(skipped);
  assert.equal(
    ENTITY_SCHEMAS.WorkflowGate.safeParse({
      name: "architecture",
      status: "skipped",
      reason: null,
      evidence: []
    }).success,
    false
  );
});

test("migration map covers every current TASKS.md and detail field", () => {
  const fields = [
    ...REQUIRED_TASKS_MD_FIELDS.map((field) => ({ origin: "TASKS.md" as const, field })),
    ...OPTIONAL_TASKS_MD_FIELDS.map((field) => ({ origin: "TASKS.md" as const, field })),
    ...REQUIRED_DETAIL_FIELDS.map((field) => ({ origin: "tasks/<ID>.md" as const, field }))
  ];
  const missing = assertMigrationCoverage(fields);
  assert.deepEqual(missing, []);
  assert.equal(migrationRuleFor("TASKS.md", "subIssueProgress")?.classification, "derive");
  assert.equal(migrationRuleFor("TASKS.md", "defaultExpanded")?.classification, "drop");
  assert.equal(migrationRuleFor("tasks/<ID>.md", "description")?.classification, "persist");
  assert.equal(migrationRuleFor("TASKS.md", "status")?.classification, "persist");
});
