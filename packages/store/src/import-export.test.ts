import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { importCommit, importDryRun, recoverStoreFromCheckpoint } from "./cutover"
import { buildExport } from "./export"
import { planImport } from "./import"
import { readMapctxToml } from "./config"
import { listTasks } from "./projections"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"
import { GOLDEN_FILES } from "./__test-fixtures__"

test("planImport reports zero errors and preserves order/count on the golden fixture", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const plan = planImport(path.join(repoDir, "TASKS.md"));
    assert.equal(plan.errors, 0);
    assert.equal(plan.taskCount, 3);
    assert.deepEqual(plan.ids, ["E-100", "T-101", "T-102"]);
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("planImport fails closed on duplicate ids, missing dependencies, and missing detail files", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const tasksPath = path.join(repoDir, "TASKS.md");
    const original = fs.readFileSync(tasksPath, "utf8");

    // Duplicate id: reuse E-100's id on T-101's block.
    const duplicated = original.replace("  - id: T-101\n", "  - id: E-100\n");
    fs.writeFileSync(tasksPath, duplicated, "utf8");
    let plan = planImport(tasksPath);
    assert.ok(plan.issues.some(i => i.code === "duplicate-id"));

    // Missing dependency: point T-102's dependsOn at a nonexistent id.
    const missingDep = original.replace("  - dependsOn: [T-101]", "  - dependsOn: [T-999]");
    fs.writeFileSync(tasksPath, missingDep, "utf8");
    plan = planImport(tasksPath);
    assert.ok(plan.issues.some(i => i.code === "missing-dependency"));

    // Missing detail file: point detail at a file that does not exist.
    const missingDetail = original.replace("./tasks/T-101.md", "./tasks/T-999.md");
    fs.writeFileSync(tasksPath, missingDetail, "utf8");
    plan = planImport(tasksPath);
    assert.ok(plan.issues.some(i => i.code === "missing-detail-file"));

    // Duplicate externalId: task_projection enforces uniqueness, so this
    // must be caught here with a clear error, not surfaced as a raw SQL
    // constraint failure partway through a commit.
    const duplicateExternalId = original
      .replace("  - externalId: null\n  - updated: 2026-01-02", "  - externalId: github:issue:1\n  - updated: 2026-01-02")
      .replace("  - externalId: null\n  - updated: null", "  - externalId: github:issue:1\n  - updated: null");
    fs.writeFileSync(tasksPath, duplicateExternalId, "utf8");
    plan = planImport(tasksPath);
    const dupIssues = plan.issues.filter(i => i.code === "duplicate-external-id");
    assert.equal(dupIssues.length, 2, "both tasks sharing the externalId must be flagged");
    assert.deepEqual(new Set(dupIssues.map(i => i.taskId)), new Set(["E-100", "T-101"]));
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("importCommit: cutover writes mapctx.toml with plansAuthority=store, deletes mapcs.config.json, and one export round-trips byte-identically", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test-actor" });

    assert.ok(fs.existsSync(result.mapctxTomlPath));
    assert.equal(fs.existsSync(path.join(repoDir, "mapcs.config.json")), false, "legacy config must be deleted in the cutover commit");

    const toml = readMapctxToml(result.mapctxTomlPath);
    assert.equal(toml.plansAuthority, "store");
    assert.equal(toml.projectId, result.projectId);
    assert.equal(toml.github?.verified, false, "import must never mark the inherited GitHub binding as verified");
    assert.equal(toml.github?.owner, "octocat");

    const handle = StoreHandle.open(result.storeDir);
    const firstExport = buildExport(handle.db, { tasksRoot: repoDir });
    const secondExport = buildExport(handle.db, { tasksRoot: repoDir });
    assert.equal(firstExport.tasksMd.content, secondExport.tasksMd.content, "repeated export with no new events must be byte-identical");

    const onDiskTasksMd = fs.readFileSync(path.join(repoDir, "TASKS.md"), "utf8");
    assert.equal(onDiskTasksMd, firstExport.tasksMd.content, "cutover-written TASKS.md must equal what buildExport produces from the same store state");

    for (const file of firstExport.taskDetailFiles) {
      const onDisk = fs.readFileSync(file.path, "utf8");
      assert.equal(onDisk, file.content);
    }

    // Description prose must survive the import -> export cycle byte-for-byte.
    const t102 = fs.readFileSync(path.join(repoDir, "tasks", "T-102.md"), "utf8");
    assert.equal(t102, GOLDEN_FILES["tasks/T-102.md"]);

    handle.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("importCommit refuses to run twice against the same repo (mapctx.toml already exists)", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    importCommit({ cwd: repoDir, actor: "first" });
    assert.throws(() => importCommit({ cwd: repoDir, actor: "second" }), /already exists/);
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("recoverStoreFromCheckpoint rebuilds a fresh store (new node/incarnation, same projectId) from the last git-committed TASKS.md", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const first = importCommit({ cwd: repoDir, actor: "first" });
    const originalHandle = StoreHandle.open(first.storeDir);
    const originalNodeId = originalHandle.nodeId;
    const originalIncarnationId = originalHandle.incarnationId;
    originalHandle.close();

    // Simulate total loss of ~/.mapctx/projects/<id>/ -- the git-committed
    // TASKS.md/tasks/*.md (already written by the cutover commit) is all
    // that is left to recover from.
    fs.rmSync(first.storeDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(first.storeDir), false);

    const recovered = recoverStoreFromCheckpoint({
      tasksFilePath: path.join(repoDir, "TASKS.md"),
      tasksRoot: repoDir,
      projectId: first.projectId,
      storeDir: first.storeDir,
      actor: "recovery-actor"
    });

    assert.equal(recovered.projectId, first.projectId, "recovery must keep the same project identity");
    assert.notEqual(recovered.nodeId, originalNodeId, "recovery starts a fresh node identity");
    assert.notEqual(recovered.incarnationId, originalIncarnationId, "recovery starts a fresh incarnation (event epoch)");
    assert.equal(recovered.taskCount, 3);

    const reopened = StoreHandle.open(first.storeDir);
    assert.equal(listTasks(reopened.db).length, 3);
    const reExport = buildExport(reopened.db, { tasksRoot: repoDir });
    const onDisk = fs.readFileSync(path.join(repoDir, "TASKS.md"), "utf8");
    assert.equal(reExport.tasksMd.content, onDisk, "the recovered store must reproduce the exact checkpoint it recovered from");
    reopened.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("importDryRun reports the project, board path, task count, and the markdown -> store transition it would perform", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importDryRun({ tasksFilePath: path.join(repoDir, "TASKS.md"), cwd: repoDir });

    assert.equal(result.wouldCommit, true);
    const cutover = result.cutover;
    assert.ok(cutover, "a dry run given a cwd must preview the cutover, not only the board plan");
    assert.deepEqual(cutover.blockers, []);
    assert.equal(cutover.projectId, null, "no project identity exists before the first cutover");
    assert.equal(cutover.projectIdSource, "generated-at-commit");
    assert.equal(cutover.storeDir, null);
    assert.deepEqual(cutover.plansAuthority, { current: "markdown", proposed: "store" });
    assert.equal(cutover.tasksFilePath, path.join(repoDir, "TASKS.md"));
    assert.equal(cutover.taskCount, 3);
    assert.equal(cutover.legacyConfigPresent, true);
    assert.equal(cutover.mapctxTomlPath, path.join(repoDir, "mapctx.toml"));
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("importDryRun after cutover names the existing project and refuses a second import instead of reporting wouldCommit", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const committed = importCommit({ cwd: repoDir, actor: "first" });

    const result = importDryRun({ tasksFilePath: path.join(repoDir, "TASKS.md"), cwd: repoDir });

    assert.equal(result.wouldCommit, false, "an already-imported repository must never report a committable cutover");
    const cutover = result.cutover!;
    assert.equal(cutover.projectId, committed.projectId);
    assert.equal(cutover.projectIdSource, "mapctx.toml");
    assert.equal(cutover.storeDir, committed.storeDir);
    assert.equal(cutover.plansAuthority.current, "store");
    assert.equal(cutover.legacyConfigPresent, false, "the legacy config is deleted by the cutover commit");
    assert.ok(cutover.blockers.some(b => b.includes("already been imported")));
    assert.ok(cutover.blockers.some(b => b.includes("none found")));
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("importDryRun reports uncommitted board changes as blockers rather than letting the cutover commit sweep them in", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    fs.appendFileSync(path.join(repoDir, "TASKS.md"), "\n<!-- uncommitted edit -->\n", "utf8");

    const result = importDryRun({ tasksFilePath: path.join(repoDir, "TASKS.md"), cwd: repoDir });

    assert.equal(result.wouldCommit, false);
    assert.ok(result.cutover!.blockers.some(b => b.includes("TASKS.md") && b.includes("pending uncommitted changes")));
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("planImport raises unrepresentable-field-value as an error when the parser drops an out-of-enum value", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const tasksPath = path.join(repoDir, "TASKS.md");
    const original = fs.readFileSync(tasksPath, "utf8");

    // `Medium` is not in the workload enum (Easy/Normal/Hard/Extreme). Before
    // the droppedFields change the parser discarded it silently and the cutover
    // deleted the authored value without any signal.
    const drifted = original.replace("  - workload: null", "  - workload: Medium");
    fs.writeFileSync(tasksPath, drifted, "utf8");

    const plan = planImport(tasksPath);
    const dropped = plan.issues.filter(i => i.code === "unrepresentable-field-value");
    assert.equal(dropped.length, 1, "the dropped workload must be surfaced exactly once");
    assert.equal(dropped[0].taskId, "T-101");
    assert.equal(dropped[0].severity, "error", "a value that would be deleted must block the import, not warn");
    assert.ok(dropped[0].message.includes("workload"));
    assert.ok(plan.errors > 0);
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("cutover fails closed on prerequisites-dependson-mismatch: dry-run names it as a blocker and importCommit refuses", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    // T-102 depends on T-101 in TASKS.md; make its detail file claim a
    // prerequisite the board does not list. Plain `validate` keeps this a
    // warning, but after the cutover the detail file is regenerated from the
    // board, so the losing side would be deleted silently.
    const detailPath = path.join(repoDir, "tasks", "T-102.md");
    fs.writeFileSync(
      detailPath,
      GOLDEN_FILES["tasks/T-102.md"].replace("- prerequisites: [T-101]", "- prerequisites: [T-101, T-999]"),
      "utf8"
    );

    const dry = importDryRun({ tasksFilePath: path.join(repoDir, "TASKS.md"), cwd: repoDir });
    assert.equal(dry.wouldCommit, false, "a mismatching prerequisite must not report a committable cutover");
    const blocker = dry.cutover!.blockers.find(b => b.includes("prerequisites-dependson-mismatch"));
    assert.ok(blocker, "dry run must name the mismatch as a cutover blocker");
    assert.ok(blocker!.includes("T-102"));

    assert.throws(() => importCommit({ cwd: repoDir, actor: "test-actor" }), err => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Cutover refused"), "the refusal must say the board and detail file disagree");
      assert.ok(err.message.includes("prerequisites-dependson-mismatch"));
      assert.ok(err.message.includes("T-102"));
      return true;
    });

    // Nothing must have leaked: no mapctx.toml, no store, legacy config intact.
    assert.equal(fs.existsSync(path.join(repoDir, "mapctx.toml")), false);
    assert.equal(fs.existsSync(path.join(repoDir, "mapcs.config.json")), true);
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});
