#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-pack-"))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: "utf8",
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

  console.log(`Verified packed @mapctx/sync-engine install in ${installDir}`)
} finally {
  if (process.env.MAPCTX_KEEP_PACK_VERIFY !== "1") {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
