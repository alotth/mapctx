import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import test from "node:test"
import { AGENT_ACTIVE_DAY_MS, AGENT_ACTIVE_HOUR_MS, AGENT_ACTIVE_WEEK_MS } from "@mapctx/protocol"
import { claimTask, renewClaim, deriveLeaseDurationMs, DEFAULT_LEASE_DURATION_MS } from "./claims"
import {
  resolveCoordinationSettings,
  readMapctxToml,
  serializeMapctxToml,
  ABSOLUTE_LEASE_CEILING_MS,
  type MapctxTomlConfig,
  type CoordinationSettings
} from "./config"
import { createTask, updateTask } from "./tasks"
import { StoreHandle } from "./store-handle"
import { importCommit } from "./cutover"
import { cleanupDir, mkTmpDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-141 / C2 (29b35fe): lease = clamp(estimatedEffort x leaseFactor,
 * defaultLease, maxLease), D10 defaults (0.5 / 30m / 8h). These tests isolate
 * the delta: `deriveLeaseDurationMs`, `[coordination]` validation and
 * round-trip, and the end-to-end claim/renew behaviour at the store level.
 */

const DEFAULTS: CoordinationSettings = resolveCoordinationSettings(undefined);

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

// ---------------------------------------------------------------------------
// 1. Clamp boundaries (unit, D10 defaults)
// ---------------------------------------------------------------------------

test("deriveLeaseDurationMs clamp boundaries at the D10 defaults, in @mapctx/protocol's own units", () => {
  // 1h x 0.5 = 30m: lands exactly on the floor.
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1h" }), AGENT_ACTIVE_HOUR_MS * 0.5);
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1h" }), DEFAULTS.defaultLeaseMs);

  // 30m x 0.5 = 15m: below the floor, raised to it.
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "30m" }), DEFAULTS.defaultLeaseMs);

  // 16h x 0.5 = 8h: lands exactly on the ceiling.
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "16h" }), AGENT_ACTIVE_HOUR_MS * 16 * 0.5);
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "16h" }), DEFAULTS.maxLeaseMs);

  // 1w (= 40 agent-active hours per @mapctx/protocol) x 0.5 = 20h: above the ceiling, lowered to it.
  assert.equal(AGENT_ACTIVE_WEEK_MS, 5 * AGENT_ACTIVE_DAY_MS, "sanity: 1w = 5d in this convention");
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1w" }), DEFAULTS.maxLeaseMs);

  // 1d (= 8 agent-active hours) x 0.5 = 4h: strictly inside the clamp, untouched.
  assert.equal(AGENT_ACTIVE_DAY_MS, 8 * AGENT_ACTIVE_HOUR_MS, "sanity: 1d = 8h in this convention");
  const midpoint = deriveLeaseDurationMs({ estimatedEffort: "1d" });
  assert.equal(midpoint, AGENT_ACTIVE_DAY_MS * 0.5);
  assert.ok(midpoint > DEFAULTS.defaultLeaseMs && midpoint < DEFAULTS.maxLeaseMs, "must not be clamped at either end");
});

// ---------------------------------------------------------------------------
// 2. Formats
// ---------------------------------------------------------------------------

