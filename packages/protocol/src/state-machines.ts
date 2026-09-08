import { DispatchStatus, ExecutionState, PlanningState } from "./entities";

export const PLANNING_TRANSITIONS: Record<PlanningState, readonly PlanningState[]> = {
  backlog: ["ready", "blocked", "paused", "cancelled"],
  ready: ["in-progress", "blocked", "paused", "backlog", "cancelled"],
  blocked: ["ready", "paused", "cancelled"],
  "in-progress": ["review", "blocked", "paused", "done", "cancelled"],
  review: ["in-progress", "done", "blocked", "paused"],
  paused: ["backlog", "ready", "blocked", "cancelled"],
  done: [],
  cancelled: []
};

export const EXECUTION_TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  unclaimed: ["claimed", "cancelled"],
  claimed: ["running", "unclaimed", "cancelled"],
  running: ["blocked", "completed", "failed", "cancelled"],
  // "unclaimed" is the retry-admission edge: a blocked run is terminal for
  // the ATTEMPT, not for the task -- the same mirror as failed -> unclaimed.
  // New-attempt admission journals the reset so replay reproduces it.
  blocked: ["running", "unclaimed", "cancelled", "failed"],
  completed: [],
  failed: ["unclaimed"],
  cancelled: []
};

// One attempt of one dispatch. Each retry is a new Dispatch row (new `attempt`
// number) starting fresh at "claimed" — this machine never transitions a
// terminal attempt back to a live state. That would let a stale attempt
// resurrect after a newer one has already started; see attempt-lifecycle.ts
// for how late receipts against a superseded attempt get rejected instead.
export const DISPATCH_TRANSITIONS: Record<DispatchStatus, readonly DispatchStatus[]> = {
  claimed: ["running", "cancelled", "expired"],
  running: ["blocked", "completed", "failed", "cancelled", "expired"],
  blocked: ["running", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: []
};

export type StateMachineKind = "planning" | "execution" | "dispatch";

export type TransitionResult =
  | { ok: true; from: string; to: string }
  | { ok: false; from: string; to: string; reason: "illegal-transition" | "unknown-state" };

export function canTransitionPlanning(from: PlanningState, to: PlanningState): boolean {
  return PLANNING_TRANSITIONS[from].includes(to);
}

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function canTransitionDispatch(from: DispatchStatus, to: DispatchStatus): boolean {
  return DISPATCH_TRANSITIONS[from].includes(to);
}

export function transitionPlanning(from: PlanningState, to: PlanningState): TransitionResult {
  if (!(from in PLANNING_TRANSITIONS) || !(to in PLANNING_TRANSITIONS)) {
    return { ok: false, from, to, reason: "unknown-state" };
  }
  if (!canTransitionPlanning(from, to)) {
    return { ok: false, from, to, reason: "illegal-transition" };
  }
  return { ok: true, from, to };
}

export function transitionExecution(from: ExecutionState, to: ExecutionState): TransitionResult {
  if (!(from in EXECUTION_TRANSITIONS) || !(to in EXECUTION_TRANSITIONS)) {
    return { ok: false, from, to, reason: "unknown-state" };
  }
  if (!canTransitionExecution(from, to)) {
    return { ok: false, from, to, reason: "illegal-transition" };
  }
  return { ok: true, from, to };
}

export function transitionDispatch(from: DispatchStatus, to: DispatchStatus): TransitionResult {
  if (!(from in DISPATCH_TRANSITIONS) || !(to in DISPATCH_TRANSITIONS)) {
    return { ok: false, from, to, reason: "unknown-state" };
  }
  if (!canTransitionDispatch(from, to)) {
    return { ok: false, from, to, reason: "illegal-transition" };
  }
  return { ok: true, from, to };
}

export function assertTransition(
  kind: StateMachineKind,
  from: string,
  to: string
): void {
  const result =
    kind === "planning"
      ? transitionPlanning(from as PlanningState, to as PlanningState)
      : kind === "execution"
        ? transitionExecution(from as ExecutionState, to as ExecutionState)
        : transitionDispatch(from as DispatchStatus, to as DispatchStatus);
  if (result.ok) return;
  throw new Error(`Illegal ${kind} transition: ${from} -> ${to} (${result.reason})`);
}

export function illegalPlanningTransitions(): Array<{ from: PlanningState; to: PlanningState }> {
  return enumerateIllegal(Object.keys(PLANNING_TRANSITIONS) as PlanningState[], canTransitionPlanning);
}

export function illegalExecutionTransitions(): Array<{ from: ExecutionState; to: ExecutionState }> {
  return enumerateIllegal(Object.keys(EXECUTION_TRANSITIONS) as ExecutionState[], canTransitionExecution);
}

export function illegalDispatchTransitions(): Array<{ from: DispatchStatus; to: DispatchStatus }> {
  return enumerateIllegal(Object.keys(DISPATCH_TRANSITIONS) as DispatchStatus[], canTransitionDispatch);
}

function enumerateIllegal<T extends string>(
  states: T[],
  allowed: (from: T, to: T) => boolean
): Array<{ from: T; to: T }> {
  const out: Array<{ from: T; to: T }> = [];
  for (const from of states) {
    for (const to of states) {
      if (from === to) continue;
      if (!allowed(from, to)) out.push({ from, to });
    }
  }
  return out;
}
