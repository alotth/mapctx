/**
 * Constructors for `ProviderResult` and `ProviderError`.
 *
 * They exist so every implementation reports the same shape for the same
 * situation. `retryable` is decided here, once, from the kind — a provider that
 * sets it by hand will eventually disagree with another provider about whether
 * an auth failure is worth retrying.
 */

import type {
  FieldWrite,
  FieldWriteOutcome,
  BatchOutcome,
  Page,
  PageFreshness,
  ProviderError,
  ProviderErrorKind,
  ProviderResult,
  Revision
} from "./types"

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  "rate-limited": true,
  transient: true,
  auth: false,
  "not-found": false,
  unsupported: false,
  conflict: false,
  invalid: false
}

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE[kind]
}

export function ok<T>(value: T): ProviderResult<T> {
  return { ok: true, value }
}

export function err<T = never>(
  kind: ProviderErrorKind,
  message: string,
  extra: Omit<ProviderError, "kind" | "message" | "retryable"> = {}
): ProviderResult<T> {
  return { ok: false, error: { kind, message, retryable: RETRYABLE[kind], ...extra } }
}

/** The refusal a provider owes a caller for something it cannot do. */
export function unsupported<T = never>(capability: string, message?: string): ProviderResult<T> {
  return err<T>("unsupported", message ?? `provider does not support ${capability}`, { capability })
}

/**
 * The refusal a provider owes a caller that passed a precondition it cannot
 * honour. Separate from `unsupported` only in its message: dropping the
 * precondition and succeeding is never an option.
 */
export function preconditionUnsupported<T = never>(): ProviderResult<T> {
  return err<T>("unsupported", "provider has no write precondition; refusing to drop expectedRevision silently", {
    capability: "preconditions.revision"
  })
}

export function freshness(partial: boolean, extra: Partial<PageFreshness> = {}): PageFreshness {
  return {
    fetchedAt: new Date().toISOString(),
    source: "live",
    stale: false,
    partial,
    ...extra
  }
}

/**
 * Build one page from an already-materialised collection.
 *
 * `partial` follows from the cursor rather than being passed in: a page with a
 * next cursor is incomplete, and that is not a judgement call.
 */
export function page<T>(items: T[], nextCursor?: string, extra: Partial<PageFreshness> = {}): Page<T> {
  return {
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    freshness: freshness(nextCursor !== undefined, extra)
  }
}

export function appliedOutcome(write: FieldWrite, revision?: Revision): FieldWriteOutcome {
  return write.value === null || write.value === undefined
    ? { status: "cleared", write, ...(revision === undefined ? {} : { revision }) }
    : { status: "applied", write, ...(revision === undefined ? {} : { revision }) }
}

export function unchangedOutcome(write: FieldWrite, revision?: Revision): FieldWriteOutcome {
  return { status: "unchanged", write, ...(revision === undefined ? {} : { revision }) }
}

export function failedOutcome(write: FieldWrite, error: ProviderError): FieldWriteOutcome {
  return { status: "failed", write, error }
}

/** A write the provider never attempted, because an earlier one failed. */
export function skippedOutcome(write: FieldWrite): FieldWriteOutcome {
  return { status: "skipped", write }
}

/**
 * Summarise a batch.
 *
 * `partiallyApplied` is true whenever something landed AND something did not —
 * including the `unknown` case, where the caller must read back rather than
 * resend. A batch where everything failed is not partially applied; a batch
 * where one write failed and four landed is, and the distinction is what tells
 * a caller whether a resend is safe. A skipped write is neither applied nor
 * failed, so it never makes a batch partial on its own.
 */
export function summariseBatch(outcomes: FieldWriteOutcome[], verified: boolean): BatchOutcome {
  const applied = outcomes.filter((o) => o.status === "applied" || o.status === "cleared" || o.status === "unchanged").length
  const failed = outcomes.filter((o) => o.status === "failed").length
  const unknown = outcomes.filter((o) => o.status === "unknown").length
  const skipped = outcomes.filter((o) => o.status === "skipped").length
  return {
    outcomes,
    applied,
    failed,
    unknown,
    skipped,
    partiallyApplied: applied > 0 && failed + unknown > 0,
    verified
  }
}
