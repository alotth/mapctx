import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  DependencyEdge,
  DispatchEnvelope,
  ExternalRef,
  ResourceClaim,
  Task
} from "@mapctx/protocol";
import { dispatchEnvelopeSchema } from "@mapctx/protocol";
import { planExecution, type PlanReport, type PlannerTask } from "@mapctx/planner";

/** The only Traycer fields this adapter writes. Traycer owns this closed schema. */
export type TraycerTicketStatus = 0 | 1 | 2;

export type TraycerEpicLink = Pick<ExternalRef, "externalKey" | "uri">;

export type DispatchEnvelopeOptions = {
  projectId: string;
  dispatchId?: string;
  attempt?: number;
  contextRefs?: readonly ArtifactRef[];
  workflowEvidence?: readonly ArtifactRef[];
  resourceClaims?: readonly ResourceClaim[];
  contextHash?: string;
  tokenBudget?: number;
  executorKind?: string;
  capabilities?: readonly string[];
};

export type TraycerTicketOptions = {
  epic?: TraycerEpicLink;
  /** Path/URI of the envelope in a local handoff directory, if one exists. */
  envelopeUri?: string;
  status?: TraycerTicketStatus;
};

export type MaterializedTicket = {
  content: string;
  filename: string;
  /** True because writing a Markdown artifact cannot create a live Yjs ticket. */
  requiresHumanTraycerAttach: true;
};

export type TraycerFirstImportOptions = {
  ticketKey?: string;
  ticketUri?: string;
  epic?: TraycerEpicLink;
  refId?: string;
};

export type TraycerFirstImport = {
  externalRef: ExternalRef;
  title: string;
  ticketStatus: TraycerTicketStatus;
  executionState: "unclaimed" | "running" | "completed";
  /** Traycer-first work is never silently made runnable in a MapCtx wave. */
  planningState: "backlog";
  unplanned: true;
  missingPlanning: readonly ["domains", "paths", "dependencies", "acceptance"];
  mapctxTaskId: string | null;
  dispatchId: string | null;
  nextStep: "enrich-in-mapctx-before-dispatch";
};

export type WaveDispatch = {
  wave: number;
  taskIds: readonly string[];
  envelopes: readonly DispatchEnvelope[];
};

export type WaveDispatchPlan = {
  report: PlanReport;
  waves: readonly WaveDispatch[];
  /** Dispatch remains a handoff to Traycer; this is not a live agent assignment. */
  requiresHumanTraycerAttach: true;
};

const UNPLANNED_FIELDS = ["domains", "paths", "dependencies", "acceptance"] as const;

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function taskToEnvelope(task: Task, options: DispatchEnvelopeOptions): DispatchEnvelope {
  const envelope: DispatchEnvelope = {
    schemaVersion: 1,
    dispatchId: options.dispatchId ?? randomUUID(),
    attempt: options.attempt ?? 1,
    projectId: options.projectId,
    task,
    context: {
      refs: [...(options.contextRefs ?? [])],
      hash: options.contextHash ?? hashJson({ task, refs: options.contextRefs ?? [] }),
      ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget })
    },
    resourceClaims: [...(options.resourceClaims ?? [])].filter(claim => claim.taskId === task.id),
    workflowEvidence: [...(options.workflowEvidence ?? [])],
    executor: {
      kind: options.executorKind ?? "traycer",
      capabilities: [...(options.capabilities ?? ["worktree", "a2a"])]
    }
  };
  return dispatchEnvelopeSchema.parse(envelope);
}

/** Map one canonical MapCtx task into the executor-neutral dispatch contract. */
export function mapTaskToDispatchEnvelope(task: Task, options: DispatchEnvelopeOptions): DispatchEnvelope {
  return taskToEnvelope(task, options);
}

