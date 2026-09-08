import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"

export type StoreMeta = {
  nodeId: string
  incarnationId: string
  createdAt: string
  /**
   * Highest sequence ever durably committed per node, tracked outside
   * mapctx.db. Directory listing alone cannot detect a fully-deleted
   * trailing journal file (or an entire events/<nodeId>/ directory) as a
   * gap -- it just looks like nothing was ever written. This watermark is
   * the independent cross-check repair.ts needs to catch that case instead
   * of silently reprojecting a shorter history than what was committed.
   */
  sequenceWatermarks: Record<string, number>
}

const STORE_META_FILENAME = "store-meta.json"
const STORE_META_LOCK_DIRNAME = "store-meta.lock"
const STORE_META_LOCK_TIMEOUT_MS = 10_000
const STORE_META_LOCK_RETRY_MS = 20

export function storeMetaPath(storeDir: string): string {
  return path.join(storeDir, STORE_META_FILENAME)
}

/**
 * Cross-process mutex around the read/modify/write of store-meta.json. The
 * SQLite writer lock ends at COMMIT but the watermark bump happens after it,
 * so two serialized writers would otherwise race an unlocked
 * read-max-truncate-write: A commits 3 and reads 2; B commits 4, reads 2,
 * writes 4; A then writes 3 and the watermark regresses -- or overlapping
 * plain writeFileSync calls expose truncated JSON to a concurrent reader and
 * repair cannot even start. mkdir is atomic across processes, so the lock
 * directory is the critical section; the owner file lets a later process
 * steal a lock whose holder died.
 */
export function withStoreMetaLock<T>(storeDir: string, fn: () => T): T {
  fs.mkdirSync(storeDir, { recursive: true })
  const lockDir = path.join(storeDir, STORE_META_LOCK_DIRNAME)
  const deadline = Date.now() + STORE_META_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, "owner"), String(process.pid), "utf8")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring the store metadata lock at ${lockDir}; another process may be stuck holding it.`)
      }
      stealDeadHolderLock(lockDir)
      sleepStoreMetaLock(STORE_META_LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

function stealDeadHolderLock(lockDir: string): void {
  let owner: number
  try {
    owner = Number(fs.readFileSync(path.join(lockDir, "owner"), "utf8"))
  } catch {
    return // owner file missing or unreadable: leave the lock for the timeout
  }
  if (!Number.isInteger(owner) || owner === process.pid) return
  try {
    process.kill(owner, 0) // signals nothing; ESRCH proves the holder is gone
    return
  } catch {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

function sleepStoreMetaLock(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function readStoreMetaFile(storeDir: string): StoreMeta | undefined {
  const file = storeMetaPath(storeDir)
  if (!fs.existsSync(file)) return undefined
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoreMeta>
  if (!raw.nodeId || !raw.incarnationId || !raw.createdAt) {
    throw new Error(`Corrupt ${STORE_META_FILENAME} at ${file}: missing nodeId/incarnationId/createdAt.`)
  }
  return {
    nodeId: raw.nodeId,
    incarnationId: raw.incarnationId,
    createdAt: raw.createdAt,
    sequenceWatermarks: raw.sequenceWatermarks ?? {}
  }
}

/**
 * Atomic and reader-safe: temp file -> fsync -> rename, then a parent
 * directory fsync so the rename survives a crash. Readers either see the
 * complete previous file or the complete new one, never truncated JSON.
 * Callers that read-modify-write the meta must hold withStoreMetaLock.
 */
export function writeStoreMetaFile(storeDir: string, meta: StoreMeta): void {
  fs.mkdirSync(storeDir, { recursive: true })
  const finalPath = storeMetaPath(storeDir)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, `${JSON.stringify(meta, null, 2)}\n`, null, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmpPath, finalPath)
  } finally {
    fs.rmSync(tmpPath, { force: true })
  }
  syncDirectory(storeDir)
}

export function createStoreMeta(now: () => Date = () => new Date()): StoreMeta {
  return {
    nodeId: crypto.randomUUID(),
    incarnationId: crypto.randomUUID(),
    createdAt: now().toISOString(),
    sequenceWatermarks: {}
  }
}

/**
 * Persist the high-water mark of durably committed sequences for one node.
 * The lock makes the read/max/write atomic across processes and the max
 * guard makes it monotonic, so post-commit updates arriving out of order
 * (writer A commits 3 but bumps after writer B commits 4) converge on the
 * true maximum instead of regressing.
 */
export function bumpSequenceWatermark(storeDir: string, nodeId: string, sequence: number): void {
  withStoreMetaLock(storeDir, () => {
    const meta = readStoreMetaFile(storeDir)
    if (!meta) throw new Error(`Cannot bump sequence watermark: no ${STORE_META_FILENAME} at ${storeDir}.`)
    const current = meta.sequenceWatermarks[nodeId] ?? 0
    if (sequence <= current) return
    meta.sequenceWatermarks = { ...meta.sequenceWatermarks, [nodeId]: sequence }
    writeStoreMetaFile(storeDir, meta)
  })
}

export function readSequenceWatermark(storeDir: string, nodeId: string): number {
  return readStoreMetaFile(storeDir)?.sequenceWatermarks[nodeId] ?? 0
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r")
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
