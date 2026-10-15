/**
 * Loading the recorded and synthetic GitHub fixtures.
 *
 * Read from disk at `__dirname/fixtures` rather than `require`d as JSON so the
 * two provenances stay visible in the file itself: a caller gets the whole
 * `FixtureFile`, including its `provenance` and `note`, and a test can assert
 * on them. The build copies `src/github/fixtures/*.json` into `dist`, the same
 * way the sync-engine build copies its workspace assets.
 */

import fs from "node:fs"
import path from "node:path"

import type { FixtureFile } from "./transport"

export const FIXTURE_DIR = path.join(__dirname, "fixtures")

export const RECORDED_FIXTURE = "github-recorded.json"
export const SYNTHETIC_FIXTURE = "github-synthetic.json"

/** Context the recorder captured alongside the responses, so a test need not guess ids. */
export type RecordedContext = {
  project: string
  writableItem: { provider: "github"; workItem: { id: string; key: string; url?: string }; species?: string }
  secondWritableItem: RecordedContext["writableItem"]
  missingItem: RecordedContext["writableItem"]
  narrowedSpeciesItem: RecordedContext["writableItem"]
  expectedItemCount: number
  repoCollection: string
  repoItemRefs: RecordedContext["writableItem"][]
}

export type RecordedFixtureFile = FixtureFile & {
  context: RecordedContext
  contractReport?: { passed: number; failed: number; skipped: number }
}

export function loadFixtureFile(name: string): FixtureFile {
  const file = path.join(FIXTURE_DIR, name)
  // A missing fixture is a build problem, not an empty data set: failing loudly
  // here is the difference between a red test and a green one that exercised
  // nothing.
  if (!fs.existsSync(file)) {
    throw new Error(`fixture ${name} not found at ${file}; run the provider build, which copies src/github/fixtures into dist`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as FixtureFile
}

export function loadRecordedFixture(): RecordedFixtureFile {
  const file = loadFixtureFile(RECORDED_FIXTURE) as RecordedFixtureFile
  if (file.provenance !== "recorded") {
    throw new Error(`${RECORDED_FIXTURE} must declare provenance "recorded", got ${file.provenance}`)
  }
  return file
}

export function loadSyntheticFixture(): FixtureFile {
  const file = loadFixtureFile(SYNTHETIC_FIXTURE)
  if (file.provenance !== "synthetic") {
    throw new Error(`${SYNTHETIC_FIXTURE} must declare provenance "synthetic", got ${file.provenance}`)
  }
  return file
}
