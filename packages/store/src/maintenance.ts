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

export function readMaintenanceLock(storeDir: string): { pid: number; takenAt: string } | null {
  const lockPath = maintenanceLockPath(storeDir);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; takenAt?: unknown };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, takenAt: typeof parsed.takenAt === "string" ? parsed.takenAt : "" };
  } catch {
    return null;
  }
}

/**
 * Refusal check for openers and writers: throws when a live process holds
 * the maintenance lock. A lock whose PID no longer exists is stale garbage
 * and must not block the store.
 */
export function assertNotUnderMaintenance(storeDir: string): void {
  const lock = readMaintenanceLock(storeDir);
  if (lock && processAlive(lock.pid)) {
    throw new Error(`Store is under maintenance (repair) by pid ${lock.pid}: ${maintenanceLockPath(storeDir)}; refused to interleave an open/write.`);
  }
}

/**
 * Acquires the store-wide maintenance lock or throws. Steals a stale lock
 * left by a dead process; refuses a lock held by a live process.
 */
export function acquireMaintenanceLock(storeDir: string): { release: () => void } {
  const lockPath = maintenanceLockPath(storeDir);
  const existing = readMaintenanceLock(storeDir);
  if (existing && processAlive(existing.pid)) {
    throw new Error(`Cannot start repair: store is already under maintenance by pid ${existing.pid}.`);
  }
  const payload = JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() });
  fs.mkdirSync(storeDir, { recursive: true });
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      // The lock appeared after our check; re-read and refuse on a live holder.
      const raced = readMaintenanceLock(storeDir);
      if (raced && processAlive(raced.pid)) {
        throw new Error(`Cannot start repair: store is already under maintenance by pid ${raced.pid}.`);
      }
      fs.writeFileSync(lockPath, payload);
    } else {
      throw error;
    }
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
