#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const coreDir = path.join(rootDir, "packages", "core")
const syncEngineDir = path.join(rootDir, "packages", "sync-engine")
const coreDistDir = path.join(coreDir, "dist")
const bundledCoreDir = path.join(syncEngineDir, "node_modules", "@mapctx", "core")

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`)
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

run("npm", ["run", "build", "--workspace", "@mapctx/core"])

for (const file of ["index.js", "workspace.js", "thread.js"]) {
  const filePath = path.join(coreDistDir, file)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing built core file: ${filePath}`)
  }
}

const corePackageJson = readJson(path.join(coreDir, "package.json"))
const bundledPackageJson = {
  name: corePackageJson.name,
  version: corePackageJson.version,
  description: corePackageJson.description,
  type: corePackageJson.type,
  main: corePackageJson.main,
  types: corePackageJson.types,
  typesVersions: corePackageJson.typesVersions,
  exports: corePackageJson.exports,
  license: "MIT",
}

fs.rmSync(bundledCoreDir, { recursive: true, force: true })
fs.mkdirSync(bundledCoreDir, { recursive: true })
fs.cpSync(coreDistDir, path.join(bundledCoreDir, "dist"), { recursive: true })
fs.writeFileSync(path.join(bundledCoreDir, "package.json"), `${JSON.stringify(bundledPackageJson, null, 2)}\n`)
fs.copyFileSync(path.join(rootDir, "LICENSE"), path.join(bundledCoreDir, "LICENSE"))

console.error(`Bundled @mapctx/core into ${bundledCoreDir}`)
