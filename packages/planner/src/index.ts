import { createHash } from "node:crypto";
import type {
  DependencyEdge,
  ResourceClaim,
  Task,
  WorkflowGate
} from "@mapctx/protocol";
import { STATUS_TO_PLANNING } from "@mapctx/protocol";

/** Task fields accepted by the planner. `dependsOn` keeps board input ergonomic. */
export type PlannerTask = Partial<Task> & {
  id: string;
  title?: string;
  status?: string;
  type?: string;
  parent?: string | null;
  parentId?: string | null;
  dependsOn?: readonly string[];
  /** Store-owned task-detail paths, promoted to planner claims by the CLI. */
  filesAffected?: readonly string[];
  paths?: readonly string[];
  touch?: readonly string[];
  workflowGates?: readonly WorkflowGate[];
  requiredGates?: readonly string[];
  executorKind?: string;
  executor?: string;
};

export type ExecutorCapacity = number | Readonly<Record<string, number>>;

export type PlannerInput = {
  tasks: readonly PlannerTask[];
  dependencyEdges?: readonly DependencyEdge[];
  resourceClaims?: readonly ResourceClaim[];
  /** Alias for callers that already name this collection `claims`. */
  claims?: readonly ResourceClaim[];
  workflowGates?: readonly WorkflowGate[];
  requiredGates?: readonly string[];
  executorCapacity?: ExecutorCapacity;
  /** Alias for executorCapacity. */
  maxExecutors?: number;
};

export type ClaimCollision = {
  taskAId: string;
  taskBId: string;
  claims: ResourceClaim[];
  claimIds: string[];
  causes: Array<{
    claimA: ResourceClaim;
    claimB: ResourceClaim;
    domains: string[];
    paths: string[];
  }>;
  taskAClaimIds: string[];
  taskBClaimIds: string[];
  domains: string[];
  paths: string[];
  reason: "resource-claim-collision";
};

/** A weak inferred-domain overlap that is shown but never changes wave placement. */
export type ClaimAdvisory = Omit<ClaimCollision, "reason"> & {
  reason: "low-confidence-inferred-domain-overlap";
};

export type PlannedTask = {
  id: string;
  title: string;
  status: string;
  type: string;
  dependsOn: string[];
  executorKind: string;
};

export type PlanWave = {
  wave: number;
  tasks: PlannedTask[];
  taskIds: string[];
};

export type PlannerPolicy = {
  scheduling: "collision-aware";
  claimsAreAdvisory: true;
  correctnessBackstop: "worktree-merge";
  guarantee: "none";
  explanation: "serialized-pairs";
};

export type PlanReport = {
  waves: PlanWave[];
  waveByTaskId: Record<string, number>;
  serializedPairs: ClaimCollision[];
  /**
   * Backward-compatible additive warnings; do not affect scheduling. Emitted
   * only for pairs actually considered in a shared wave, so capacity changes
   * which advisories are present.
   */
  advisories?: ClaimAdvisory[];
  claims: ResourceClaim[];
  /** Non-terminal graph context; includes containers and active/blocked statuses. */
  graphTaskIds: string[];
  runnableTaskIds: string[];
  excludedTaskIds: string[];
  blockedTaskIds: string[];
  blockedReasons: Array<{
    taskId: string;
    kind: "workflow-gate" | "dependency" | "cycle" | "status";
    message: string;
    dependencyId?: string;
    gateName?: string;
    gateStatus?: string;
  }>;
  cycleTaskIds: string[];
  recommendedNext: string[];
  policy: PlannerPolicy;
};

const TERMINAL_STATUSES = new Set(["done", "cancelled", "archived"]);

function normalizedStatus(task: PlannerTask): string {
  const raw = task.planningState ?? task.status ?? "backlog";
  return STATUS_TO_PLANNING[raw] ?? (raw === "in_progress" ? "in-progress" : raw);
}

function taskType(task: PlannerTask): string {
  return task.type ?? "task";
}

