/**
 * T-126 (E-017 R5): auditable redaction of sensitive evidence.
 *
 * WHY THIS EXISTS
 * An agent stored production identifiers (a shift number, a customer context
 * id) as acceptance approval evidence. `unapprove` clears the projection but
 * the plaintext survives in the journal entry (`events/<nodeId>/<seq>.json`)
 * and in `event_log.payload_json` forever, because an event is an immutable
 * historical fact. A repo under LGPD/GDPR needs a supported way to destroy
 * that content without destroying the audit trail -- and without handing
 * anyone a way to quietly rewrite history under the cover of "redaction".
 *
 * WHAT IS REDACTABLE (v1)
 * Evidence FIELDS of specific event types only -- never arbitrary payloads,
 * never structural facts (ids, states, timestamps, hashes). See
 * REDACTABLE_ROOTS. Only string leaves are replaced, and they are replaced by
 * a string sentinel, so every payload stays schema-valid and every projection
 * keeps its column types. Container keys survive (`evidence.shift` stays a
 * key); only the VALUE is destroyed, which is the right granularity: the key
 * is the audit label, the value is the identifier.
 *
 * WHO MAY REDACT
 * Any CLI actor, with `--reason` and `--actor` both required. Dry-run is the
 * default; `--commit` applies. There is no approval instrument in v1: the
 * deterrent is that the act itself is journaled, attributed and permanent.
 *
 * HOW INTEGRITY SURVIVES
 * Two independent artifacts must agree, and neither alone is accepted:
 *   1. the target journal entry declares `redactions[]` (outside `payload`,
 *      so `payloadSha256` keeps describing the real payload bytes and the
 *      existing self-consistency check in readJournalEntry is untouched);
 *   2. a matching `evidence.redacted` event exists, recording the target, the
 *      field paths, the reason, the actor, and a HASH CHAIN over the payload:
 *      priorPayloadSha256 -> redactedPayloadSha256.
 * Repair rebuilds the chain across every redaction of a target: link n's
 * prior hash must equal link n-1's result, and the last result must equal the
 * entry's current payloadSha256. A redacted entry with no redaction event is
 * refused. A redaction event whose target does not hash to a declared state
 * is refused. Tampering that merely edits a payload is still caught by the
 * pre-existing payload hash check. Redaction therefore adds no new way to
 * forge history; it only adds new ways to refuse.
 *
 * Only WHOLE-PAYLOAD hashes are preserved, never per-field ones. A sha256 of
 * a six-digit shift number is brute-forceable in milliseconds, so a field
 * hash would re-leak exactly what was removed. The original payload hash is
 * high-entropy (it covers ids, UUIDs and timestamps) and is a real integrity
 * witness: whoever holds the original payload can still prove it was that
 * payload.
 *
 * REPAIR / ATTESTATION INTERPLAY
 * Repair replays the journal, so it must tolerate redacted entries and still
 * refuse tampering -- that is verifyRedactions below, called before the temp
 * database is built. Attested DB-only nodes (T-119) pin `payload_json`
 * byte-exact outside the database; redacting such a row would make every
 * later repair fail closed against its own attestation, so redaction REFUSES
 * on an attested node and says to re-attest instead.
 *
 * CRASH-SAFETY ORDERING
 * The existing discipline is journal-fsync-then-SQLite-COMMIT. Redaction
 * mutates an ALREADY published entry, so it cannot be one atomic step. The
 * order is deliberate:
 *   1. COMMIT the `evidence.redacted` event (its own journal entry is fsynced
 *      before the commit, by the normal append path) together with the
 *      event_log rewrite and the projection scrub -- one SQLite transaction.
 *   2. only then rewrite the target journal file in place (atomic rename).
 *   3. then checkpoint + VACUUM so the plaintext leaves the database file.
 * A crash between 1 and 2 leaves "event committed, journal still plaintext".
 * That state is FORWARD-RECOVERABLE: the event carries the field paths, so
 * the next open (or repair) re-applies the rewrite idempotently. The reverse
 * order would instead leave "content already destroyed, no event explaining
 * it" -- unrecoverable by construction, since the content is gone. Steps 2
 * and 3 are idempotent and safe to repeat.
 *
 * Redaction does NOT take the maintenance lock. It never replaces the
 * database file, concurrent appenders only add NEW sequences (they cannot
 * touch an older entry), and the SQLite write transaction serializes the
 * indexed state. A racing `store repair` is handled by the same window logic:
 * it either sees the plaintext with no event (nothing happened) or heals the
 * pending rewrite itself.
 *
 * HONEST LIMITS
 * Redaction destroys the content this store can address: the journal entry,
 * the event_log row, the derived projections, and (via VACUUM) the freed
 * database pages. It cannot reach filesystem free blocks, snapshots, external
 * backups, exported checkpoints already committed to git, or copies another
 * tool made. It is an auditable store operation, not media sanitization.
 */

