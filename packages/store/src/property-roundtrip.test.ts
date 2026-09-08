import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import * as fc from "fast-check"
import { buildExport } from "./export"
import { planImport } from "./import"
import { StoreHandle } from "./store-handle"
import type { DependencyRecord, TaskDetailRecord, TaskRecord, WorkDomain } from "./types"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

// -- Generators constrained to the hand-rolled parsers' safe input space --
// (no newlines in scalar fields, no commas/brackets in array tokens, no
// literal "null" scalars) -- see markdown.ts / task-detail.ts for the format
// these mirror.

// Array.from (not .split("")) splits by Unicode code point, not UTF-16 code
// unit -- .split("") would cut the astral character 🚀 into two lone
// surrogate halves, which fc.array could then pick independently and
// produce an ill-formed string that mangles on any UTF-8 boundary.
const SCALAR_POOL = Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.áéíóúñ日本語🚀");
const TOKEN_POOL = "abcdefghijklmnopqrstuvwxyz0123456789-_./".split("");
// Work-domain keys are parsed with /^-\s*([A-Za-z0-9_-]+)\s*:/ (see
// import.ts's parseWorkDomains) -- no '/' or '.', unlike path-shaped tokens
// (filesAffected etc.), which is exactly what TOKEN_POOL allows.
const DOMAIN_KEY_POOL = "abcdefghijklmnopqrstuvwxyz0123456789-_".split("");

function charsArb(pool: string[], minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...pool), { minLength, maxLength }).map((chars: string[]) => chars.join(""));
}

const safeScalarArb: fc.Arbitrary<string> = charsArb(SCALAR_POOL, 1, 24)
  .map(s => s.trim())
  .filter(s => s.length > 0 && s !== "null");

const tokenArb: fc.Arbitrary<string> = charsArb(TOKEN_POOL, 1, 12);
const tokenArrayArb = (maxLength: number): fc.Arbitrary<string[]> =>
  fc.uniqueArray(tokenArb, { maxLength, selector: (s: string) => s });

const domainKeyArb: fc.Arbitrary<string> = charsArb(DOMAIN_KEY_POOL, 1, 12);

const dateArb: fc.Arbitrary<string | null> = fc.option(fc.constantFrom("2026-01-01", "2026-02-15", "2025-12-31"), { nil: null });

const lineArb: fc.Arbitrary<string> = charsArb(SCALAR_POOL, 0, 30);
// planImport requires a non-empty description (missing-description is a hard
// error), so the first line is always a guaranteed-non-blank safeScalarArb;
// normalizeDescription's trailing-blank trim can then never empty it out.
const rawDescriptionArb: fc.Arbitrary<string> = fc
  .tuple(safeScalarArb, fc.array(lineArb, { minLength: 0, maxLength: 5 }))
  .map(([first, rest]: [string, string[]]) => [first, ...rest].join("\n"));

/** Mirrors parseTaskDetailFile's trailing-blank-line trim so the generated
 * "expected" value already matches what one export/reimport cycle settles
 * to -- otherwise the property would flag a normalization the parser has
 * always done as a false round-trip failure. */