function taskParent(task: PlannerTask): string | null {
  return task.parentId ?? task.parent ?? null;
}

function taskExecutor(task: PlannerTask): string {
  return task.executorKind ?? task.executor ?? "default";
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20).join("")
  ].join("-");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function claimSort(a: ResourceClaim, b: ResourceClaim): number {
  return a.taskId.localeCompare(b.taskId) || a.claimId.localeCompare(b.claimId);
}

function normalizedPathHints(values: readonly string[] | undefined): string[] {
  return sortedUnique((values ?? []).map(value => value.trim()).filter(Boolean));
}

/** Convert legacy task domains/touch/path hints into stable protocol claims. */
export function deriveResourceClaims(tasks: readonly PlannerTask[]): ResourceClaim[] {
  const claims: ResourceClaim[] = [];
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const domains = sortedUnique(task.domains ?? []);
    const filesAffected = normalizedPathHints(task.filesAffected);
    const paths = sortedUnique([...normalizedPathHints(task.paths), ...normalizedPathHints(task.touch), ...filesAffected]);
    if (domains.length === 0 && paths.length === 0) continue;
    const seed = JSON.stringify({ taskId: task.id, domains, paths });
    claims.push({
      claimId: stableUuid(`mapctx:planner:derived:${seed}`),
      taskId: task.id,
      domains,
      paths,
      mode: "write",
      confidence: filesAffected.length > 0 ? "high" : "low",
      provenance: filesAffected.length > 0 ? "filesAffected" : "inferred"
    });
  }
  return claims;
}

/**
 * Reduce a declared path to one comparable form by walking its segments: separators
 * fold, `.` and empty segments drop, `..` pops, and a leading `/` disappears. So
 * `/src/a.ts`, `src/../src/a.ts`, `.//src/a.ts` and `src\a.ts` all become `src/a.ts`.
 * `..` clamps at the root rather than escaping it, so `../a.ts` compares as `a.ts`;
 * a repo-relative path leaving the root is nonsense data, and conflating it with the
 * root-relative one errs toward collision. Case folds for macOS/Windows default
 * filesystems. Two known limits, both pre-existing and both conservative: there is no
 * Unicode normalization, so NFC and NFD spellings of the same name stay disjoint; and
 * folding `\` to `/` means `src/\*.ts` becomes the glob `src/*.ts` — escapes are not
 * supported, they over-serialize.
 *
 * NOT the `normalizePath` in @mapctx/protocol/claim-paths, and T-133 deliberately
 * did not merge them. This one compares DECLARED claims before work runs, so it
 * resolves `..`, refuses to pop a `**`, and folds case because the scheduler must
 * err toward serializing on filesystems that do. That one compares OBSERVED paths
 * — what a receipt reported against what a violation row recorded — where case is
 * meaningful and `..` does not occur. Merging them would make the audit record
 * lossy or the scheduler case-blind; equivalence was never proven, so the two
 * comparisons stay two functions with two names' worth of documentation.
 */
function normalizePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // A single-segment wildcard consumes exactly one segment, so popping it is exact.
      // `**` spans zero or more, so popping it would narrow a pattern that still
      // matches: leave the path unresolvable instead, which collides broadly.
      if (segments.pop()?.includes("**")) return "";
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").toLowerCase();
}

/**
 * Index of the first glob construct, or -1. `?`, `*` and `[` always count. A `(`
 * counts only as an extglob group — introduced by `?*+@!`, or holding a `|` within its
 * own segment — and a `{` only as a brace expansion, its body holding a `,` or a `..`
 * range. Bare parens and braces are literals in bash and picomatch, so counting them
 * unconditionally would serialize `app/(marketing)/page.tsx` against every sibling
 * route and `src/{id}.ts` against its whole directory. A leading `!` negates the whole
 * pattern. These shapes are detected, never matched: detection truncates the static
 * prefix instead of comparing the pattern literally, which is the difference between a
 * conservative collision and a missed one.
 */
