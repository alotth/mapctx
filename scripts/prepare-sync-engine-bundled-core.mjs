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
// Runtime deps of the bundled packages (and of sync-engine itself). npm
// global installs do NOT reify the declared dependencies of a tarball that
// already ships a node_modules tree ("added 1 package", empty placeholder
// dirs) -- so the union of runtime deps must be vendored too, or the
// published binary fails on `Cannot find module 'smol-toml'`.
const vendoredRuntime = ["smol-toml", "zod", "zod-to-json-schema"]

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

// Vendor the runtime dependencies: resolve each from the sync-engine node
// graph and copy the real installed package (not a symlink) into the bundle.
for (const name of vendoredRuntime) {
  const bundledDir = path.join(syncEngineDir, "node_modules", name)
  fs.rmSync(bundledDir, { recursive: true, force: true })
  const resolved = spawnSync("node", ["-e", `process.stdout.write(require.resolve('${name}'))`], {
    cwd: syncEngineDir,
    encoding: "utf8",
  })
  if (resolved.status !== 0 || !fs.existsSync(resolved.stdout.trim())) {
    throw new Error(`Cannot vendor runtime dep ${name}: not resolvable from sync-engine node_modules`)
  }
  // Walk up from the resolved entry file to the directory holding its
  // package.json (some packages export no './package.json' subpath).
  let packageDir = path.dirname(resolved.stdout.trim())
  while (!fs.existsSync(path.join(packageDir, "package.json"))) {
    const parent = path.dirname(packageDir)
    if (parent === packageDir) throw new Error(`Cannot vendor runtime dep ${name}: no package.json above ${resolved.stdout.trim()}`)
    packageDir = parent
  }
  fs.cpSync(packageDir, bundledDir, { recursive: true })
  console.error(`Vendored ${name} into ${bundledDir}`)
}