test("deriveLeaseDurationMs accepts m/h/d/w and decimals; an unparseable estimate falls back to defaultLease whole", () => {
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "30m" }), DEFAULTS.defaultLeaseMs); // clamped up, still a derivation
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "4h" }), AGENT_ACTIVE_HOUR_MS * 4 * 0.5);
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1d" }), AGENT_ACTIVE_DAY_MS * 0.5);
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1w" }), DEFAULTS.maxLeaseMs); // clamped down
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1.5h" }), Math.round(AGENT_ACTIVE_HOUR_MS * 1.5 * 0.5));

  for (const unparseable of ["banana", "0h", "-1h", undefined, null]) {
    assert.equal(
      deriveLeaseDurationMs({ estimatedEffort: unparseable as string | null | undefined }),
      DEFAULTS.defaultLeaseMs,
      `expected defaultLease for ${JSON.stringify(unparseable)}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. [coordination] figures change the result; absent table/keys mean defaults.
// ---------------------------------------------------------------------------

test("custom leaseFactor/defaultLease/maxLease change the derived result; an absent table or absent keys mean the D10 defaults", () => {
  const leaseFactorOne = resolveCoordinationSettings({ leaseFactor: 1 });
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "4h", coordination: leaseFactorOne }), AGENT_ACTIVE_HOUR_MS * 4);

  const tightMax = resolveCoordinationSettings({ maxLease: "1h" });
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "1d", coordination: tightMax }), AGENT_ACTIVE_HOUR_MS);

  // Absent table entirely.
  assert.deepEqual(resolveCoordinationSettings(undefined), { leaseFactor: 0.5, defaultLeaseMs: 30 * 60 * 1000, maxLeaseMs: AGENT_ACTIVE_HOUR_MS * 8 });
  // Table present, but every key absent -- same defaults.
  assert.deepEqual(resolveCoordinationSettings({}), resolveCoordinationSettings(undefined));
});

// ---------------------------------------------------------------------------
// 4. Validation refuses with an actionable message naming the key (and, for
// a file, the path) -- never degrades to a default.
// ---------------------------------------------------------------------------

test("resolveCoordinationSettings refuses an invalid leaseFactor (zero, negative, NaN, a string), naming the key", () => {
  for (const bad of [0, -1, NaN, "0.5" as unknown as number]) {
    assert.throws(
      () => resolveCoordinationSettings({ leaseFactor: bad as number }),
      (error: Error) => {
        assert.match(error.message, /leaseFactor/, `${JSON.stringify(bad)}: ${error.message}`);
        return true;
      }
    );
  }
});

test("resolveCoordinationSettings refuses a non-duration defaultLease/maxLease, naming the offending key", () => {
  assert.throws(
    () => resolveCoordinationSettings({ defaultLease: "soon" }),
    (error: Error) => { assert.match(error.message, /defaultLease/); return true; }
  );
  assert.throws(
    () => resolveCoordinationSettings({ maxLease: "forever" }),
    (error: Error) => { assert.match(error.message, /maxLease/); return true; }
  );
});

test("T-143 review F1: resolveCoordinationSettings refuses a maxLease above the 24h absolute ceiling, naming the number; exactly 24h is accepted at the boundary", () => {
  assert.equal(ABSOLUTE_LEASE_CEILING_MS, 24 * 60 * 60 * 1000, "sanity: the ceiling this test probes against");

  // Exactly at the ceiling: accepted.
  const atCeiling = resolveCoordinationSettings({ maxLease: "24h" });
  assert.equal(atCeiling.maxLeaseMs, ABSOLUTE_LEASE_CEILING_MS);

  // 1 minute over (1441m = 24h + 1m; the duration grammar takes one unit at a
  // time, no "24h1m" combined form): refused, citing the ceiling.
  assert.throws(
    () => resolveCoordinationSettings({ maxLease: "1441m" }),
    (error: Error) => {
      assert.match(error.message, /maxLease/);
      assert.match(error.message, /24h/, `must name the 24h ceiling: ${error.message}`);
      return true;
    }
  );

  // Comfortably over: same refusal, same ceiling named.
  assert.throws(
    () => resolveCoordinationSettings({ maxLease: "30h" }),
    (error: Error) => {
      assert.match(error.message, /maxLease/);
      assert.match(error.message, /24h/, `must name the 24h ceiling: ${error.message}`);
      return true;
    }
  );
});

test("resolveCoordinationSettings refuses defaultLease > maxLease, naming both keys (the clamp would have no room)", () => {
  assert.throws(
    () => resolveCoordinationSettings({ defaultLease: "4h", maxLease: "1h" }),
    (error: Error) => {
      assert.match(error.message, /defaultLease/);
      assert.match(error.message, /maxLease/);
      return true;
    }
  );
});

test("readMapctxToml refuses an invalid [coordination] table and names both the key and the file path", () => {
  const dir = mkTmpDir("mapctx-lease-config-");
  try {
    const projectId = "00000000-0000-0000-0000-00000000c0c0";
    const tomlPath = path.join(dir, "mapctx.toml");
    const cases: Array<{ label: string; coordination: string; expectKey: RegExp }> = [
      { label: "bad leaseFactor", coordination: 'leaseFactor = -1\n', expectKey: /leaseFactor/ },
      { label: "bad defaultLease", coordination: 'defaultLease = "nope"\n', expectKey: /defaultLease/ },
      { label: "bad maxLease", coordination: 'maxLease = "nope"\n', expectKey: /maxLease/ },
      { label: "defaultLease > maxLease", coordination: 'defaultLease = "4h"\nmaxLease = "1h"\n', expectKey: /defaultLease/ }
    ];
    for (const { label, coordination, expectKey } of cases) {
      fs.writeFileSync(tomlPath, [
        "schemaVersion = 1",
        `projectId = "${projectId}"`,
        'plansAuthority = "store"',
        "",
        "[coordination]",
        coordination
      ].join("\n"), "utf8");
      assert.throws(
        () => readMapctxToml(tomlPath),
        (error: Error) => {
          assert.match(error.message, expectKey, `${label}: ${error.message}`);
          assert.ok(error.message.includes(tomlPath), `${label}: message must name the file path: ${error.message}`);
          return true;
        },
        label
      );
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 5. Round-trip through serializeMapctxToml / readMapctxToml.
// ---------------------------------------------------------------------------

test("serializeMapctxToml -> readMapctxToml preserves a partial [coordination] block; a config with none gets no table at all", () => {
  const dir = mkTmpDir("mapctx-lease-roundtrip-");
  try {
    const projectId = "00000000-0000-0000-0000-00000000c0c1";
    const withCoordination: MapctxTomlConfig = {
      schemaVersion: 1, projectId, plansAuthority: "store",
      coordination: { leaseFactor: 0.75, maxLease: "4h" }
    };
    const serialized = serializeMapctxToml(withCoordination);
    assert.match(serialized, /\[coordination\]/);
    const tomlPath = path.join(dir, "mapctx.toml");
    fs.writeFileSync(tomlPath, serialized, "utf8");
    const reread = readMapctxToml(tomlPath);
    assert.deepEqual(reread.coordination, { leaseFactor: 0.75, maxLease: "4h" });

    const withoutCoordination: MapctxTomlConfig = { schemaVersion: 1, projectId, plansAuthority: "store" };
    const serializedBare = serializeMapctxToml(withoutCoordination);
    assert.ok(!serializedBare.includes("[coordination]"), "no [coordination] table when the config carries none");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 6. Claim end to end at the store level.
// ---------------------------------------------------------------------------

test("claimTask derives the lease from estimatedEffort; an explicit leaseDurationMs wins; an epic with no estimate gets defaultLease whole", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const now = () => new Date("2026-10-14T10:00:00.000Z");

    const derivedTask = createTask(handle, { id: "T-900", title: "Derived lease task", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(derivedTask.ok, true, JSON.stringify(derivedTask));
    const derivedClaim = claimTask(handle, { taskId: "T-900", actor: "worker", now });
    assert.ok(derivedClaim.ok, JSON.stringify(derivedClaim));
    if (derivedClaim.ok) {
      const durationMs = new Date(derivedClaim.claim.expiresAt).getTime() - new Date(derivedClaim.claim.claimedAt).getTime();
      assert.equal(durationMs, AGENT_ACTIVE_HOUR_MS * 4 * 0.5, "4h x 0.5 = 2h derived");
    }

    const explicitTask = createTask(handle, { id: "T-901", title: "Explicit override task", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(explicitTask.ok, true, JSON.stringify(explicitTask));
    const explicitClaim = claimTask(handle, { taskId: "T-901", actor: "worker", now, leaseDurationMs: 999_999 });
    assert.ok(explicitClaim.ok, JSON.stringify(explicitClaim));
    if (explicitClaim.ok) {
      const durationMs = new Date(explicitClaim.claim.expiresAt).getTime() - new Date(explicitClaim.claim.claimedAt).getTime();
      assert.equal(durationMs, 999_999, "an explicit leaseDurationMs wins over the derived value entirely");
    }

    const epic = createTask(handle, { title: "Unestimated epic", type: "epic", actor: "test" });
    assert.equal(epic.ok, true, JSON.stringify(epic));
    if (!epic.ok) return;
    const epicClaim = claimTask(handle, { taskId: epic.taskId, actor: "worker", now });
    assert.ok(epicClaim.ok, JSON.stringify(epicClaim));
    if (epicClaim.ok) {
      const durationMs = new Date(epicClaim.claim.expiresAt).getTime() - new Date(epicClaim.claim.claimedAt).getTime();
      assert.equal(durationMs, DEFAULT_LEASE_DURATION_MS, "no parseable estimate (an epic) gets defaultLease whole");
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 7. Renew extends by the same derived duration, re-read from the plan.
// ---------------------------------------------------------------------------

test("renewClaim extends by the derived duration (not a fixed 30m); a later re-classification changes the NEXT renewal's duration", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claimedAt = () => new Date("2026-10-14T10:00:00.000Z");
    const created = createTask(handle, { id: "T-902", title: "Renew task", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const claim = claimTask(handle, { taskId: "T-902", actor: "worker", now: claimedAt });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;

    const firstRenewAt = () => new Date("2026-10-14T10:30:00.000Z"); // still well inside the 2h-derived lease
    const firstRenew = renewClaim(handle, { taskId: "T-902", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "worker", now: firstRenewAt });
    assert.ok(firstRenew.ok, JSON.stringify(firstRenew));
    if (firstRenew.ok) {
      const durationMs = new Date(firstRenew.claim.expiresAt).getTime() - firstRenewAt().getTime();
      assert.equal(durationMs, AGENT_ACTIVE_HOUR_MS * 4 * 0.5, "renewal extends by the same 2h derived duration, not a fixed 30m");
    }

    // Mid-flight re-classification: the plan now says 10h, which derives to
    // 5h (10h x 0.5 = 5h, inside the clamp) -- a different number from the
    // 2h the claim and first renewal used.
    const updated = updateTask(handle, { taskId: "T-902", detailPatch: { estimatedEffort: "10h" }, actor: "test" });
    assert.equal(updated.ok, true, JSON.stringify(updated));

    const secondRenewAt = () => new Date("2026-10-14T10:45:00.000Z");
    const secondRenew = renewClaim(handle, { taskId: "T-902", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "worker", now: secondRenewAt });
    assert.ok(secondRenew.ok, JSON.stringify(secondRenew));
    if (secondRenew.ok) {
      const durationMs = new Date(secondRenew.claim.expiresAt).getTime() - secondRenewAt().getTime();
      assert.equal(durationMs, AGENT_ACTIVE_HOUR_MS * 10 * 0.5, "the NEXT renewal re-reads the plan and honours the new estimate, not the one the claim was minted with");
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 8. T-162: claimedAt and expiresAt must come from the SAME clock read.
//
// `expiresAt` has always been derived from `nowMs`, read once at the top of
// `appendTaskClaim`. `claimedAt` used to be a SECOND, separate read taken
// later -- after the admission checks, the lease derivation and two token
// generations. Whatever happened in between (a GC pause, a descheduled
// process under a parallel test run) silently shortened the duration the row
// declares, because `expiresAt - claimedAt` is how every consumer reads it
// back. These inject a clock that is NOT constant -- it returns `base` on
// its first call and `base + pauseMs` on every call after -- to reproduce
// that pause deterministically instead of relying on real wall-clock luck.
// ---------------------------------------------------------------------------

/**
 * First call returns `base`; every call after returns `base + pauseMs`
 * (not cumulative further). Models "time passed once, between two reads",
 * which is exactly the gap the old `appendTaskClaim` had between its
 * `nowMs` read and its separate `claimedAt` read.
 */
function pausedClock(baseIso: string, pauseMs: number): () => Date {
  const base = new Date(baseIso).getTime();
  let calls = 0;
  return () => new Date(base + (calls++ === 0 ? 0 : pauseMs));
}

test("T-162: a 62ms pause between clock reads no longer drifts an EXPLICIT leaseDurationMs claim", t => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-910", title: "Explicit lease, paused clock", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));

    const paused = pausedClock("2026-10-14T10:00:00.000Z", 62);
    const claim = claimTask(handle, { taskId: "T-910", actor: "worker", now: paused, leaseDurationMs: 28_800_000 /* 8h, the T-141 CLI case */ });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    assert.equal(claim.claim.claimedAt, "2026-10-14T10:00:00.000Z", "claimedAt must be the FIRST read (nowMs), not a later one");
    const durationMs = new Date(claim.claim.expiresAt).getTime() - new Date(claim.claim.claimedAt).getTime();
    assert.equal(durationMs, 28_800_000, "exact 8h, not 8h minus the 62ms pause");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-162: a 62ms pause between clock reads no longer drifts a lease DERIVED from estimatedEffort", t => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-911", title: "Derived lease, paused clock", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));

    const paused = pausedClock("2026-10-14T11:00:00.000Z", 62);
    // No leaseDurationMs: derives from estimatedEffort (4h x 0.5 = 2h), same
    // path as the T-141 CLI test that originally saw the drift.
    const claim = claimTask(handle, { taskId: "T-911", actor: "worker", now: paused });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    assert.equal(claim.claim.claimedAt, "2026-10-14T11:00:00.000Z");
    const durationMs = new Date(claim.claim.expiresAt).getTime() - new Date(claim.claim.claimedAt).getTime();
    assert.equal(durationMs, AGENT_ACTIVE_HOUR_MS * 4 * 0.5, "exact 2h derived duration, not 2h minus the pause");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-162: with no pause at all (clock constant across both reads), the duration was already exact -- sanity companion to the paused cases", t => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-912", title: "No pause, constant clock", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));

    const constant = pausedClock("2026-10-14T12:00:00.000Z", 0);
    const claim = claimTask(handle, { taskId: "T-912", actor: "worker", now: constant, leaseDurationMs: 28_800_000 });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const durationMs = new Date(claim.claim.expiresAt).getTime() - new Date(claim.claim.claimedAt).getTime();
    assert.equal(durationMs, 28_800_000);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
