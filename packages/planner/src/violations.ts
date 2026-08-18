import { createHash } from "node:crypto";
import type { ClaimViolation, ResourceClaim, RunReceipt } from "@mapctx/protocol";

/** A receipt paired with task identity. Store builds these from its projections. */
export type TaskReceipt = { taskId: string; receipt: RunReceipt };

export type ViolationWave = {
  /** Stable protocol wave id. */
  waveId: string;
  taskIds: readonly string[];
  receipts?: readonly TaskReceipt[];
};

export type SerializedPairForViolations = {
  taskAId: string;
  taskBId: string;
  /** Planning-time claim/path explanation from planExecution.serializedPairs. */
  paths?: readonly string[];
  causes?: readonly { paths: readonly string[] }[];
};

export type ClaimViolationInput = {
  waves?: readonly ViolationWave[];
  /** Single-wave shorthand for callers processing one completed wave. */
  waveId?: string;
  taskIds?: readonly string[];
  receipts: readonly TaskReceipt[];
  serializedPairs?: readonly SerializedPairForViolations[];
  claims?: readonly ResourceClaim[];
  detectedAt?: string;
};

function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function staticPrefix(value: string): string {
  const wildcard = value.search(/[?*\[]/);
  return normalizePath(wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/$/, "");
}

/** Glob-ish path overlap, deliberately matching planner scheduling semantics. */
export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aPrefix = staticPrefix(a);
  const bPrefix = staticPrefix(b);
  if (aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;
  const aDir = a.endsWith("/**") || a.endsWith("/*") || a.endsWith("/");
  const bDir = b.endsWith("/**") || b.endsWith("/*") || b.endsWith("/");
  if (aDir && b.startsWith(`${a.slice(0, a.lastIndexOf("/"))}/`)) return true;
  if (bDir && a.startsWith(`${b.slice(0, b.lastIndexOf("/"))}/`)) return true;
  return false;
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8).join(""), hex.slice(8, 12).join(""), hex.slice(12, 16).join(""), hex.slice(16, 20).join(""), hex.slice(20).join("")].join("-");
}

function actualIntersection(a: TaskReceipt, b: TaskReceipt): string[] {
  return [...new Set(a.receipt.changedFiles.flatMap(left => b.receipt.changedFiles.filter(right => pathsOverlap(left, right)).map(normalizePath)))].sort();
}

function claimCovers(claims: readonly ResourceClaim[], taskId: string, actualPath: string): boolean {
  return claims.some(claim => claim.taskId === taskId && claim.mode === "write" && claim.paths.some(path => pathsOverlap(path, actualPath)));
}

function pairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}:${b}` : `${b}:${a}`;
}

function violationId(input: Omit<ClaimViolation, "id">): string {
  return stableUuid(`mapctx:claim-violation:${JSON.stringify(input)}`);
}

function makeViolation(input: Omit<ClaimViolation, "id">): ClaimViolation {
  return { ...input, id: violationId(input) };
}

/**
 * Derive post-hoc claim feedback. Incomplete or failed receipts produce no
 * output for their wave. Function is deterministic for fixed receipts and
 * detection timestamp; no recalibration occurs here.
 */
export function detectClaimViolations(input: ClaimViolationInput): ClaimViolation[] {
  const waves = input.waves ?? (input.waveId && input.taskIds ? [{ waveId: input.waveId, taskIds: input.taskIds }] : []);
  const receiptItems = [...input.receipts, ...waves.flatMap(wave => wave.receipts ?? [])];
  const receiptsByTask = new Map(receiptItems.map(item => [item.taskId, item]));
  const claims = input.claims ?? [];
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const violations: ClaimViolation[] = [];

  for (const wave of waves) {
    const waveReceipts = wave.taskIds.map(taskId => receiptsByTask.get(taskId));
    // Ground truth exists only once every dispatch is terminal and successful.
    if (waveReceipts.some(item => !item || item.receipt.outcome !== "completed")) continue;
    for (let i = 0; i < waveReceipts.length; i += 1) {
      for (let j = i + 1; j < waveReceipts.length; j += 1) {
        const left = waveReceipts[i]!;
        const right = waveReceipts[j]!;
        for (const path of actualIntersection(left, right)) {
          if (claimCovers(claims, left.taskId, path) && claimCovers(claims, right.taskId, path)) continue;
          const [taskAId, taskBId] = [left.taskId, right.taskId].sort();
          violations.push(makeViolation({ waveId: wave.waveId, kind: "collision", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
        }
      }
    }
  }

  // Overbroad pairs are only reportable after both tasks have successful
  // receipts. Their actual files must not intersect at all.
  for (const pair of input.serializedPairs ?? []) {
    const left = receiptsByTask.get(pair.taskAId);
    const right = receiptsByTask.get(pair.taskBId);
    if (!left || !right || left.receipt.outcome !== "completed" || right.receipt.outcome !== "completed") continue;
    if (actualIntersection(left, right).length > 0) continue;
    const wave = waves.find(candidate => candidate.taskIds.includes(pair.taskAId)) ?? waves[0];
    if (!wave) continue;
    const paths = [...new Set([...(pair.paths ?? []), ...(pair.causes ?? []).flatMap(cause => cause.paths)])].map(normalizePath).filter(Boolean).sort();
    for (const path of paths) {
      const [taskAId, taskBId] = [pair.taskAId, pair.taskBId].sort();
      violations.push(makeViolation({ waveId: wave.waveId, kind: "overbroad", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
    }
  }

  const seen = new Set<string>();
  return violations
    .filter(item => {
      const key = `${item.waveId}:${item.kind}:${pairKey(item.taskAId, item.taskBId)}:${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.waveId.localeCompare(b.waveId) || a.kind.localeCompare(b.kind) || a.taskAId.localeCompare(b.taskAId) || a.taskBId.localeCompare(b.taskBId) || a.path.localeCompare(b.path));
}

export const deriveClaimViolations = detectClaimViolations;
export const detectViolations = detectClaimViolations;
export const detectWaveClaimViolations = detectClaimViolations;
