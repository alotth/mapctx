#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, "..")
const pluginRoot = path.join(root, "packages", "opencode-plugin")
const coreRoot = path.join(root, "packages", "core")
const srcDir = path.join(pluginRoot, "src")
const distDir = path.join(pluginRoot, "dist")
const coreHelperSource = path.join(coreRoot, "browser", "core-helpers.js")

const requiredFiles = ["index.html", "kanban-roadmap.css", "kanban-roadmap.js"]

const ensureSourceFiles = async () => {
  for (const file of requiredFiles) {
    const filePath = path.join(srcDir, file)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        throw new Error(`${filePath} is not a file`)
      }
    } catch {
      throw new Error(`Missing required source file: ${filePath}`)
    }
  }
}

const build = async () => {
  await ensureSourceFiles()
  await stat(coreHelperSource)
  await rm(distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  for (const file of requiredFiles) {
    await cp(path.join(srcDir, file), path.join(distDir, file))
  }
  await cp(coreHelperSource, path.join(distDir, "core-helpers.js"))

  console.log(`OpenCode plugin assets built in ${distDir}`)
}

build().catch((error) => {
  console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