import type { DatabaseSync } from "node:sqlite"
import { canonicalJson } from "@mapctx/protocol"
import type { EventLogEntry, RedactionMarker } from "@mapctx/protocol"
import { loadNodeAttestations } from "./attestation"
import { payloadSha256, readJournalEntry, rewriteJournalEntrySync } from "./journal"
import { listRedactions } from "./projections"
// Type-only: store-handle imports reconcilePendingRedactions from here, so a
// value import would close a runtime require cycle. redactEvidence takes an
// already-open handle instead of opening one itself.
import type { StoreHandle } from "./store-handle"

export const REDACTION_EVENT_TYPE = "evidence.redacted"

/**
 * The value a redacted string leaf becomes. A reserved sentinel rather than
 * an empty string: a reader must be able to tell "deliberately destroyed"
 * from "was always blank", and the entry-level declaration (not a scan for
 * this string) is what detection actually relies on.
 */
export const REDACTED_SENTINEL = "mapctx:redacted"

/**
 * Per-event-type redactable roots. A requested path must be one of these or
 * live under one. Everything else -- ids, states, revisions, timestamps,
 * hashes, dependency structure -- is a structural fact that redaction must
 * never be able to rewrite.
 *
 * `history.evidence-recorded` carries only `repoRoot`/`repoOrigin` here, not
 * `signals`: signals are a closed allowlisted vocabulary (history.ts refuses
 * anything else), so they cannot hold free text to leak, and replacing one
 * with a sentinel would corrupt a controlled vocabulary for no privacy gain.
 * The free-text members of that record are the repo path and origin URL,
 * which is what this allows.
 */
export const REDACTABLE_ROOTS: Readonly<Record<string, readonly string[]>> = {
  "acceptance.approved": ["evidence"],
  "run.receipt-recorded": ["receipt.evidence"],
  "history.evidence-recorded": ["evidence.repoRoot", "evidence.repoOrigin"]
}

/**
 * Within a redactable root, which LEAF NAMES may actually be destroyed.
 * Absent means "every string leaf under the root" -- correct for
 * acceptance.approved, whose evidence is a flat label -> value map where the
 * values are the whole payload of interest.
 *
 * `run.receipt-recorded` needs the filter: receipt.evidence is an
 * ArtifactRef[], so a naive leaf walk would also hit `artifactId` (a UUID),
 * `ownerKind` and `kind` (closed enums) and `ownerId` (the structural link to
 * the owning task). Replacing those with a sentinel would leave a RunReceipt
 * that no longer satisfies its own schema and an artifact reference pointing
 * nowhere, for no privacy gain. The genuinely free-text members -- where a
 * secret actually lands -- are the location fields.
 */
const REDACTABLE_LEAVES: Readonly<Record<string, readonly string[] | undefined>> = {
  "run.receipt-recorded": ["uri", "promotedPath"]
}

function leafIsRedactable(eventType: string, leafPath: string): boolean {
  const allowed = REDACTABLE_LEAVES[eventType]
  if (!allowed) return true
  const segments = leafPath.split(".")
  return allowed.includes(segments[segments.length - 1])
}

export type RedactionTarget = { nodeId: string; sequence: number }

export type RedactionFieldPreview = {
  fieldPath: string;
  /** Masked: at most the first two characters, never the whole value. */
  preview: string;
  length: number;
};

export type RedactionPlan = {
  target: RedactionTarget & { eventType: string; occurredAt: string; actor: string };
  requestedFieldPath: string;
  /** Leaf paths whose content this redaction destroys. */
  fieldPaths: string[];
  /** Leaf paths under the request that were already redacted earlier. */
  alreadyRedacted: string[];
  previews: RedactionFieldPreview[];
  priorPayloadSha256: string;
  redactedPayloadSha256: string;
};

export type RedactionRefusal = {
  ok: false;
  reason: "unknown-event" | "corrupt-event" | "not-redactable" | "nothing-to-redact" | "attested-node" | "invalid-request" | "drifted";
  message: string;
};

export type RedactionDryRunResult = { ok: true; mode: "dry-run"; plan: RedactionPlan };

export type RedactionCommitResult = {
  ok: true;
  mode: "commit";
  plan: RedactionPlan;
  redactionEvent: RedactionTarget;
  journalPath: string;
  /** False only when the post-commit space reclaim failed; the redaction itself still landed. */
  reclaimed: boolean;
  reclaimWarning?: string;
};

export type RedactionResult = RedactionDryRunResult | RedactionCommitResult | RedactionRefusal

// ---- payload path mechanics ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPath(payload: unknown, segments: string[]): { found: false } | { found: true; value: unknown } {
  let cursor: unknown = payload
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return { found: false }
      cursor = cursor[index]
      continue
    }
    if (!isPlainObject(cursor) || !(segment in cursor)) return { found: false }
    cursor = cursor[segment]
  }
  return { found: true, value: cursor }
}

/** Every string leaf under `value`, as paths relative to `prefix`. */
function stringLeafPaths(value: unknown, prefix: string): string[] {
  if (typeof value === "string") return [prefix]
  if (Array.isArray(value)) return value.flatMap((item, index) => stringLeafPaths(item, `${prefix}.${index}`))
  if (isPlainObject(value)) return Object.keys(value).sort().flatMap(key => stringLeafPaths(value[key], `${prefix}.${key}`))
  return []
}

