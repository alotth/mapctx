#!/usr/bin/env node

import { cp, mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, "..")
const distDir = path.join(root, "packages", "opencode-plugin", "dist")
const pluginEntry = path.join(root, "packages", "opencode-plugin", "kanban-roadmap.js")
const targetDir = path.join(homedir(), ".config", "opencode", "plugins", "kanban-roadmap")
const targetEntry = path.join(homedir(), ".config", "opencode", "plugins", "kanban-roadmap.js")

const requiredFiles = ["index.html", "kanban-roadmap.css", "kanban-roadmap.js", "core-helpers.js"]

const runBuild = () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "build-opencode-plugin.mjs")], {
    cwd: root,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    throw new Error("Build step failed")
  }
}

const ensureDistFiles = async () => {
  for (const file of requiredFiles) {
    const filePath = path.join(distDir, file)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        throw new Error(`${filePath} is not a file`)
      }
    } catch {
      throw new Error(`Missing built file: ${filePath}`)
    }
  }
}

const ensurePluginEntry = async () => {
  try {
    const info = await stat(pluginEntry)
    if (!info.isFile()) {
      throw new Error(`${pluginEntry} is not a file`)
    }
  } catch {
    throw new Error(`Missing plugin entry file: ${pluginEntry}`)
  }
}

const install = async () => {
  runBuild()
  await ensureDistFiles()
  await ensurePluginEntry()

  await mkdir(targetDir, { recursive: true })
  for (const file of requiredFiles) {
    await cp(path.join(distDir, file), path.join(targetDir, file))
  }
  await cp(pluginEntry, targetEntry)

  console.log(`Installed plugin assets in ${targetDir}`)
  console.log(`Installed plugin entry in ${targetEntry}`)
}

install().catch((error) => {
  console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
