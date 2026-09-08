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

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

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

/** Convert legacy task domains/touch/path hints into stable protocol claims. */
export function deriveResourceClaims(tasks: readonly PlannerTask[]): ResourceClaim[] {
  const claims: ResourceClaim[] = [];
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const domains = sortedUnique(task.domains ?? []);
    const paths = sortedUnique([...(task.paths ?? []), ...(task.touch ?? [])]);
    if (domains.length === 0 && paths.length === 0) continue;
    const seed = JSON.stringify({ taskId: task.id, domains, paths });
    claims.push({
      claimId: stableUuid(`mapctx:planner:derived:${seed}`),
      taskId: task.id,
      domains,
      paths,
      mode: "write",
      confidence: "low",
      provenance: "inferred"
    });
  }
  return claims;
}

function normalizePath(value: string): string {
  let path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  path = path.replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function staticPrefix(value: string): string {
  const wildcard = value.search(/[?*\[]/);
  return normalizePath(wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/$/, "");
}

function pathOverlap(left: string, right: string): boolean {
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

function claimCollision(left: ResourceClaim, right: ResourceClaim): {
  domains: string[];
  paths: string[];
} | null {
  if (left.mode === "read" && right.mode === "read") return null;
  const domains = sortedUnique(left.domains.filter(domain => right.domains.includes(domain)));
  const paths = sortedUnique(
    left.paths.flatMap(leftPath => right.paths.filter(rightPath => pathOverlap(leftPath, rightPath)).map(rightPath => `${normalizePath(leftPath)} ↔ ${normalizePath(rightPath)}`))
  );
  if (domains.length === 0 && paths.length === 0) return null;
  return { domains, paths };
}

function pairCollision(taskAId: string, taskBId: string, claimsByTask: Map<string, ResourceClaim[]>): ClaimCollision | null {
  const aClaims = claimsByTask.get(taskAId) ?? [];
  const bClaims = claimsByTask.get(taskBId) ?? [];
  const causes: Array<{ a: ResourceClaim; b: ResourceClaim; domains: string[]; paths: string[] }> = [];
  for (const a of aClaims) {
    for (const b of bClaims) {
      const collision = claimCollision(a, b);
      if (collision) causes.push({ a, b, ...collision });
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
    reason: "resource-claim-collision"
  };
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
        if (!explanation) continue;
        collision = true;
        serialized.set(`${explanation.taskAId}:${explanation.taskBId}`, explanation);
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