/**
 * Structural clone with the named leaves replaced by the sentinel. Never
 * mutates the input: the caller still needs the original to scrub the
 * projections that were derived from it.
 */
export function applyRedactionToPayload(payload: Record<string, unknown>, fieldPaths: readonly string[]): Record<string, unknown> {
  const next = structuredClone(payload) as Record<string, unknown>
  for (const fieldPath of fieldPaths) {
    const segments = fieldPath.split(".")
    const parentSegments = segments.slice(0, -1)
    const leaf = segments[segments.length - 1]
    const parent = readPath(next, parentSegments)
    if (!parent.found) throw new Error(`Cannot redact ${fieldPath}: path does not exist`)
    if (Array.isArray(parent.value)) {
      const index = Number(leaf)
      if (!Number.isInteger(index) || index < 0 || index >= parent.value.length) throw new Error(`Cannot redact ${fieldPath}: index out of range`)
      if (typeof parent.value[index] !== "string") throw new Error(`Cannot redact ${fieldPath}: not a string leaf`)
      parent.value[index] = REDACTED_SENTINEL
      continue
    }
    if (!isPlainObject(parent.value)) throw new Error(`Cannot redact ${fieldPath}: parent is not a container`)
    if (typeof parent.value[leaf] !== "string") throw new Error(`Cannot redact ${fieldPath}: not a string leaf`)
    parent.value[leaf] = REDACTED_SENTINEL
  }
  return next
}

function maskedPreview(value: string): RedactionFieldPreview["preview"] {
  if (value.length <= 2) return "…"
  return `${value.slice(0, 2)}…`
}

/** True when the request names an allowlisted root or a path beneath one. */
export function redactableRootFor(eventType: string, fieldPath: string): string | undefined {
  return REDACTABLE_ROOTS[eventType]?.find(root => fieldPath === root || fieldPath.startsWith(`${root}.`))
}

// ---- planning ----

export function planRedaction(storeDir: string, options: { target: RedactionTarget; fieldPath: string }): RedactionPlan | RedactionRefusal {
  const read = readJournalEntry(storeDir, options.target.nodeId, options.target.sequence)
  if (read.status === "missing") {
    return { ok: false, reason: "unknown-event", message: `No journal entry at ${options.target.nodeId}/${options.target.sequence}.` }
  }
  if (read.status === "corrupt") {
    return { ok: false, reason: "corrupt-event", message: `Journal entry ${options.target.nodeId}/${options.target.sequence} is corrupt (${read.reason}); run "mapctx store repair" before redacting.` }
  }
  const entry = read.entry
  if (entry.eventType === REDACTION_EVENT_TYPE) {
    return { ok: false, reason: "not-redactable", message: "A redaction event is the audit record itself and can never be redacted." }
  }
  if (!REDACTABLE_ROOTS[entry.eventType]) {
    return {
      ok: false,
      reason: "not-redactable",
      message: `Event type "${entry.eventType}" has no redactable fields. Redactable: ${Object.entries(REDACTABLE_ROOTS).map(([type, roots]) => `${type} (${roots.join(", ")})`).join("; ")}.`
    }
  }
  const root = redactableRootFor(entry.eventType, options.fieldPath)
  if (!root) {
    return {
      ok: false,
      reason: "not-redactable",
      message: `Field "${options.fieldPath}" is not redactable on ${entry.eventType}; allowed roots: ${REDACTABLE_ROOTS[entry.eventType].join(", ")}. Structural facts (ids, states, timestamps, hashes) are never redactable.`
    }
  }
  if (loadNodeAttestations(storeDir).has(entry.nodeId)) {
    return {
      ok: false,
      reason: "attested-node",
      message: `Node ${entry.nodeId} is covered by a T-119 attestation, which pins its event rows byte-exact; redacting it would make every later repair fail against that attestation. Re-attest the node (mapctx store attest-orphan) before redacting.`
    }
  }

  const located = readPath(entry.payload, options.fieldPath.split("."))
  if (!located.found) {
    return { ok: false, reason: "nothing-to-redact", message: `Field "${options.fieldPath}" is absent from ${entry.nodeId}/${entry.sequence}.` }
  }
  const allLeaves = stringLeafPaths(located.value, options.fieldPath)
  if (allLeaves.length === 0) {
    return { ok: false, reason: "nothing-to-redact", message: `Field "${options.fieldPath}" holds no string content to redact (null, empty container, or non-string value).` }
  }
  const leaves = allLeaves.filter(leaf => leafIsRedactable(entry.eventType, leaf))
  if (leaves.length === 0) {
    return {
      ok: false,
      reason: "not-redactable",
      message: `Nothing under "${options.fieldPath}" is redactable on ${entry.eventType}: only the free-text members ${(REDACTABLE_LEAVES[entry.eventType] ?? []).map(name => `"${name}"`).join(", ")} may be destroyed. Identifiers, owner links and closed enums are structural facts.`
    }
  }
  const alreadyRedacted: string[] = []
  const fieldPaths: string[] = []
  const previews: RedactionFieldPreview[] = []
  for (const leaf of leaves) {
    const value = readPath(entry.payload, leaf.split("."))
    const text = value.found ? (value.value as string) : ""
    if (text === REDACTED_SENTINEL) { alreadyRedacted.push(leaf); continue }
    fieldPaths.push(leaf)
    previews.push({ fieldPath: leaf, preview: maskedPreview(text), length: text.length })
  }
  if (fieldPaths.length === 0) {
    return { ok: false, reason: "nothing-to-redact", message: `Every string leaf under "${options.fieldPath}" is already redacted.` }
  }

  const redactedPayload = applyRedactionToPayload(entry.payload, fieldPaths)
  return {
    target: { nodeId: entry.nodeId, sequence: entry.sequence, eventType: entry.eventType, occurredAt: entry.occurredAt, actor: entry.actor },
    requestedFieldPath: options.fieldPath,
    fieldPaths,
    alreadyRedacted,
    previews,
    priorPayloadSha256: entry.payloadSha256,
    redactedPayloadSha256: payloadSha256(redactedPayload)
  }
}

