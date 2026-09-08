import * as fs from "fs"
import * as path from "path"

/**
 * Store-wide maintenance lock (R12): repair swaps the database file, so it
 * must exclude every opener/writer for the duration -- otherwise a worktree
 * appends against a database inode that is about to be replaced, or keeps
 * writing after the swap through a stale handle, and the two sides allocate
 * the same journal sequence from different indexes.
 *
 * The lock is an exclusive-create file carrying the holder's PID. Holders
 * that die mid-repair leave a stale lock; a caller may steal it when the
 * recorded PID is provably dead (no process exists for it), so a crashed
 * repair cannot brick the store forever. Live holders make both repair and
 * writers fail closed -- refused, never interleaved.
 */
export const MAINTENANCE_LOCK_FILENAME = "maintenance.lock"

export type MaintenanceLock = { pid: number; takenAt: string }

export function maintenanceLockPath(storeDir: string): string {
  return path.join(storeDir, MAINTENANCE_LOCK_FILENAME)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readMaintenanceLock(storeDir: string): { pid: number; takenAt: string; stale: boolean } | null {
  const lockPath = maintenanceLockPath(storeDir);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; takenAt?: unknown };
    if (typeof parsed.pid !== "number") return null;
    const takenAt = typeof parsed.takenAt === "string" ? parsed.takenAt : "";
    // R12 review P3#4: kill(pid, 0) cannot detect PID reuse -- a recycled
    // PID of an unrelated process would brick every open/write behind a
    // "live" lock with no auto-recovery. An explicit age cap bounds that:
    // a repair must never run longer than MAINTENANCE_LOCK_STALE_MS, so a
    // lock older than that is stale by policy regardless of PID state.
    const takenMs = Date.parse(takenAt);
    const stale = Number.isNaN(takenMs) || Date.now() - takenMs > MAINTENANCE_LOCK_STALE_MS;
    return { pid: parsed.pid, takenAt, stale };
  } catch {
    return null;
  }
}

/** A repair must never take this long; an older lock is stale by policy. */
export const MAINTENANCE_LOCK_STALE_MS = 60 * 60 * 1000;

function lockBlocks(lock: { pid: number; stale: boolean }): boolean {
  return processAlive(lock.pid) && !lock.stale;
}

/**
 * Refusal check for openers and writers: throws when a live process holds
 * the maintenance lock. A lock whose PID no longer exists is stale garbage
 * and must not block the store.
 */
export function assertNotUnderMaintenance(storeDir: string): void {
  const lock = readMaintenanceLock(storeDir);
  if (lock && lockBlocks(lock)) {
    throw new Error(`Store is under maintenance (repair) by pid ${lock.pid}: ${maintenanceLockPath(storeDir)}; refused to interleave an open/write.`);
  }
}

/**
 * Acquires the store-wide maintenance lock or throws. Steals a stale lock
 * (dead holder PID or lock older than the age cap); refuses a lock held by
 * a live process. Acquisition loops the exclusive-create attempt instead of
 * overwriting on EEXIST -- a plain overwrite raced a third process past its
 * own read and could silently replace a live holder's lock.
 */
export function acquireMaintenanceLock(storeDir: string): { release: () => void } {
  const lockPath = maintenanceLockPath(storeDir);
  const payload = JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() });
  fs.mkdirSync(storeDir, { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
    const existing = readMaintenanceLock(storeDir);
    if (existing && lockBlocks(existing)) {
      throw new Error(`Cannot start repair: store is already under maintenance by pid ${existing.pid}.`);
    }
    if (existing) {
      fs.rmSync(lockPath, { force: true });
    }
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      acquired = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      // Lost the create race; loop back and re-check the (new) holder.
    }
  }
  if (!acquired) {
    throw new Error(`Cannot start repair: ${lockPath} acquisition raced repeatedly; refusing to overwrite.`);
  }
  return {
    release: () => {
      try {
        const current = readMaintenanceLock(storeDir);
        if (current && current.pid !== process.pid) return; // never delete someone else's lock
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* releasing must never mask the repair result */
      }
    }
  };
}
