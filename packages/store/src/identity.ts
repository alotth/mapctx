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

export function storeMetaPath(storeDir: string): string {
  return path.join(storeDir, STORE_META_FILENAME)
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

export function writeStoreMetaFile(storeDir: string, meta: StoreMeta): void {
  fs.mkdirSync(storeDir, { recursive: true })
  fs.writeFileSync(storeMetaPath(storeDir), `${JSON.stringify(meta, null, 2)}\n`, "utf8")
}

export function createStoreMeta(now: () => Date = () => new Date()): StoreMeta {
  return {
    nodeId: crypto.randomUUID(),
    incarnationId: crypto.randomUUID(),
    createdAt: now().toISOString(),
    sequenceWatermarks: {}
  }
}

export function bumpSequenceWatermark(storeDir: string, nodeId: string, sequence: number): void {
  const meta = readStoreMetaFile(storeDir);
  if (!meta) throw new Error(`Cannot bump sequence watermark: no ${STORE_META_FILENAME} at ${storeDir}.`);
  const current = meta.sequenceWatermarks[nodeId] ?? 0;
  if (sequence <= current) return;
  meta.sequenceWatermarks = { ...meta.sequenceWatermarks, [nodeId]: sequence };
  writeStoreMetaFile(storeDir, meta);
}