// ---- projection scrub ----

/**
 * Removes the plaintext from the rows that were DERIVED from the target
 * event. Every update is conditional on the row still holding exactly the
 * bytes this event produced: a criterion that was unapproved (evidence
 * nulled) or re-approved with different evidence must not be clobbered by a
 * redaction of the older approval. Replay needs none of this -- it rebuilds
 * projections from the already-redacted journal -- so this runs only on the
 * live path, where the original values are still in hand.
 */
function scrubDerivedProjections(db: DatabaseSync, eventType: string, original: Record<string, unknown>, redacted: Record<string, unknown>): void {
  if (eventType === "acceptance.approved") {
    const { taskId, revision, criterionId } = original as { taskId: string; revision: number; criterionId: string }
    const row = db.prepare("SELECT evidence_json FROM acceptance_criterion_projection WHERE task_id = ? AND criterion_id = ? AND revision = ?")
      .get(taskId, criterionId, revision) as { evidence_json: string | null } | undefined
    if (!stillHolds(row?.evidence_json, (original as { evidence?: unknown }).evidence)) return
    db.prepare("UPDATE acceptance_criterion_projection SET evidence_json = ? WHERE task_id = ? AND criterion_id = ? AND revision = ?")
      .run(JSON.stringify((redacted as { evidence?: unknown }).evidence ?? null), taskId, criterionId, revision)
    return
  }
  if (eventType === "run.receipt-recorded") {
    const originalReceipt = (original.receipt ?? original) as { dispatchId: string; attempt: number; evidence?: unknown }
    const redactedReceipt = (redacted.receipt ?? redacted) as { evidence?: unknown }
    const row = db.prepare("SELECT receipt_json FROM run_receipt_projection WHERE dispatch_id = ? AND attempt = ?")
      .get(originalReceipt.dispatchId, originalReceipt.attempt) as { receipt_json: string | null } | undefined
    if (!stillHolds(row?.receipt_json, originalReceipt)) return
    db.prepare("UPDATE run_receipt_projection SET evidence_json = ?, receipt_json = ? WHERE dispatch_id = ? AND attempt = ?")
      .run(JSON.stringify(redactedReceipt.evidence ?? []), JSON.stringify(redactedReceipt), originalReceipt.dispatchId, originalReceipt.attempt)
    return
  }
  if (eventType === "history.evidence-recorded") {
    const originalEvidence = (original.evidence ?? {}) as { evidenceId: string; repoRoot?: string | null; repoOrigin?: string | null }
    const redactedEvidence = (redacted.evidence ?? {}) as { repoRoot?: string | null; repoOrigin?: string | null }
    const row = db.prepare("SELECT repo_root, repo_origin FROM history_evidence_projection WHERE evidence_id = ?")
      .get(originalEvidence.evidenceId) as { repo_root: string | null; repo_origin: string | null } | undefined
    if (!row) return
    if (row.repo_root !== (originalEvidence.repoRoot ?? null) || row.repo_origin !== (originalEvidence.repoOrigin ?? null)) return
    db.prepare("UPDATE history_evidence_projection SET repo_root = ?, repo_origin = ? WHERE evidence_id = ?")
      .run(redactedEvidence.repoRoot ?? null, redactedEvidence.repoOrigin ?? null, originalEvidence.evidenceId)
    return
  }
  throw new Error(`No projection scrub defined for redactable event type ${eventType}`)
}

/**
 * Whether a stored JSON column still holds exactly the value this event
 * produced. Compared canonically, NOT byte-for-byte: the projection was
 * written with JSON.stringify in payload-insertion order, while the original
 * we are matching against was re-read from the journal, where canonicalJson
 * sorted the keys. A byte guard silently matches nothing and leaves the
 * plaintext in the database.
 */
function stillHolds(storedJson: string | null | undefined, expected: unknown): boolean {
  if (storedJson === null || storedJson === undefined) return false
  try {
    return canonicalJson(JSON.parse(storedJson)) === canonicalJson(expected)
  } catch {
    return false
  }
}