function wildcardIndex(path: string): number {
  if (path.startsWith("!")) return 0;
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === "?" || char === "*" || char === "[") return index;
    if (char !== "(" && char !== "{") continue;
    const segmentEnd = path.indexOf("/", index) < 0 ? path.length : path.indexOf("/", index);
    if (char === "(") {
      if (index > 0 && "?*+@!".includes(path[index - 1])) return index - 1;
      const group = path.slice(index, segmentEnd);
      const close = group.indexOf(")") < 0 ? group.length : group.indexOf(")");
      if (group.slice(0, close).includes("|")) return index;
      continue;
    }
    const body = path.slice(index + 1, segmentEnd);
    const close = body.indexOf("}") < 0 ? body.length : body.indexOf("}");
    const list = body.slice(0, close);
    if (list.includes(",") || list.includes("..")) return index;
  }
  return -1;
}

/**
 * Static head of a pattern, plus whether the wildcard truncated it mid-segment.
 * `src/**` ends on a `/` boundary (`src`, not partial); `src/foo*.ts` stops inside
 * the filename (`src/foo`, partial) and therefore cannot be compared on `/` alone.
 */
function staticPrefix(value: string): { prefix: string; partial: boolean } {
  const normalized = normalizePath(value);
  const wildcard = wildcardIndex(normalized);
  if (wildcard < 0) return { prefix: normalized, partial: false };
  const head = normalized.slice(0, wildcard);
  return { prefix: head.replace(/\/$/, ""), partial: head.length > 0 && !head.endsWith("/") };
}

/**
 * A path collision is exact, ancestor/descendant, or a conservative glob overlap.
 * Glob matching compares each pattern's static prefix, so `src/**` and `src/a.ts`
 * collide while disjoint prefixes do not. A prefix truncated mid-segment compares as
 * a plain string prefix in either direction, so `src/foo*.ts` collides with
 * `src/foobar.ts`; literal paths keep the `/` boundary, so `packages/store` stays
 * disjoint from `packages/store-ui`. Leading-wildcard patterns — including brace
 * lists, extglob groups and `!` negation, which this does not try to match —
 * conservatively collide with any path. Comparisons case-fold for macOS/Windows
 * default filesystems. This deliberately favors safety over a full glob interpreter
 * when deciding whether two writes share a wave.
 */
function pathOverlap(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return false;
  const a = normalizePath(left);
  const b = normalizePath(right);
  // A declared path that normalizes away entirely (`/`, `..`) locates nothing, so it
  // is unknown rather than empty and collides like a leading wildcard.
  if (!a || !b) return true;
  if (a === b) return true;
  const { prefix: aPrefix, partial: aPartial } = staticPrefix(a);
  const { prefix: bPrefix, partial: bPartial } = staticPrefix(b);
  if (!aPrefix || !bPrefix) return true;
  if (aPrefix === bPrefix) return true;
  if (aPartial || bPartial) {
    if (aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix)) return true;
  } else if (aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;
  // Backstop for a trailing directory wildcard. The prefix rules above decide every
  // input observed so far; this stays as a safety net, not as live logic.
  const aDir = a.endsWith("/**") || a.endsWith("/*");
  const bDir = b.endsWith("/**") || b.endsWith("/*");
  if (aDir && b.startsWith(`${a.slice(0, a.lastIndexOf("/"))}/`)) return true;
  if (bDir && a.startsWith(`${b.slice(0, b.lastIndexOf("/"))}/`)) return true;
  return false;
}

type ClaimOverlap = {
  domains: string[];
  paths: string[];
};

function domainsOverlap(left: ResourceClaim, right: ResourceClaim): string[] {
  return sortedUnique(left.domains.filter(domain => right.domains.includes(domain)));
}

/** Name a path in a cause the way it was declared when it normalizes away entirely. */
function causePath(value: string): string {
  return normalizePath(value) || value.trim();
}

