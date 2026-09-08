#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// T-074: bundles every @mapctx workspace dependency of @mapctx/sync-engine
// into its node_modules for the publish tarball. The vNext added store,
// protocol, planner and forecast on top of core; only the manually-bundled
// core made it into the 0.0.7 tarball because the rest hoisted to the root
// node_modules and npm pack only inlines what it can see. All five are
// private workspace packages -- bundleDependencies is what carries them.
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const syncEngineDir = path.join(rootDir, "packages", "sync-engine")
const bundledNames = ["core", "protocol", "store", "planner", "forecast"]

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

for (const name of bundledNames) {
  run("npm", ["run", "build", "--workspace", `@mapctx/${name}`])
}

for (const name of bundledNames) {
  const sourceDir = path.join(rootDir, "packages", name)
  const distDir = path.join(sourceDir, "dist")
  const bundledDir = path.join(syncEngineDir, "node_modules", "@mapctx", name)
  const packageJson = readJson(path.join(sourceDir, "package.json"))

  for (const required of ["main", "types"]) {
    if (packageJson[required] === undefined) {
      throw new Error(`@mapctx/${name} package.json is missing "${required}"`)
    }
  }

  fs.rmSync(bundledDir, { recursive: true, force: true })
  fs.mkdirSync(bundledDir, { recursive: true })
  fs.cpSync(distDir, path.join(bundledDir, "dist"), { recursive: true })
  // Keep the package's own runtime dependencies (zod, smol-toml, ...) but
  // point any @mapctx/* references at the fixed released version -- the
  // bundled copies of those siblings are already in the tarball's
  // node_modules, so npm must not try to fetch private packages.
  const bundledDeps = {}
  for (const [depName, spec] of Object.entries(packageJson.dependencies ?? {})) {
    bundledDeps[depName] = depName.startsWith("@mapctx/") ? "0.1.0" : spec
  }
  fs.writeFileSync(path.join(bundledDir, "package.json"), `${JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    type: packageJson.type,
    main: packageJson.main,
    types: packageJson.types,
    typesVersions: packageJson.typesVersions,
    exports: packageJson.exports,
    dependencies: bundledDeps,
    license: "MIT",
  }, null, 2)}\n`)
  fs.copyFileSync(path.join(rootDir, "LICENSE"), path.join(bundledDir, "LICENSE"))
  console.error(`Bundled @mapctx/${name} into ${bundledDir}`)
}
