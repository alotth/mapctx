/**
 * A disposable store for the contract suite to run against.
 *
 * It builds its own small board rather than borrowing the store package's
 * golden fixture: the contract suite's expectations should be visible next to
 * the suite, and a fixture shared with another package's round-trip tests
 * would couple the two.
 *
 * `MAPCTX_HOME` is redirected to a temp directory for the lifetime of the
 * fixture, so nothing here can reach the developer's real `~/.mapctx`. That is
 * the same guard `setupGoldenRepo` uses in the store package, and it is not
 * optional: these tests write.
 */

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { StoreHandle, importCommit, reviseAcceptance } from "@mapctx/store"

export const FIXTURE_EPIC = "E-200"
export const FIXTURE_WRITABLE = "T-201"
export const FIXTURE_SECOND = "T-202"
export const FIXTURE_THIRD = "T-203"
/** Never created, so a read of it must be not-found. */
export const FIXTURE_MISSING = "T-999"

export const FIXTURE_CRITERIA = [
  "The contract suite can read this criterion.",
  "The contract suite can page past this criterion.",
  "The contract suite can flip this criterion."
]

function boardMarkdown(): string {
  const task = (id: string, title: string, parent: string | null, type: string): string =>
    [
      `### [${id}] ${title}`,
      "",
      `  - id: ${id}`,
      "  - status: backlog",
      `  - type: ${type}`,
      `  - parent: ${parent ?? "null"}`,
      "  - subIssueProgress: null",
      "  - priority: null",
      "  - workload: Normal",
      "  - tags: []",
      "  - domains: [CODE]",
      "  - dependsOn: []",
      "  - start: null",
      "  - due: null",
      "  - completed: null",
      "  - externalId: null",
      "  - updated: 2026-01-01",
      `  - detail: ./tasks/${id}.md`,
      ""
    ].join("\n")

  return [
    "# Provider Contract Fixture Board",
    "",
    "## Work Domains",
    "",
    "- CODE: provider contract fixture",
    "",
    "## Tasks",
    "",
    task(FIXTURE_EPIC, "Fixture epic", null, "epic"),
    task(FIXTURE_WRITABLE, "Fixture writable item", null, "task"),
    task(FIXTURE_SECOND, "Fixture second item", null, "task"),
    task(FIXTURE_THIRD, "Fixture third item", null, "task"),
    ""
  ].join("\n")
}

function detailMarkdown(id: string): string {
  return [
    `# ${id}`,
    "",
    "  - role: implementation",
    "  - impact: medium",
    "  - estimatedEffort: 2h",
    "  - prerequisites: []",
    "  - blocking: []",
    "  - filesAffected: []",
    "  - testsRequired: []",
    `  - summary: Fixture detail for ${id}.`,
    "  - description: |",
    `      Fixture prose for ${id}. Git-authored, never stored.`,
    ""
  ].join("\n")
}

const LEGACY_CONFIG = {
  owner: "fixture-owner",
  repo: "fixture-repo",
  projectId: "PVT_contract_fixture",
  statusFieldId: "PVTSSF_contract_fixture",
  statusMap: {
    backlog: "Backlog",
    "ready-for-do": "Ready for Do",
    doing: "Doing",
    review: "Review",
    done: "Done",
    paused: "Paused"
  },
  tasksFile: "./TASKS.md",
  bootstrap: {
    createMissingDetailFiles: true,
    defaultStatusForImportedIssues: "backlog",
    requireConfirmFlag: false
  }
}

export type ProviderFixture = {
  handle: StoreHandle
  storeDir: string
  repoDir: string
  teardown: () => void
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

export function createProviderFixture(): ProviderFixture {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-provider-repo-"))
  fs.mkdirSync(path.join(repoDir, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(repoDir, "TASKS.md"), boardMarkdown(), "utf8")
  for (const id of [FIXTURE_EPIC, FIXTURE_WRITABLE, FIXTURE_SECOND, FIXTURE_THIRD]) {
    fs.writeFileSync(path.join(repoDir, "tasks", `${id}.md`), detailMarkdown(id), "utf8")
  }
  fs.writeFileSync(path.join(repoDir, "mapcs.config.json"), `${JSON.stringify(LEGACY_CONFIG, null, 2)}\n`, "utf8")

  git(repoDir, ["init", "-q"])
  git(repoDir, ["config", "user.email", "fixture@example.com"])
  git(repoDir, ["config", "user.name", "Fixture"])
  git(repoDir, ["add", "-A"])
  git(repoDir, ["commit", "-q", "-m", "fixture board"])

  const mapctxHome = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-provider-home-"))
  const previousHome = process.env.MAPCTX_HOME
  process.env.MAPCTX_HOME = mapctxHome

  const committed = importCommit({ cwd: repoDir, actor: "fixture" })
  const handle = StoreHandle.open(committed.storeDir)

  // Acceptance is authored explicitly rather than imported from the detail
  // file's checklist: observed checkboxes are not a claim of verification
  // (ADR 0004), and the suite needs criteria it can page over and flip.
  const revised = reviseAcceptance(handle, {
    taskId: FIXTURE_WRITABLE,
    condition: "criteria",
    texts: FIXTURE_CRITERIA,
    actor: "fixture",
    expectRevision: 0
  })
  if (!revised.ok) throw new Error(`fixture could not author acceptance: ${JSON.stringify(revised)}`)

  return {
    handle,
    storeDir: committed.storeDir,
    repoDir,
    teardown: () => {
      handle.close()
      if (previousHome === undefined) delete process.env.MAPCTX_HOME
      else process.env.MAPCTX_HOME = previousHome
      fs.rmSync(repoDir, { recursive: true, force: true })
      fs.rmSync(mapctxHome, { recursive: true, force: true })
    }
  }
}