function pathsOverlap(left: ResourceClaim, right: ResourceClaim): string[] {
  return sortedUnique(
    left.paths.flatMap(leftPath => right.paths.filter(rightPath => pathOverlap(leftPath, rightPath)).map(rightPath => `${causePath(leftPath)} ↔ ${causePath(rightPath)}`))
  );
}

/** A domain-only claim nobody declared: it exists only because a domain was inferred. */
function isWeakDomainOnlyClaim(claim: ResourceClaim): boolean {
  return claim.paths.length === 0 && claim.confidence === "low" && claim.provenance === "inferred";
}

/** A domain-only claim that was authored or is high-confidence, so it still binds. */
function isStrongDomainOnlyClaim(claim: ResourceClaim): boolean {
  return claim.paths.length === 0 && !isWeakDomainOnlyClaim(claim);
}

/**
 * Paths are authoritative only when both claims carry paths: only a path
 * overlap serializes. Otherwise domain evidence decides, and it binds only when
 * at least one side is a strong domain-only claim (authored, or confidence above
 * low). So a path-bearing claim beside a low-confidence inferred domain, and two
 * such inferred domains, are advisory; an authored or high-confidence domain-only
 * claim keeps serializing against anything sharing its domain.
 *
 * One strong domain-only claim therefore defeats path precedence for the whole task
 * pair: a caller that attaches an authored domain claim beside its path claims gives
 * up path-based parallelism for that task, which is intentional and conservative.
 */
function claimCollision(left: ResourceClaim, right: ResourceClaim): ClaimOverlap | null {
  if (left.mode === "read" && right.mode === "read") return null;
  if (left.paths.length > 0 && right.paths.length > 0) {
    const paths = pathsOverlap(left, right);
    return paths.length > 0 ? { domains: [], paths } : null;
  }
  const domains = domainsOverlap(left, right);
  if (domains.length === 0) return null;
  if (!isStrongDomainOnlyClaim(left) && !isStrongDomainOnlyClaim(right)) return null;
  return { domains, paths: [] };
}

function claimAdvisory(left: ResourceClaim, right: ResourceClaim): ClaimOverlap | null {
  if (left.mode === "read" && right.mode === "read") return null;
  if (claimCollision(left, right)) return null;
  const domains = domainsOverlap(left, right);
  return domains.length > 0 ? { domains, paths: [] } : null;
}

function pairOverlap<T extends ClaimCollision | ClaimAdvisory>(
  taskAId: string,
  taskBId: string,
  claimsByTask: Map<string, ResourceClaim[]>,
  overlap: (left: ResourceClaim, right: ResourceClaim) => ClaimOverlap | null,
  reason: T["reason"]
): T | null {
  const aClaims = claimsByTask.get(taskAId) ?? [];
  const bClaims = claimsByTask.get(taskBId) ?? [];
  const causes: Array<{ a: ResourceClaim; b: ResourceClaim; domains: string[]; paths: string[] }> = [];
  for (const a of aClaims) {
    for (const b of bClaims) {
      const result = overlap(a, b);
      if (result) causes.push({ a, b, ...result });
    }
  }
  if (causes.length === 0) return null;
  const taskOrder = taskAId.localeCompare(taskBId) <= 0 ? [taskAId, taskBId] : [taskBId, taskAId];
  const orderedCauses = causes.sort((x, y) => x.a.claimId.localeCompare(y.a.claimId) || x.b.claimId.localeCompare(y.b.claimId));
  const claimMap = new Map<string, ResourceClaim>();
  const domains = new Set<string>();
  const paths = new Set<string>();
  for (const cause of orderedCauses) {
    claimMap.set(cause.a.claimId, cause.a);
    claimMap.set(cause.b.claimId, cause.b);
    cause.domains.forEach(domain => domains.add(domain));
    cause.paths.forEach(path => paths.add(path));
  }
  const orderedTaskA = taskOrder[0];
  const normalizedCauses = orderedCauses.map(cause => {
    if (cause.a.taskId === orderedTaskA) {
      return { claimA: cause.a, claimB: cause.b, domains: [...cause.domains].sort(), paths: [...cause.paths].sort() };
    }
    return { claimA: cause.b, claimB: cause.a, domains: [...cause.domains].sort(), paths: [...cause.paths].sort() };
  });
  return {
    taskAId: taskOrder[0],
    taskBId: taskOrder[1],
    claims: [...claimMap.values()].sort((a, b) => a.claimId.localeCompare(b.claimId)),
    claimIds: [...claimMap.keys()].sort(),
    causes: normalizedCauses,
    taskAClaimIds: sortedUnique(normalizedCauses.map(cause => cause.claimA.claimId)),
    taskBClaimIds: sortedUnique(normalizedCauses.map(cause => cause.claimB.claimId)),
    domains: [...domains].sort(),
    paths: [...paths].sort(),
    reason
  } as T;
}