// ---- commit ----

export type RedactEvidenceOptions = {
  target: RedactionTarget;
  fieldPath: string;
  reason: string;
  actor: string;
  commit: boolean;
  now?: () => Date;
};

export function redactEvidence(handle: StoreHandle, options: RedactEvidenceOptions): RedactionResult {
  if (!options.reason?.trim()) return { ok: false, reason: "invalid-request", message: "redact requires --reason \"<why>\": an unexplained redaction is not auditable." }
  if (!options.actor?.trim()) return { ok: false, reason: "invalid-request", message: "redact requires --actor <name>." }

  const storeDir = handle.storeDir
  const planned = planRedaction(storeDir, { target: options.target, fieldPath: options.fieldPath })
  if ("ok" in planned) return planned
  if (!options.commit) return { ok: true, mode: "dry-run", plan: planned }

  const now = options.now ?? (() => new Date())
  const redactedAt = now().toISOString()
  {
    const applied = handle.runInWriteTransaction(append => {
      // Re-read under the write lock: the plan was built outside it, and a
      // redaction must never apply against an entry that moved underneath.
      const fresh = readJournalEntry(storeDir, planned.target.nodeId, planned.target.sequence)
      if (fresh.status !== "ok" || fresh.entry.payloadSha256 !== planned.priorPayloadSha256) {
        return {
          ok: false as const,
          reason: "drifted" as const,
          message: `Target ${planned.target.nodeId}/${planned.target.sequence} changed after planning (expected payload ${planned.priorPayloadSha256}); re-plan and retry. Nothing was applied.`
        }
      }
      const originalPayload = fresh.entry.payload
      const redactedPayload = applyRedactionToPayload(originalPayload, planned.fieldPaths)
      const redactedSha = payloadSha256(redactedPayload)
      if (redactedSha !== planned.redactedPayloadSha256) {
        return { ok: false as const, reason: "drifted" as const, message: "Redacted payload hash diverged from the plan; nothing was applied." }
      }

      const event = append({
        eventType: REDACTION_EVENT_TYPE,
        actor: options.actor,
        occurredAt: redactedAt,
        causation: [{ nodeId: planned.target.nodeId, sequence: planned.target.sequence }],
        payload: {
          target: { nodeId: planned.target.nodeId, sequence: planned.target.sequence },
          targetEventType: planned.target.eventType,
          requestedFieldPath: planned.requestedFieldPath,
          fieldPaths: planned.fieldPaths,
          priorPayloadSha256: planned.priorPayloadSha256,
          redactedPayloadSha256: redactedSha,
          reason: options.reason,
          redactedAt
        }
      })

      // The target's indexed row and the rows derived from it, in the SAME
      // transaction as the audit event: either all of it lands or none.
      handle.db.prepare("UPDATE event_log SET payload_json = ?, payload_sha256 = ? WHERE node_id = ? AND sequence = ? AND payload_sha256 = ?")
        .run(JSON.stringify(redactedPayload), redactedSha, planned.target.nodeId, planned.target.sequence, planned.priorPayloadSha256)
      scrubDerivedProjections(handle.db, planned.target.eventType, originalPayload, redactedPayload)

      const marker: RedactionMarker = {
        fieldPaths: planned.fieldPaths,
        reason: options.reason,
        actor: options.actor,
        redactedAt,
        priorPayloadSha256: planned.priorPayloadSha256,
        redactedPayloadSha256: redactedSha,
        redactionEvent: { nodeId: event.nodeId, sequence: event.sequence }
      }
      const redactedEntry: EventLogEntry = {
        ...fresh.entry,
        payload: redactedPayload,
        payloadSha256: redactedSha,
        redactions: [...(fresh.entry.redactions ?? []), marker]
      }
      return { ok: true as const, event, redactedEntry }
    })

    if (!applied.ok) return applied

    // Step 2: only now is the content removed from the journal file. A crash
    // before this point leaves the committed event and the plaintext entry --
    // healed forward by reconcilePendingRedactions on the next open/repair.
    const journalPath = rewriteJournalEntrySync(storeDir, applied.redactedEntry)

    // Step 3: fold the WAL in, rewrite the database file so the pages that
    // held the plaintext are gone, then truncate the WAL the rewrite created.
    let reclaimed = true
    let reclaimWarning: string | undefined
    try {
      handle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      handle.db.exec("VACUUM")
      handle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch (error) {
      reclaimed = false
      reclaimWarning = `Redaction is committed and the journal is rewritten, but reclaiming the database pages failed: ${String(error)}. The plaintext may survive in free pages until "mapctx store repair" or a VACUUM runs.`
    }

    return {
      ok: true,
      mode: "commit",
      plan: planned,
      redactionEvent: { nodeId: applied.event.nodeId, sequence: applied.event.sequence },
      journalPath,
      reclaimed,
      ...(reclaimWarning ? { reclaimWarning } : {})
    }
  }
}

// ---- verification + forward recovery ----

export type RedactionProblem = { nodeId: string; sequence: number; reason: string }

export type RedactionEventFacts = {
  event: RedactionTarget;
  target: RedactionTarget;
  fieldPaths: string[];
  requestedFieldPath: string;
  priorPayloadSha256: string;
  redactedPayloadSha256: string;
  reason: string;
  actor: string;
  redactedAt: string;
};

export function redactionFactsOf(entry: EventLogEntry): RedactionEventFacts {
  const payload = entry.payload as {
    target?: { nodeId?: unknown; sequence?: unknown };
    fieldPaths?: unknown;
    requestedFieldPath?: unknown;
    priorPayloadSha256?: unknown;
    redactedPayloadSha256?: unknown;
    reason?: unknown;
    redactedAt?: unknown;
  }
  const nodeId = payload.target?.nodeId
  const sequence = payload.target?.sequence
  if (typeof nodeId !== "string" || typeof sequence !== "number") {
    throw new Error(`Malformed ${REDACTION_EVENT_TYPE} at ${entry.nodeId}/${entry.sequence}: target is not {nodeId, sequence}`)
  }
  if (!Array.isArray(payload.fieldPaths) || payload.fieldPaths.length === 0 || !payload.fieldPaths.every(item => typeof item === "string")) {
    throw new Error(`Malformed ${REDACTION_EVENT_TYPE} at ${entry.nodeId}/${entry.sequence}: fieldPaths must be a non-empty string array`)
  }
  if (typeof payload.priorPayloadSha256 !== "string" || typeof payload.redactedPayloadSha256 !== "string") {
    throw new Error(`Malformed ${REDACTION_EVENT_TYPE} at ${entry.nodeId}/${entry.sequence}: missing payload hash chain`)
  }
  return {
    event: { nodeId: entry.nodeId, sequence: entry.sequence },
    target: { nodeId, sequence },
    fieldPaths: payload.fieldPaths as string[],
    requestedFieldPath: typeof payload.requestedFieldPath === "string" ? payload.requestedFieldPath : (payload.fieldPaths as string[])[0],
    priorPayloadSha256: payload.priorPayloadSha256,
    redactedPayloadSha256: payload.redactedPayloadSha256,
    reason: typeof payload.reason === "string" ? payload.reason : "",
    actor: entry.actor,
    redactedAt: typeof payload.redactedAt === "string" ? payload.redactedAt : entry.occurredAt
  }
}

function entryKey(nodeId: string, sequence: number): string {
  return `${nodeId}/${sequence}`
}

function markerFor(facts: RedactionEventFacts): RedactionMarker {
  return {
    fieldPaths: facts.fieldPaths,
    reason: facts.reason,
    actor: facts.actor,
    redactedAt: facts.redactedAt,
    priorPayloadSha256: facts.priorPayloadSha256,
    redactedPayloadSha256: facts.redactedPayloadSha256,
    redactionEvent: facts.event
  }
}

export type RedactionVerification = {
  problems: RedactionProblem[];
  /** Targets whose journal file still holds content a committed redaction removed. */
  pending: Array<{ current: EventLogEntry; redacted: EventLogEntry }>;
};

/**
 * Adjudicates one target against every redaction recorded for it. Shared by
 * the exhaustive journal sweep (repair) and the ledger-driven check (open),
 * so both reach the same verdict from different evidence sources.
 */
function verifyTargetChain(target: EventLogEntry | undefined, chain: RedactionEventFacts[]): RedactionVerification {
  const problems: RedactionProblem[] = []
  const pending: RedactionVerification["pending"] = []
  chain.sort((a, b) => a.event.nodeId.localeCompare(b.event.nodeId) || a.event.sequence - b.event.sequence)
  const first = chain[0]
  if (!target) {
    return {
      problems: [{
        nodeId: first.target.nodeId,
        sequence: first.target.sequence,
        reason: `redaction event ${entryKey(first.event.nodeId, first.event.sequence)} names a target that is not in the journal`
      }],
      pending
    }
  }

  // The chain must be continuous: every link starts where the previous one
  // ended, so no redaction can be dropped or reordered without detection.
  for (let index = 1; index < chain.length; index++) {
    if (chain[index].priorPayloadSha256 !== chain[index - 1].redactedPayloadSha256) {
      return {
        problems: [{
          nodeId: target.nodeId,
          sequence: target.sequence,
          reason: `broken redaction chain: ${entryKey(chain[index].event.nodeId, chain[index].event.sequence)} starts from ${chain[index].priorPayloadSha256} but the previous redaction produced ${chain[index - 1].redactedPayloadSha256}`
        }],
        pending
      }
    }
  }

  // Where the entry currently sits on the chain: 0 = untouched original,
  // n = the first n redactions applied. Anything off the chain is tampering.
  const states = [first.priorPayloadSha256, ...chain.map(link => link.redactedPayloadSha256)]
  const position = states.indexOf(target.payloadSha256)
  if (position === -1) {
    return {
      problems: [{
        nodeId: target.nodeId,
        sequence: target.sequence,
        reason: `payload hash ${target.payloadSha256} matches neither the pre-redaction payload (${first.priorPayloadSha256}) nor any redacted state declared by its ${chain.length} redaction event(s); refusing a tampered entry`
      }],
      pending
    }
  }

  const declared = target.redactions ?? []
  const expected = chain.slice(0, position).map(markerFor)
  if (canonicalJson(declared) !== canonicalJson(expected)) {
    return {
      problems: [{
        nodeId: target.nodeId,
        sequence: target.sequence,
        reason: `entry declares ${declared.length} redaction marker(s) that do not match the ${expected.length} applied redaction event(s); refusing rather than guessing which side is authentic`
      }],
      pending
    }
  }

  if (position === chain.length) return { problems, pending } // fully applied

  // Committed redactions this file has not absorbed yet (the crash window
  // between COMMIT and the file rewrite): apply the remaining links forward.
  // Each event carries its field paths, so no original content is needed --
  // and the recomputed hash must land exactly on the last recorded state or
  // the entry is refused rather than quietly rewritten.
  let payload = target.payload
  const markers = [...declared]
  try {
    for (const link of chain.slice(position)) {
      payload = applyRedactionToPayload(payload, link.fieldPaths)
      markers.push(markerFor(link))
    }
  } catch (error) {
    return { problems: [{ nodeId: target.nodeId, sequence: target.sequence, reason: `cannot apply committed redaction: ${(error as Error).message}` }], pending }
  }
  const finalSha = payloadSha256(payload)
  if (finalSha !== chain[chain.length - 1].redactedPayloadSha256) {
    return {
      problems: [{
        nodeId: target.nodeId,
        sequence: target.sequence,
        reason: `applying the committed redaction yields ${finalSha}, not the recorded ${chain[chain.length - 1].redactedPayloadSha256}; refusing a tampered entry`
      }],
      pending
    }
  }
  pending.push({ current: target, redacted: { ...target, payload, payloadSha256: finalSha, redactions: markers } })
  return { problems, pending }
}

/**
 * Validates every redaction against the entries it concerns, and reports the
 * ones whose journal file has not caught up yet (the crash window between the
 * committed event and the file rewrite).
 *
 * Refuses, by name:
 * - a redaction event whose target entry is absent;
 * - a broken hash chain (link n's prior hash is not link n-1's result);
 * - a target whose payload hashes to neither the original nor any declared
 *   redaction state -- i.e. tampering;
 * - a target that is in a redacted state but does not declare it, or declares
 *   markers that disagree with the events;
 * - an entry declaring `redactions[]` with no matching redaction event. This
 *   is the "someone deleted content and forged the marker" case, and it is
 *   exactly what keeps redaction from becoming a tampering channel.
 */
export function verifyRedactions(entries: readonly EventLogEntry[]): RedactionVerification {
  const problems: RedactionProblem[] = []
  const pending: RedactionVerification["pending"] = []
  const byKey = new Map<string, EventLogEntry>()
  for (const entry of entries) byKey.set(entryKey(entry.nodeId, entry.sequence), entry)

  const chains = new Map<string, RedactionEventFacts[]>()
  for (const entry of entries) {
    if (entry.eventType !== REDACTION_EVENT_TYPE) continue
    let facts: RedactionEventFacts
    try {
      facts = redactionFactsOf(entry)
    } catch (error) {
      problems.push({ nodeId: entry.nodeId, sequence: entry.sequence, reason: (error as Error).message })
      continue
    }
    const key = entryKey(facts.target.nodeId, facts.target.sequence)
    const chain = chains.get(key) ?? []
    chain.push(facts)
    chains.set(key, chain)
  }

  for (const [key, chain] of chains) {
    const outcome = verifyTargetChain(byKey.get(key), chain)
    problems.push(...outcome.problems)
    pending.push(...outcome.pending)
  }

  for (const entry of entries) {
    if (!entry.redactions?.length) continue
    if (chains.has(entryKey(entry.nodeId, entry.sequence))) continue
    problems.push({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      reason: `entry declares ${entry.redactions.length} redaction marker(s) but no ${REDACTION_EVENT_TYPE} event exists for it; content was removed without an audit record`
    })
  }

  return { problems, pending }
}

/**
 * Finishes any redaction whose event is committed but whose journal file
 * still holds the content, and returns the rewritten entries. Idempotent, so
 * both `StoreHandle.open` and `repairStore` can call it. Problems are
 * returned, never healed: a tampered entry must reach the caller's refusal
 * path with its exact (nodeId, sequence).
 */
export function reconcilePendingRedactions(storeDir: string, entries: readonly EventLogEntry[]): RedactionVerification & { rewritten: EventLogEntry[] } {
  const verification = verifyRedactions(entries)
  if (verification.problems.length > 0) return { ...verification, rewritten: [] }
  const rewritten: EventLogEntry[] = []
  for (const { redacted } of verification.pending) {
    rewriteJournalEntrySync(storeDir, redacted)
    rewritten.push(redacted)
  }
  return { ...verification, rewritten }
}

/**
 * The same adjudication, driven by the indexed redaction ledger instead of a
 * full journal sweep: it reads only the journal entries a redaction actually
 * names. That is what makes the check affordable on EVERY store open, where
 * re-reading every journal file would not be. The exhaustive sweep stays in
 * repair, which is the path that must also catch an entry carrying forged
 * markers with no event anywhere.
 */
export function verifyRedactionsFromLedger(storeDir: string, db: DatabaseSync): RedactionVerification {
  const problems: RedactionProblem[] = []
  const pending: RedactionVerification["pending"] = []
  const chains = new Map<string, RedactionEventFacts[]>()
  for (const record of listRedactions(db)) {
    const key = entryKey(record.targetNode, record.targetSequence)
    const chain = chains.get(key) ?? []
    chain.push({
      event: { nodeId: record.eventNode, sequence: record.eventSequence },
      target: { nodeId: record.targetNode, sequence: record.targetSequence },
      fieldPaths: record.fieldPaths,
      requestedFieldPath: record.requestedFieldPath,
      priorPayloadSha256: record.priorPayloadSha256,
      redactedPayloadSha256: record.redactedPayloadSha256,
      reason: record.reason,
      actor: record.actor,
      redactedAt: record.redactedAt
    })
    chains.set(key, chain)
  }
  for (const [, chain] of chains) {
    const read = readJournalEntry(storeDir, chain[0].target.nodeId, chain[0].target.sequence)
    if (read.status === "corrupt") {
      problems.push({ nodeId: chain[0].target.nodeId, sequence: chain[0].target.sequence, reason: `redaction target is corrupt: ${read.reason}` })
      continue
    }
    const outcome = verifyTargetChain(read.status === "ok" ? read.entry : undefined, chain)
    problems.push(...outcome.problems)
    pending.push(...outcome.pending)
  }
  return { problems, pending }
}

export function reconcileRedactionsFromLedger(storeDir: string, db: DatabaseSync): RedactionVerification & { rewritten: number } {
  const verification = verifyRedactionsFromLedger(storeDir, db)
  if (verification.problems.length > 0) return { ...verification, rewritten: 0 }
  for (const { redacted } of verification.pending) {
    rewriteJournalEntrySync(storeDir, redacted)
  }
  return { ...verification, rewritten: verification.pending.length }
}

// ---- discovery ----

export type RedactionCandidate = {
  nodeId: string;
  sequence: number;
  eventType: string;
  occurredAt: string;
  actor: string;
  /** Leaf paths that still hold content. */
  redactableFieldPaths: string[];
  /** Leaf paths already destroyed by an earlier redaction. */
  redactedFieldPaths: string[];
  /** Task / dispatch / evidence the event belongs to, for operator orientation. */
  subject: string | null;
};

/**
 * Lists events that carry redactable evidence, WITHOUT echoing any value --
 * an operator has to be able to find the entry to redact without the search
 * itself reprinting the identifier they are trying to destroy.
 */
export function listRedactionCandidates(db: DatabaseSync, options: { taskId?: string } = {}): RedactionCandidate[] {
  const types = Object.keys(REDACTABLE_ROOTS)
  const rows = db.prepare(
    `SELECT node_id, sequence, event_type, occurred_at, actor, payload_json FROM event_log
     WHERE event_type IN (${types.map(() => "?").join(", ")})
     ORDER BY node_id ASC, sequence ASC`
  ).all(...types) as Array<{ node_id: string; sequence: number; event_type: string; occurred_at: string; actor: string; payload_json: string }>

  const candidates: RedactionCandidate[] = []
  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>
    } catch {
      continue
    }
    const redactable: string[] = []
    const redacted: string[] = []
    for (const root of REDACTABLE_ROOTS[row.event_type]) {
      const located = readPath(payload, root.split("."))
      if (!located.found) continue
      for (const leaf of stringLeafPaths(located.value, root)) {
        if (!leafIsRedactable(row.event_type, leaf)) continue
        const value = readPath(payload, leaf.split("."))
        if (value.found && value.value === REDACTED_SENTINEL) redacted.push(leaf)
        else redactable.push(leaf)
      }
    }
    if (redactable.length === 0 && redacted.length === 0) continue
    const subject = subjectOf(row.event_type, payload)
    if (options.taskId && subject !== options.taskId) continue
    candidates.push({
      nodeId: row.node_id,
      sequence: row.sequence,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      actor: row.actor,
      redactableFieldPaths: redactable,
      redactedFieldPaths: redacted,
      subject
    })
  }
  return candidates
}

function subjectOf(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType === "acceptance.approved") return typeof payload.taskId === "string" ? payload.taskId : null
  if (eventType === "history.evidence-recorded") {
    const evidence = payload.evidence as { taskId?: unknown } | undefined
    return typeof evidence?.taskId === "string" ? evidence.taskId : null
  }
  if (eventType === "run.receipt-recorded") {
    const receipt = (payload.receipt ?? payload) as { dispatchId?: unknown }
    return typeof receipt.dispatchId === "string" ? receipt.dispatchId : null
  }
  return null
}
