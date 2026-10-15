import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import test from "node:test"
import { AGENT_ACTIVE_HOUR_MS, AGENT_ACTIVE_WEEK_MS } from "@mapctx/protocol"
import { DEFAULT_LEASE_DURATION_MS, appendRunEventClaimRenewal, claimTask, deriveLeaseDurationMs, renewClaim } from "./claims"
import { ABSOLUTE_LEASE_CEILING_MS, DEFAULT_REVIEW_LEASE_FACTOR, resolveCoordinationSettings, readMapctxToml } from "./config"
import { recordDispatchAttempt } from "./dispatch"
import { createTask } from "./tasks"
import { StoreHandle } from "./store-handle"
import { importCommit } from "./cutover"
import { cleanupDir, mkTmpDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-144 (C5 / D11): a review lease is derived by the SAME formula as the
 * implement lease, scaled by `reviewLeaseFactor` (default 2, both halves of
 * the clamp): `clamp(effort x leaseFactor x reviewLeaseFactor, defaultLease,
 * min(maxLease x reviewLeaseFactor, ABSOLUTE_LEASE_CEILING_MS))`.
 */

const DEFAULTS = resolveCoordinationSettings(undefined);

test("defaults: an implement lease is clamped at <= 8h, the SAME plan's review lease at <= 16h (the 2x factor)", () => {
  // At the implement ceiling (16h x 0.5 = 8h), review derives 16h x 0.5 x 2 = 16h.
  const implementAtCeiling = deriveLeaseDurationMs({ estimatedEffort: "16h" });
  assert.equal(implementAtCeiling, DEFAULTS.maxLeaseMs);
  assert.equal(implementAtCeiling, 8 * AGENT_ACTIVE_HOUR_MS);

  const reviewAtCeiling = deriveLeaseDurationMs({ estimatedEffort: "16h", role: "review" });
  assert.equal(reviewAtCeiling, 16 * AGENT_ACTIVE_HOUR_MS, "review ceiling is maxLeaseMs x reviewLeaseFactor = 8h x 2 = 16h");
  assert.equal(reviewAtCeiling, DEFAULTS.maxLeaseMs * DEFAULT_REVIEW_LEASE_FACTOR);

  // Strictly inside the clamp (4h task): implement 2h, review 4h -- exactly double.
  const implementMid = deriveLeaseDurationMs({ estimatedEffort: "4h" });
  const reviewMid = deriveLeaseDurationMs({ estimatedEffort: "4h", role: "review" });
  assert.equal(implementMid, 2 * AGENT_ACTIVE_HOUR_MS);
  assert.equal(reviewMid, 4 * AGENT_ACTIVE_HOUR_MS);
  assert.equal(reviewMid, implementMid * DEFAULT_REVIEW_LEASE_FACTOR);
});

test("maxLease = 2h: implement is capped at 2h, review's ceiling is 2h x 2 = 4h", () => {
  const settings = resolveCoordinationSettings({ maxLease: "2h" });
  assert.equal(settings.maxLeaseMs, 2 * AGENT_ACTIVE_HOUR_MS);

  // A task whose derived implement lease would already exceed 2h (8h x 0.5 = 4h) is capped at maxLease.
  const implement = deriveLeaseDurationMs({ estimatedEffort: "8h", coordination: settings });
  assert.equal(implement, 2 * AGENT_ACTIVE_HOUR_MS);

  const review = deriveLeaseDurationMs({ estimatedEffort: "8h", coordination: settings, role: "review" });
  assert.equal(review, 4 * AGENT_ACTIVE_HOUR_MS, "review ceiling tracks maxLease x reviewLeaseFactor, not the absolute 24h ceiling, when maxLease is small");
});

test("maxLease = 24h: the review ceiling would derive 48h and is cut to exactly 24h (ABSOLUTE_LEASE_CEILING_MS)", () => {
  const settings = resolveCoordinationSettings({ maxLease: "24h" });
  assert.equal(settings.maxLeaseMs, ABSOLUTE_LEASE_CEILING_MS);

  // A huge estimate saturates both lanes against their respective ceilings.
  const implement = deriveLeaseDurationMs({ estimatedEffort: "2w", coordination: settings });
  assert.equal(implement, ABSOLUTE_LEASE_CEILING_MS, "implement saturates at maxLease (24h)");

  const review = deriveLeaseDurationMs({ estimatedEffort: "2w", coordination: settings, role: "review" });
  assert.equal(review, ABSOLUTE_LEASE_CEILING_MS, "review would derive 48h (24h x 2) but is cut to exactly 24h, not 48h");
});

test("review is always >= implement for the same plan, even saturated at the ceiling (e.g. a 2w task)", () => {
  const implement = deriveLeaseDurationMs({ estimatedEffort: "2w" });
  const review = deriveLeaseDurationMs({ estimatedEffort: "2w", role: "review" });
  assert.ok(review >= implement, `review (${review}ms) must be >= implement (${implement}ms)`);
  assert.equal(implement, DEFAULTS.maxLeaseMs, "sanity: 2w saturates the implement ceiling");
  assert.equal(review, Math.min(DEFAULTS.maxLeaseMs * DEFAULT_REVIEW_LEASE_FACTOR, ABSOLUTE_LEASE_CEILING_MS));

  // Sanity on the duration grammar used above.
  assert.ok(AGENT_ACTIVE_WEEK_MS > 0);
});

test("a task with no parseable estimate gets defaultLease whole in BOTH lanes", () => {
  for (const unparseable of ["banana", "0h", "-1h", undefined, null]) {
    const implement = deriveLeaseDurationMs({ estimatedEffort: unparseable as string | null | undefined });
    const review = deriveLeaseDurationMs({ estimatedEffort: unparseable as string | null | undefined, role: "review" });
    assert.equal(implement, DEFAULTS.defaultLeaseMs, `implement, ${JSON.stringify(unparseable)}`);
    assert.equal(review, DEFAULTS.defaultLeaseMs, `review, ${JSON.stringify(unparseable)}: the clamp has nothing to clamp, no review-specific floor exists`);
  }
  // An epic claim (no estimate at all, options.estimatedEffort omitted).
  assert.equal(deriveLeaseDurationMs({}), DEFAULT_LEASE_DURATION_MS);
  assert.equal(deriveLeaseDurationMs({ role: "review" }), DEFAULT_LEASE_DURATION_MS);
});

test("resolveCoordinationSettings refuses an invalid reviewLeaseFactor (zero, negative, NaN, a string), naming the key -- same refusal shape as leaseFactor", () => {
  for (const bad of [0, -1, NaN, "2" as unknown as number]) {
    assert.throws(
      () => resolveCoordinationSettings({ reviewLeaseFactor: bad as number }),
      (error: Error) => {
        assert.match(error.message, /reviewLeaseFactor/, `${JSON.stringify(bad)}: ${error.message}`);
        return true;
      }
    );
  }
});

test("readMapctxToml refuses an invalid [coordination] reviewLeaseFactor and names both the key and the file path", () => {
  const dir = mkTmpDir("mapctx-review-lease-config-");
  try {
    const projectId = "00000000-0000-0000-0000-00000000d0d0";
    const tomlPath = path.join(dir, "mapctx.toml");
    fs.writeFileSync(tomlPath, [
      "schemaVersion = 1",
      `projectId = "${projectId}"`,
      'plansAuthority = "store"',
      "",
      "[coordination]",
      "reviewLeaseFactor = -2",
      ""
    ].join("\n"), "utf8");
    assert.throws(
      () => readMapctxToml(tomlPath),
      (error: Error) => {
        assert.match(error.message, /reviewLeaseFactor/, error.message);
        assert.ok(error.message.includes(tomlPath), `must name the file path: ${error.message}`);
        return true;
      }
    );
  } finally {
    cleanupDir(dir);
  }
});

test("a factor below 1 is accepted (a deliberate operator choice for shorter review leases), and the clamp's ceiling-first-or-floor-last rule still holds", () => {
  // reviewLeaseFactor only requires positivity; a value below 1 inverts D11's
  // "review is longer" default on purpose, and this file lets the operator
  // make that choice rather than refusing it (unlike leaseFactor <= 0).
  const settings = resolveCoordinationSettings({ reviewLeaseFactor: 0.5, maxLease: "4h" });
  assert.equal(settings.reviewLeaseFactor, 0.5);

  // Ceiling: maxLease x factor = 4h x 0.5 = 2h -- LOWER than maxLeaseMs itself
  // (4h). The implementation's documented invariant is that the ceiling must
  // win over the floor in exactly this case (claims.ts:83-89): without the
  // ordering, a config asking for a SHORTER review lease would silently hand
  // out a longer one.
  const review = deriveLeaseDurationMs({ estimatedEffort: "16h", coordination: settings, role: "review" }); // would derive 16h x 0.5 x 0.5 = 4h, way above the 2h review ceiling
  assert.equal(review, 2 * AGENT_ACTIVE_HOUR_MS, "the review ceiling (maxLease x factor) must win over the derived figure, even though it is below maxLeaseMs itself");
});

test("the review ceiling wins even when the factor pushes it BELOW defaultLease -- the case the clamp's floor-then-ceiling order exists for", () => {
  // The case above has a review ceiling of 2h, comfortably ABOVE the 30m
  // floor, so it never asks which of the two wins. Here the factor drives the
  // review ceiling (1h x 0.1 = 6m) UNDER `defaultLease` (30m), which is the
  // only configuration where the order is observable: `Math.min(Math.max(
  // derived, floor), ceiling)` yields the ceiling, so an operator who asked
  // for very short review leases gets them. Applying the floor last would
  // hand out 30m instead -- five times what was configured -- and the
  // invariant would be a comment rather than a behaviour.
  const settings = resolveCoordinationSettings({ maxLease: "1h", reviewLeaseFactor: 0.1 });
  assert.ok(settings.maxLeaseMs > DEFAULTS.defaultLeaseMs, "sanity: config still requires defaultLease <= maxLease");
  const reviewCeilingMs = settings.maxLeaseMs * settings.reviewLeaseFactor;
  assert.ok(reviewCeilingMs < settings.defaultLeaseMs, `sanity: the review ceiling (${reviewCeilingMs}ms) must be below the floor (${settings.defaultLeaseMs}ms) for this case to mean anything`);

  const review = deriveLeaseDurationMs({ estimatedEffort: "16h", coordination: settings, role: "review" });
  assert.equal(review, reviewCeilingMs, "the ceiling wins over the floor on the review side");
  assert.ok(review < settings.defaultLeaseMs, "and the result is genuinely shorter than defaultLease, which is what was asked for");

  // The implement side is unaffected: config guarantees its floor and ceiling
  // cannot cross, so it still lands on maxLease.
  assert.equal(deriveLeaseDurationMs({ estimatedEffort: "16h", coordination: settings }), settings.maxLeaseMs);
});

test("an explicit --lease (leaseDurationMs) wins over both the implement and review derivations, and the 24h refusal elsewhere is unaffected by role", () => {
  // deriveLeaseDurationMs itself has no leaseDurationMs override -- that
  // precedence lives one level up, in appendTaskClaim (claims.ts:309-310),
  // which is already exercised end-to-end by lease-duration.test.ts's
  // "claimTask derives the lease ... an explicit leaseDurationMs wins" case.
  // This test pins the piece that lives in THIS file: resolveCoordinationSettings
  // still refuses a maxLease above the absolute ceiling regardless of
  // reviewLeaseFactor, since maxLease is refused before the factor is ever
  // applied to it.
  assert.throws(
    () => resolveCoordinationSettings({ maxLease: "25h", reviewLeaseFactor: 1 }),
    (error: Error) => {
      assert.match(error.message, /maxLease/);
      assert.match(error.message, /24h/i);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 8. D11's wiring end to end at the store level: mint, renew (explicit and
//    by run event) for BOTH lanes on the SAME task/plan, pinned to exact
//    millisecond figures rather than "review > implement" alone -- the three
//    sites this round's review found drifting back to a hardcoded
//    `role: "implement"` (H, I, I2).
// ---------------------------------------------------------------------------

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

const FOUR_HOURS_MS = 4 * AGENT_ACTIVE_HOUR_MS;
const IMPLEMENT_MS = FOUR_HOURS_MS * 0.5; // 2h
const REVIEW_MS = IMPLEMENT_MS * DEFAULT_REVIEW_LEASE_FACTOR; // 4h

test("minting: a Normal/4h task's implement claim is exactly 2h, its review claim exactly 4h -- double, not merely longer", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-800", title: "D11 wiring", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const now = () => new Date("2026-10-17T09:00:00.000Z");

    const implement = claimTask(handle, { taskId: "T-800", actor: "worker", kind: "implement", now });
    assert.ok(implement.ok, JSON.stringify(implement));
    if (!implement.ok) return;
    const implementMs = new Date(implement.claim.expiresAt).getTime() - new Date(implement.claim.claimedAt).getTime();
    assert.equal(implementMs, IMPLEMENT_MS);
    assert.equal(implementMs, deriveLeaseDurationMs({ estimatedEffort: "4h" }));

    const review = claimTask(handle, { taskId: "T-800", actor: "reviewer", kind: "review", now });
    assert.ok(review.ok, JSON.stringify(review));
    if (!review.ok) return;
    const reviewMs = new Date(review.claim.expiresAt).getTime() - new Date(review.claim.claimedAt).getTime();
    assert.equal(reviewMs, REVIEW_MS);
    assert.equal(reviewMs, deriveLeaseDurationMs({ estimatedEffort: "4h", role: "review" }));
    assert.equal(reviewMs, implementMs * DEFAULT_REVIEW_LEASE_FACTOR);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("explicit renewClaim re-derives by the claim's OWN lane: a review claim renews to now+4h, an implement claim to now+2h, on the same plan", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-801", title: "D11 wiring renew", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const claimedAt = () => new Date("2026-10-17T09:00:00.000Z");

    const implement = claimTask(handle, { taskId: "T-801", actor: "worker", kind: "implement", now: claimedAt });
    const review = claimTask(handle, { taskId: "T-801", actor: "reviewer", kind: "review", now: claimedAt });
    assert.ok(implement.ok && review.ok, JSON.stringify({ implement, review }));
    if (!implement.ok || !review.ok) return;

    const renewAt = () => new Date("2026-10-17T09:30:00.000Z"); // well inside both leases
    const renewedImplement = renewClaim(handle, { taskId: "T-801", claimId: implement.claim.claimId, leaseToken: implement.claim.leaseToken, actor: "worker", now: renewAt });
    assert.ok(renewedImplement.ok, JSON.stringify(renewedImplement));
    if (renewedImplement.ok) {
      const claim = renewedImplement.claim as { expiresAt: string };
      assert.equal(new Date(claim.expiresAt).getTime(), renewAt().getTime() + IMPLEMENT_MS, "implement renews to now + 2h");
    }

    const renewedReview = renewClaim(handle, { taskId: "T-801", claimId: review.claim.claimId, leaseToken: review.claim.leaseToken, actor: "reviewer", now: renewAt });
    assert.ok(renewedReview.ok, JSON.stringify(renewedReview));
    if (renewedReview.ok) {
      const claim = renewedReview.claim as { expiresAt: string };
      assert.equal(new Date(claim.expiresAt).getTime(), renewAt().getTime() + REVIEW_MS, "review renews to now + 4h -- this is the mutation H/I site: role: 'implement' hardcoded at mint or at renewal would both collapse this to 2h");
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("renewal by run event (appendRunEventClaimRenewal) on a REVIEW dispatch also re-derives on the review lane: now+4h, not now+2h", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-802", title: "D11 wiring run-event renew", workload: "Normal", detail: { estimatedEffort: "4h" }, actor: "test" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const claimedAt = () => new Date("2026-10-17T09:00:00.000Z");

    const review = claimTask(handle, { taskId: "T-802", actor: "reviewer", kind: "review", now: claimedAt });
    assert.ok(review.ok, JSON.stringify(review));
    if (!review.ok) return;
    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "11112222-3333-4444-8555-666677778888", taskId: "T-802", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const renewAt = () => new Date("2026-10-17T09:30:00.000Z");
    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: "11112222-3333-4444-8555-666677778888", attempt: 1, actor: "reviewer", now: renewAt },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, true, JSON.stringify(result));
    if (!result.renewed) return;
    assert.equal(result.claimId, review.claim.claimId);
    assert.equal(new Date(result.expiresAt).getTime(), renewAt().getTime() + REVIEW_MS, "a review dispatch's run-event renewal must re-derive on the REVIEW lane (now + 4h), this is the I2 mutation site");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