function pairCollision(taskAId: string, taskBId: string, claimsByTask: Map<string, ResourceClaim[]>): ClaimCollision | null {
  return pairOverlap<ClaimCollision>(taskAId, taskBId, claimsByTask, claimCollision, "resource-claim-collision");
}

function pairAdvisory(taskAId: string, taskBId: string, claimsByTask: Map<string, ResourceClaim[]>): ClaimAdvisory | null {
  return pairOverlap<ClaimAdvisory>(taskAId, taskBId, claimsByTask, claimAdvisory, "low-confidence-inferred-domain-overlap");
}

function gateBlockers(gates: readonly WorkflowGate[] | undefined, required: readonly string[] | undefined): WorkflowGate[] {
  if (!gates || gates.length === 0) return [];
  const requiredNames = new Set(required && required.length > 0 ? required : gates.map(gate => gate.name));
  return gates.filter(gate => requiredNames.has(gate.name) && gate.status !== "approved" && gate.status !== "skipped");
}

function capacityFor(kind: string, capacity: ExecutorCapacity): number {
  if (typeof capacity === "number") return capacity;
  return capacity[kind] ?? capacity.default ?? Number.POSITIVE_INFINITY;
}

function taskView(task: PlannerTask): PlannedTask {
  return {
    id: task.id,
    title: task.title ?? task.id,
    status: normalizedStatus(task),
    type: taskType(task),
    dependsOn: sortedUnique(task.dependsOn ?? []),
    executorKind: taskExecutor(task)
  };
}

