# ADR 0004: Cutover refuses lossy imports; detail-file intent wins reconciliation

Status: accepted (promoted from T-066 evidence, 2026-09-04)

## Context

ADR 0003 established `plansAuthority: markdown|store` and the one-commit
cutover. The first real cutover attempt on this repository exposed that the
import path could destroy authored planning data silently:

- An out-of-enum value (`workload: Medium`) was dropped with no signal at all.
- Detail-file `prerequisites` that disagreed with the board `dependsOn` were
  reported as warnings, while the cutover's own regeneration would delete the
  losing side. A warning whose consequence is deletion is not a warning.

The cutover was reverted on purpose (`ec032f9` checkpoint restored) and the
gate's refusal behavior became the fix.

## Decision

1. The parser records out-of-representable values as `droppedFields` instead of
   discarding them; import raises `unrepresentable-field-value` as an error.
2. Cutover (both dry-run preview and `import --commit`) fails closed on
   `prerequisites-dependson-mismatch`. Plain `mapctx validate` keeps it a
   warning -- the asymmetry is the point: a read-only check may warn, an
   authority transfer may not proceed through a known disagreement.
3. When board and detail file disagree, reconciliation is an explicit human
   choice. In the T-066 reconciliation, detail-file intent won for epic
   dependencies (E-010/E-011 -> [E-009], E-012 -> [E-010, E-011]) and
   `workload: Medium` mapped to the intended `Normal` rather than being
   dropped. Neither side was silently rewritten.

## Consequences

- A cutover commit can only contain a board that fully agreed with its detail
  files. Post-cutover drift is therefore always an event-log story, never an
  import artifact.
- Out-of-enum values surface as errors at import time, which is where they can
  be fixed cheaply in Markdown.
- The failure mode "validate is green, cutover deletes data" is structurally
  closed; the first real cutover (`441a1c3`) succeeded only after the four
  divergences were reconciled explicitly.

Supersedes nothing; complements ADR 0003 "Authority and cutover".