function normalizeDescription(description: string): string {
  const lines = description.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

const PLANNING_STATES = ["backlog", "ready", "in-progress", "review", "paused", "done"] as const;
const TYPES = [null, "epic", "feature", "task", "bug", "chore"] as const;
const PRIORITIES = [null, "high", "medium", "low"] as const;
const WORKLOADS = [null, "Easy", "Normal", "Hard", "Extreme"] as const;

type GeneratedTask = {
  task: TaskRecord;
  detail: TaskDetailRecord;
  description: string;
  outgoingEdges: DependencyRecord[];
};

type GeneratedFields = {
  title: string;
  planningState: (typeof PLANNING_STATES)[number];
  type: (typeof TYPES)[number];
  parentTaskId: string | null;
  priority: (typeof PRIORITIES)[number];
  workload: (typeof WORKLOADS)[number];
  tags: string[];
  domains: string[];
  dependsOn: string[];
  startDate: string | null;
  dueDate: string | null;
  completedOn: string | null;
  externalId: string | null;
  updatedOn: string | null;
  role: string;
  impact: string;
  estimatedEffort: string;
  filesAffected: string[];
  testsRequired: string[];
  summary: string;
  rawDescription: string;
};

function taskArb(index: number, earlierIds: string[]): fc.Arbitrary<GeneratedTask> {
  const taskId = `T-${String(index + 1).padStart(3, "0")}`;
  return fc
    .record<GeneratedFields>({
      title: safeScalarArb,
      planningState: fc.constantFrom(...PLANNING_STATES),
      type: fc.constantFrom(...TYPES),
      parentTaskId: earlierIds.length > 0 ? fc.option(fc.constantFrom(...earlierIds), { nil: null }) : fc.constant(null),
      priority: fc.constantFrom(...PRIORITIES),
      workload: fc.constantFrom(...WORKLOADS),
      tags: tokenArrayArb(3),
      domains: tokenArrayArb(3),
      dependsOn: earlierIds.length > 0 ? fc.uniqueArray(fc.constantFrom(...earlierIds), { maxLength: earlierIds.length, selector: (s: string) => s }) : fc.constant([] as string[]),
      startDate: dateArb,
      dueDate: dateArb,
      completedOn: dateArb,
      // Unique per task by construction (task_projection enforces a unique
      // index on externalId -- two tasks sharing one is a distinct,
      // separately-tested validation-error scenario, not part of this
      // valid-input round-trip property).
      externalId: fc.option(fc.constantFrom(`github:issue:${index + 1}`, `traycer:artifact:${taskId}`), { nil: null }),
      updatedOn: dateArb,
      role: safeScalarArb,
      impact: safeScalarArb,
      estimatedEffort: safeScalarArb,
      filesAffected: tokenArrayArb(3),
      testsRequired: tokenArrayArb(3),
      summary: safeScalarArb,
      rawDescription: rawDescriptionArb
    })
    .map((g: GeneratedFields): GeneratedTask => {
      const description = normalizeDescription(g.rawDescription);
      const task: TaskRecord = {
        taskId,
        positionKey: index,
        title: g.title,
        planningState: g.planningState,
        executionState: "unclaimed",
        type: g.type,
        parentTaskId: g.parentTaskId,
        priority: g.priority,
        workload: g.workload,
        tags: g.tags,
        domains: g.domains,
        startDate: g.startDate,
        dueDate: g.dueDate,
        completedOn: g.completedOn,
        externalId: g.externalId,
        externalLinks: [],
        iteration: null,
        assignees: [],
        milestone: null,
        specMode: null,
        detailPath: `./tasks/${taskId}.md`,
        updatedOn: g.updatedOn
      };
      const detail: TaskDetailRecord = {
        taskId,
        role: g.role,
        impact: g.impact,
        estimatedEffort: g.estimatedEffort,
        // export renders prerequisites from dependency_projection, which is
        // queried in lexical order by to_task_id -- match that order here so
        // the "expected" value already equals what round 2 will produce.
        prerequisites: [...g.dependsOn].sort(),
        blocking: [],
        filesAffected: g.filesAffected,
        testsRequired: g.testsRequired,
        summary: g.summary,
        descriptionGitHash: null
      };
      const outgoingEdges: DependencyRecord[] = g.dependsOn.map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "depends-on" as const }));
      return { task, detail, description, outgoingEdges };
    });
}

function boardArb(taskCount: number): fc.Arbitrary<GeneratedTask[]> {
  let chain: fc.Arbitrary<GeneratedTask[]> = fc.constant([]);
  for (let i = 0; i < taskCount; i++) {
    chain = chain.chain(soFar => taskArb(i, soFar.map(t => t.task.taskId)).map(next => [...soFar, next]));
  }
  return chain;
}

type GeneratedProject = {
  boardTitle: string;
  workDomains: WorkDomain[];
  notesMarkdown: string;
};

const workDomainArb: fc.Arbitrary<WorkDomain> = fc.record<WorkDomain>({
  key: domainKeyArb.map((s: string) => s.toUpperCase()),
  description: safeScalarArb
});

const projectArb: fc.Arbitrary<GeneratedProject> = fc.record<GeneratedProject>({
  boardTitle: safeScalarArb,
  workDomains: fc.uniqueArray(workDomainArb, { maxLength: 3, selector: (d: WorkDomain) => d.key }),
  notesMarkdown: fc.array(lineArb, { minLength: 0, maxLength: 3 }).map((lines: string[]) => lines.join("\n").replace(/\n+$/, ""))
});

