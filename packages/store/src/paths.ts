/**
 * The ONE definition of how this store compares repository paths.
 *
 * It lived inside violations.ts, where claim-violation detection normalizes
 * every path it records. T-131's redaction advisory then had to compare a
 * receipt's RAW `changedFiles` strings against those already-normalized
 * violation paths, and silently matched nothing whenever the two forms
 * differed -- so the advisory named the wrong derived copy and a secret
 * survived with the operator following the instructions (review ALTO-3).
 *
 * Hence this module rather than a second copy: two implementations of path
 * equality are two chances to disagree, and the first disagreement already
 * cost a leak. Anything that needs to decide "are these the same path?" imports
 * it from here.
 */

/** Windows separators to POSIX, no leading `./`, no doubled or trailing slash. */
export function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/")
  return path.length > 1 ? path.replace(/\/$/, "") : path
}