function frontmatterValue(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the executable projection of an envelope as a Traycer ticket artifact.
 * Rich planning fields stay in MapCtx; the body contains links and commands to
 * retrieve them, rather than a second planning authority.
 */
export function renderTraycerTicket(
  envelope: DispatchEnvelope,
  options: TraycerTicketOptions = {}
): MaterializedTicket {
  const status = options.status ?? 0;
  const lines = [
    "---",
    "kind: ticket",
    `title: ${frontmatterValue(envelope.task.title)}`,
    `status: ${status}`,
    "---",
    "",
    `# ${envelope.task.title}`,
    "",
    "<!-- Generated projection. MapCtx remains the planning source of truth. -->",
    "## MapCtx handoff",
    "",
    `- Canonical task: \`mapctx://task/${envelope.task.id}\``,
    `- Dispatch: \`${envelope.dispatchId}\` (attempt ${envelope.attempt})`,
    `- Project: \`${envelope.projectId}\``,
    `- Context hash: \`${envelope.context.hash}\``
  ];
  if (options.epic) lines.push(`- Traycer epic: [${options.epic.externalKey}](${options.epic.uri})`);
  if (options.envelopeUri) lines.push(`- Dispatch envelope: [JSON](${options.envelopeUri})`);
  lines.push(
    "",
    "Run `mapctx task context " + envelope.task.id + " --budget <tokens> --json` before execution.",
    "",
    "## Source artifacts",
    "",
    ...(envelope.context.refs.length > 0
      ? envelope.context.refs.map(ref => `- [${ref.kind}](${ref.uri})`)
      : ["- None attached." ]),
    ...(envelope.workflowEvidence.length > 0
      ? ["", "## Workflow evidence", "", ...envelope.workflowEvidence.map(ref => `- [${ref.kind}](${ref.uri})`)]
      : []),
    "",
    "This ticket is a projection only. Acceptance, domains, paths, dependencies, and priority remain in MapCtx."
  );
  return {
    content: `${lines.join("\n")}\n`,
    filename: `${envelope.task.id}-${envelope.dispatchId}.md`,
    requiresHumanTraycerAttach: true
  };
}

/** Set promotedPath only after caller supplies an explicit approval decision. */
export function promoteApprovedArtifact(
  ref: ArtifactRef,
  promotedPath: string,
  approved: boolean
): ArtifactRef {
  if (!approved) throw new Error("Artifact promotion requires explicit approval");
  if (!promotedPath.trim()) throw new Error("Artifact promotion path is required");
  return { ...ref, promotedPath };
}

function readFrontmatter(markdown: string): { kind: string; title: string; status: TraycerTicketStatus } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error("Traycer ticket is missing frontmatter");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid Traycer frontmatter line: ${line}`);
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (fields.size !== 3 || fields.get("kind") !== "ticket") {
    throw new Error("Traycer ticket frontmatter must contain exactly kind, title, and status");
  }
  const rawStatus = Number(fields.get("status"));
  if (!Number.isInteger(rawStatus) || rawStatus < 0 || rawStatus > 2) {
    throw new Error("Traycer ticket status must be 0, 1, or 2");
  }
  let title = fields.get("title") ?? "";
  try {
    title = JSON.parse(title) as string;
  } catch {
    title = title.replace(/^['"]|['"]$/g, "");
  }
  if (!title) throw new Error("Traycer ticket title is required");
  return { kind: "ticket", title, status: rawStatus as TraycerTicketStatus };
}

function bodyValue(markdown: string, label: string): string | null {
  const match = markdown.match(new RegExp("^- " + label + ": `([^`]+)`", "m"));
  return match?.[1] ?? null;
}

/**
 * Import a ticket that originated in Traycer. It creates identity metadata,
 * not a runnable plan: MapCtx enrichment is an explicit follow-up.
 */
export function importTraycerTicket(
  markdown: string,
  options: TraycerFirstImportOptions = {}
): TraycerFirstImport {
  const frontmatter = readFrontmatter(markdown);
  const mapctxTaskId = bodyValue(markdown, "Canonical task")?.replace("mapctx://task/", "") ?? null;
  const dispatchId = bodyValue(markdown, "Dispatch");
  const ticketKey = options.ticketKey ?? dispatchId ?? `ticket-${hashJson(markdown).slice(-16)}`;
  const ticketUri = options.ticketUri ?? `traycer://artifact/${ticketKey}`;
  const ownerKind = mapctxTaskId ? "task" : "project";
  const ownerId = mapctxTaskId ?? ticketKey;
  const externalRef: ExternalRef = {
    refId: options.refId ?? randomUUID(),
    ownerKind,
    ownerId,
    provider: "traycer",
    entityKind: "artifact",
    externalKey: ticketKey,
    uri: ticketUri,
    metadata: {
      kind: "ticket",
      ...(options.epic ? { epicExternalKey: options.epic.externalKey, epicUri: options.epic.uri } : {})
    }
  };
  return {
    externalRef,
    title: frontmatter.title,
    ticketStatus: frontmatter.status,
    executionState: frontmatter.status === 0 ? "unclaimed" : frontmatter.status === 1 ? "running" : "completed",
    planningState: "backlog",
    unplanned: true,
    missingPlanning: UNPLANNED_FIELDS,
    mapctxTaskId,
    dispatchId,
    nextStep: "enrich-in-mapctx-before-dispatch"
  };
}

export type PlanWaveDispatchInput = {
  projectId: string;
  tasks: readonly (Task & PlannerTask)[];
  dependencyEdges?: readonly DependencyEdge[];
  resourceClaims?: readonly ResourceClaim[];
  contextRefs?: readonly ArtifactRef[];
  workflowEvidence?: readonly ArtifactRef[];
  executorCapacity?: number | Readonly<Record<string, number>>;
  executorKind?: string;
  capabilities?: readonly string[];
};

/** Convert a planner report into envelopes without asserting planner wave behavior. */
export function mapPlanToDispatchEnvelopes(
  report: PlanReport,
  tasks: readonly Task[],
  options: Omit<DispatchEnvelopeOptions, "projectId"> & Pick<DispatchEnvelopeOptions, "projectId">
): WaveDispatchPlan {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const waves = report.waves.map(wave => ({
    wave: wave.wave,
    taskIds: wave.taskIds,
    envelopes: wave.taskIds.map(taskId => {
      const task = byId.get(taskId);
      if (!task) throw new Error(`Planner wave references unknown task ${taskId}`);
      return taskToEnvelope(task, {
        ...options,
        resourceClaims: report.claims,
        dispatchId: undefined
      });
    })
  }));
  return { report, waves, requiresHumanTraycerAttach: true };
}

/** Plan and project a wave set. The returned envelopes are still a handoff, not live Traycer assignments. */
export function planWaveDispatch(input: PlanWaveDispatchInput): WaveDispatchPlan {
  const report = planExecution({
    tasks: input.tasks,
    dependencyEdges: input.dependencyEdges,
    resourceClaims: input.resourceClaims,
    executorCapacity: input.executorCapacity
  });
  return mapPlanToDispatchEnvelopes(report, input.tasks, {
    projectId: input.projectId,
    contextRefs: input.contextRefs,
    workflowEvidence: input.workflowEvidence,
    executorKind: input.executorKind,
    capabilities: input.capabilities
  });
}

export type { ArtifactRef, DependencyEdge, DispatchEnvelope, ExternalRef, ResourceClaim, Task };