test("property: store state -> export -> reimport is a fixed point on the Markdown-representable field set", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 6 }).chain(boardArb), projectArb, (rawTasks, rawProject) => {
      // fc.record builds its objects with Object.create(null); everything
      // the real system compares against has already gone through
      // JSON.stringify/parse at the journal boundary (plain-prototype
      // objects), so normalize the generated fixtures the same way before
      // comparing -- otherwise deepEqual (strict, via node:assert/strict)
      // fails on a prototype difference that has nothing to do with the
      // property under test.
      const tasks: GeneratedTask[] = JSON.parse(JSON.stringify(rawTasks));
      const project: GeneratedProject = JSON.parse(JSON.stringify(rawProject));
      const dir = mkTmpDir("mapctx-store-property-");
      try {
        const handle = StoreHandle.open(dir);
        handle.appendEvent({
          eventType: "project.initialized",
          actor: "property-test",
          payload: { projectId: "prop-test", ...project, plansAuthority: "markdown" as const, sourceSnapshotHash: null }
        });
        for (const t of tasks) {
          handle.appendEvent({
            eventType: "task.upserted",
            actor: "property-test",
            payload: { task: t.task, detail: t.detail, outgoingEdges: t.outgoingEdges }
          });
        }

        const exported = buildExport(handle.db, { tasksRoot: dir });
        fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
        fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, "utf8");
        for (const file of exported.taskDetailFiles) {
          fs.writeFileSync(file.path, file.content, "utf8");
          // buildExport reads description back from whatever is on disk;
          // for round 1 there was nothing there yet, so write the
          // generator's description directly first, then re-run export so
          // the file reflects it (mirrors how a real first export follows
          // an import that already had a description file present).
        }
        // Write descriptions explicitly (round buildExport once more so the
        // regenerated files carry the generator's description text).
        for (const t of tasks) {
          const detailPath = path.join(dir, "tasks", `${t.task.taskId}.md`);
          const current = fs.readFileSync(detailPath, "utf8");
          const withDescription = current.replace(/  - description: \|\n[\s\S]*$/, buildDescriptionBlock(t.description));
          fs.writeFileSync(detailPath, withDescription, "utf8");
        }
        const reExported = buildExport(handle.db, { tasksRoot: dir });
        fs.writeFileSync(reExported.tasksMd.path, reExported.tasksMd.content, "utf8");
        for (const file of reExported.taskDetailFiles) {
          fs.writeFileSync(file.path, file.content, "utf8");
        }

        const reimported = planImport(exported.tasksMd.path);
        try {
          assert.equal(reimported.errors, 0, `reimport must validate cleanly: ${JSON.stringify(reimported.issues)}`);
          assert.equal(reimported.taskCount, tasks.length);

          assert.equal(reimported.project.boardTitle, project.boardTitle);
          assert.deepEqual(reimported.project.workDomains, project.workDomains);
          assert.equal(reimported.project.notesMarkdown, project.notesMarkdown);

          for (const original of tasks) {
            const roundTripped = reimported.tasks.find(item => item.task.taskId === original.task.taskId);
            assert.ok(roundTripped, `task ${original.task.taskId} must survive the round trip`);
            assert.deepEqual(roundTripped!.task, original.task);
            const { descriptionGitHash: _a, ...expectedDetail } = original.detail;
            const { descriptionGitHash: _b, ...actualDetail } = roundTripped!.detail;
            assert.deepEqual(actualDetail, expectedDetail);
          }
        } catch (error) {
          if (process.env.MAPCTX_DEBUG_PROPERTY) {
            console.error("=== DEBUG DUMP ===");
            console.error("error message:", (error as Error).message);
            console.error("error expected:", (error as { expected?: unknown }).expected);
            console.error("error actual:", (error as { actual?: unknown }).actual);
            console.error("tasks in:", JSON.stringify(tasks, null, 2));
            console.error("project in:", JSON.stringify(project, null, 2));
            console.error("reimported:", JSON.stringify(reimported, null, 2));
            console.error("tasksMd content:\n", exported.tasksMd.content);
          }
          throw error;
        }

        handle.close();
      } finally {
        cleanupDir(dir);
      }
    }),
    { numRuns: 25 }
  );
});

function buildDescriptionBlock(description: string): string {
  const lines = description.split("\n").map(line => (line === "" ? "" : `      ${line}`));
  return `  - description: |\n${lines.join("\n")}\n`;
}
