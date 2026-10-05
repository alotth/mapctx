#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as net from "node:net"
import assert from "node:assert/strict"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-pack-"))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: "utf8",
    env: options.env || process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`)
  }

  return result.stdout || ""
}

function npmPack(workspace) {
  const output = run("npm", ["pack", "--workspace", workspace, "--pack-destination", tempDir, "--json"], {
    capture: true,
  })
  const packs = JSON.parse(output)
  const filename = packs[0]?.filename
  if (!filename) throw new Error(`npm pack did not return a tarball for ${workspace}`)
  return path.join(tempDir, filename)
}

let workspaceChild
try {
  const syncEngineTarball = npmPack("@mapctx/sync-engine")
  const installDir = path.join(tempDir, "install")
  fs.mkdirSync(installDir)

  run("npm", ["init", "-y"], { cwd: installDir })
  run("npm", ["install", "--no-audit", "--no-fund", syncEngineTarball], { cwd: installDir })

  const bundledCorePackageJson = path.join(
    installDir,
    "node_modules",
    "@mapctx",
    "sync-engine",
    "node_modules",
    "@mapctx",
    "core",
    "package.json",
  )
  if (!fs.existsSync(bundledCorePackageJson)) {
    throw new Error(`Packed sync-engine did not include bundled @mapctx/core: ${bundledCorePackageJson}`)
  }

  const binDir = path.join(installDir, "node_modules", ".bin")
  run(path.join(binDir, "mapctx"), ["--help"], { cwd: installDir })
  run(path.join(binDir, "mapcs"), ["--help"], { cwd: installDir })

  const repoDir = path.join(tempDir, "project")
  fs.mkdirSync(path.join(repoDir, "tasks"), { recursive: true })
  const env = { ...process.env, MAPCTX_HOME: path.join(tempDir, "mapctx-home"),
    GIT_AUTHOR_NAME: "Package smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "Package smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid" }
  const fields = { id: "T-001", status: "backlog", type: "task", parent: "null",
    subIssueProgress: "null", priority: "null", workload: "Easy", tags: "[]", domains: "[CORE]",
    dependsOn: "[]", start: "null", due: "null", completed: "null", externalId: "null",
    updated: "null", detail: "./tasks/T-001.md" }
  fs.writeFileSync(path.join(repoDir, "TASKS.md"), "# Packed fixture\n\n## Work Domains\n\n- CORE: engine\n\n## Tasks\n\n### [T-001] Pack smoke\n\n" +
    Object.entries(fields).map(([key, value]) => `  - ${key}: ${value}`).join("\n") + "\n")
  fs.writeFileSync(path.join(repoDir, "tasks", "T-001.md"), `# T-001

  - role: implementation
  - impact: low
  - estimatedEffort: 1h
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Pack smoke
  - description: |
      ## Acceptance
      - [x] Package works standalone.
      Evidence: retained authored note.
`)
  run("git", ["init", "-q"], { cwd: repoDir, env })
  run(path.join(binDir, "mapcs"), ["init"], { cwd: repoDir, env, capture: true })
  run("git", ["add", "."], { cwd: repoDir, env })
  run("git", ["commit", "-qm", "fixture"], { cwd: repoDir, env })
  const cli = (args) => JSON.parse(run(path.join(binDir, "mapctx"), [...args, "--json"],
    { cwd: repoDir, env, capture: true }))
  cli(["import", "--commit"])
  cli(["acceptance", "import", "--commit"])
  const acceptance = cli(["task", "acceptance", "show", "T-001"])
  assert.equal(acceptance.acceptance.criteria[0].state, "approved")
  cli(["validate"])
  cli(["export", "--reason", "manual"])
  cli(["validate", "--snapshots"])
  assert.match(fs.readFileSync(path.join(repoDir, "tasks", "T-001.md"), "utf8"), /Evidence: retained authored note/)

  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const assigned = probe.address().port
      probe.close(() => resolve(assigned))
    })
  })
  let workspaceLog = ""
  workspaceChild = spawn(path.join(binDir, "mapctx"), ["workspace", "--no-open", "--port", String(port)],
    { cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"] })
  workspaceChild.stdout.on("data", data => { workspaceLog += data })
  workspaceChild.stderr.on("data", data => { workspaceLog += data })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (workspaceChild.exitCode !== null) throw new Error(`Packed workspace exited: ${workspaceLog}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) { assert.match(await response.text(), /workspaceV2.js/); ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Packed workspace never became ready: ${workspaceLog}`)
  for (const file of ["workspaceV2.js", "workspaceV2.css"]) {
    const response = await fetch(`http://127.0.0.1:${port}/${file}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).length > 100)
  }
  console.log(`Verified packed CLI, store, Acceptance, checkpoint and HTTP assets in ${installDir}`)
} finally {
  if (workspaceChild && workspaceChild.exitCode === null) {
    const exited = new Promise(resolve => workspaceChild.once("exit", resolve))
    workspaceChild.kill("SIGTERM")
    await exited
  }
  if (process.env.MAPCTX_KEEP_PACK_VERIFY !== "1") {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