/** Build deterministic, collision-aware waves. Claims reduce likely collisions; merge remains backstop. */
export function planExecution(input: PlannerInput): PlanReport {
  const tasks = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    const parent = taskParent(task);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), task.id]);
  }
  const containers = new Set(tasks.filter(task => taskType(task) === "epic" || (children.get(task.id)?.length ?? 0) > 0).map(task => task.id));
  const globalGates = input.workflowGates;
  const globalRequiredGates = input.requiredGates;
  const terminal = new Set(tasks.filter(task => TERMINAL_STATUSES.has(normalizedStatus(task))).map(task => task.id));
  // Containers remain visible as hierarchy, but are never dispatch units.
  const graphIds = new Set(tasks.filter(task => !terminal.has(task.id)).map(task => task.id));
  const dispatchable = new Set(tasks.filter(task => graphIds.has(task.id) && !containers.has(task.id) && (normalizedStatus(task) === "backlog" || normalizedStatus(task) === "ready")).map(task => task.id));
  const excludedTaskIds = tasks.filter(task => !dispatchable.has(task.id)).map(task => task.id);
  const blockedReasons: PlanReport["blockedReasons"] = [];
  const blockedDispatchable = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  for (const task of tasks) dependencies.set(task.id, new Set(task.dependsOn ?? []));
  // "blocks" and "depends-on" are opposite directions of the same relation, not the same
  // edge read two ways: for {from, to, kind: "blocks"}, `to` waits on `from`; for
  // {from, to, kind: "depends-on"}, `from` waits on `to`. See DependencyEdge in
  // packages/protocol/docs/dependency-edges.md.
  for (const edge of input.dependencyEdges ?? []) {
    if (edge.kind === "blocks") dependencies.get(edge.toTaskId)?.add(edge.fromTaskId);
    else if (edge.kind === "depends-on") dependencies.get(edge.fromTaskId)?.add(edge.toTaskId);
  }

  const addGateReasons = (task: PlannerTask): void => {
    const gates = [...gateBlockers(globalGates, globalRequiredGates), ...gateBlockers(task.workflowGates, task.requiredGates)];
    for (const gate of gates) {
      blockedReasons.push({ taskId: task.id, kind: "workflow-gate", message: `blocked by workflow gate ${gate.name} (${gate.status})`, gateName: gate.name, gateStatus: gate.status });
    }
    if (gates.length > 0) blockedDispatchable.add(task.id);
  };
  for (const task of tasks) if (dispatchable.has(task.id)) addGateReasons(task);
  // Every non-terminal, non-container task must be named somewhere in the output: either it
  // schedules into a wave, or it shows up here with a reason. A task whose own status keeps it
  // out of dispatchable (in-progress, review, paused, blocked) still needs a named reason instead
  // of silently disappearing into excludedTaskIds.
  for (const task of tasks) {
    if (!graphIds.has(task.id) || containers.has(task.id) || dispatchable.has(task.id)) continue;
    blockedReasons.push({
      taskId: task.id,
      kind: "status",
      message: `not schedulable: status is ${normalizedStatus(task)}`,
      gateStatus: normalizedStatus(task)
    });
  }

  const directDependencyBlock = (taskId: string): PlanReport["blockedReasons"][number] | null => {
    const task = byId.get(taskId);
    if (!task) return null;
    for (const dependencyId of [...(dependencies.get(taskId) ?? [])].sort()) {
      if (terminal.has(dependencyId) || containers.has(dependencyId)) continue;
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      const dependencyStatus = normalizedStatus(dependency);
      if (dependencyStatus === "paused" || dependencyStatus === "review" || dependencyStatus === "blocked" || dependencyStatus === "in-progress") {
        return { taskId, kind: "dependency", message: `blocked by ${dependencyStatus} ${dependencyId}`, dependencyId, gateStatus: dependencyStatus };
      }
      if (dispatchable.has(dependencyId) && blockedDispatchable.has(dependencyId)) {
        return { taskId, kind: "dependency", message: `blocked by blocked ${dependencyId}`, dependencyId, gateStatus: "blocked" };
      }
    }
    return null;
  };
  // Propagate named blockers through chains of not-yet-runnable tasks.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!dispatchable.has(task.id) || blockedDispatchable.has(task.id)) continue;
      const blocker = directDependencyBlock(task.id);
      if (!blocker) continue;
      blockedDispatchable.add(task.id);
      blockedReasons.push(blocker);
      changed = true;
    }
  }

  const runnable = new Set([...dispatchable].filter(id => !blockedDispatchable.has(id)));
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of runnable) {
    edges.set(id, new Set());
    indegree.set(id, 0);
  }
  for (const dependent of runnable) {
    for (const dependency of [...(dependencies.get(dependent) ?? [])].sort()) {
      if (!runnable.has(dependency)) continue;
      edges.get(dependency)?.add(dependent);
      indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
    }
  }

  const suppliedClaims = input.resourceClaims ?? input.claims ?? [];
  const claims = [...(suppliedClaims.length > 0 ? suppliedClaims : deriveResourceClaims(tasks))].sort(claimSort);
  const claimsByTask = new Map<string, ResourceClaim[]>();
  for (const claim of claims) claimsByTask.set(claim.taskId, [...(claimsByTask.get(claim.taskId) ?? []), claim]);
  const capacity = input.executorCapacity ?? input.maxExecutors ?? Number.POSITIVE_INFINITY;
  if (typeof capacity === "number" && capacity !== Number.POSITIVE_INFINITY && (!Number.isInteger(capacity) || capacity < 1)) throw new Error("executorCapacity must be a positive integer");
  for (const limit of typeof capacity === "object" ? Object.values(capacity) : []) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("executor capacity values must be positive integers");
  }

  const waves: PlanWave[] = [];
  const serialized = new Map<string, ClaimCollision>();
  const advisories = new Map<string, ClaimAdvisory>();
  const processed = new Set<string>();
  while (processed.size < runnable.size) {
    const ready = [...runnable].filter(id => !processed.has(id) && (indegree.get(id) ?? 0) === 0).sort();
    if (ready.length === 0) break;
    const selected: string[] = [];
    const counts = new Map<string, number>();
    for (const id of ready) {
      const task = byId.get(id)!;
      const kind = taskExecutor(task);
      const limit = capacityFor(kind, capacity);
      if ((counts.get(kind) ?? 0) >= limit) continue;
      let collision = false;
      for (const selectedId of selected) {
        const explanation = pairCollision(selectedId, id, claimsByTask);
        if (explanation) {
          collision = true;
          serialized.set(`${explanation.taskAId}:${explanation.taskBId}`, explanation);
        } else {
          const advisory = pairAdvisory(selectedId, id, claimsByTask);
          if (advisory) advisories.set(`${advisory.taskAId}:${advisory.taskBId}`, advisory);
        }
      }
      if (collision) continue;
      selected.push(id);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (selected.length === 0) throw new Error("Unable to schedule runnable task; executor capacity must allow at least one task");
    const waveNumber = waves.length + 1;
    waves.push({ wave: waveNumber, taskIds: selected, tasks: selected.map(id => taskView(byId.get(id)!)) });
    for (const id of selected) {
      processed.add(id);
      for (const successor of edges.get(id) ?? []) indegree.set(successor, (indegree.get(successor) ?? 0) - 1);
    }
  }

  const cycleTaskIds = [...runnable].filter(id => !processed.has(id)).sort();
  // Runnable tasks that never scheduled are stuck in a dependency cycle. Name them too, rather
  // than letting them vanish from waves with no explanation in blockedReasons.
  for (const id of cycleTaskIds) {
    blockedReasons.push({ taskId: id, kind: "cycle", message: "blocked by dependency cycle" });
  }
  const waveByTaskId: Record<string, number> = {};
  for (const wave of waves) for (const task of wave.tasks) waveByTaskId[task.id] = wave.wave;
  const firstWave = waves[0]?.tasks ?? [];
  const recommendedNext = [...firstWave].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 8).map(task => task.id);
  const blockedTaskIds = [...blockedDispatchable].sort();
  return {
    waves,
    waveByTaskId,
    serializedPairs: [...serialized.values()].sort((a, b) => a.taskAId.localeCompare(b.taskAId) || a.taskBId.localeCompare(b.taskBId)),
    advisories: [...advisories.values()].sort((a, b) => a.taskAId.localeCompare(b.taskAId) || a.taskBId.localeCompare(b.taskBId)),
    claims,
    graphTaskIds: [...graphIds].sort(),
    runnableTaskIds: [...runnable].sort(),
    excludedTaskIds: sortedUnique(excludedTaskIds),
    blockedTaskIds,
    blockedReasons: blockedReasons.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.kind.localeCompare(b.kind) || (a.dependencyId ?? "").localeCompare(b.dependencyId ?? "") || (a.gateName ?? "").localeCompare(b.gateName ?? "")),
    cycleTaskIds,
    recommendedNext,
    policy: {
      scheduling: "collision-aware",
      claimsAreAdvisory: true,
      correctnessBackstop: "worktree-merge",
      guarantee: "none",
      explanation: "serialized-pairs"
    }
  };
}

export const planWaves = planExecution;
export const plan = planExecution;
export * from "./violations";
