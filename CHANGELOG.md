## [1.0.2] (2025-06-04)

### Features

* **fix:** Support CRLF line endings


## [1.1.0] (2025-06-16)


### Features

* **feature:** Add enable/disable file listener command for edit multiple files @ssebs ([#4](https://github.com/holooooo/markdown-kanban/pull/4))

## [1.1.1] (2025-06-23)

### Features

* **feature:** Allow to show/hide filter section
* **feature:** Auto save edited files

## [1.2.0] (2025-07-01)

### Features

* **feature:** Add workload support (Easy, Normal, Hard, Extreme) @ssebs ([#13](https://github.com/holooooo/markdown-kanban/issues/10))
* **feature:** Add steps support
* **feature:** Add tag autocomplete with prefix matching for existing tags @ssebs ([#9](https://github.com/holooooo/markdown-kanban/issues/9))

### refactor

* **refactor:** Separate html code @ssebs ([#12](https://github.com/holooooo/markdown-kanban/pull/12))


## [1.2.1] (2025-07-02)

### Fixes

* **fix:** Fix the webview.html not included in the extension package

## [1.2.2] (2025-07-03)

### Features

* **feature:** Add defaultExpanded support for task @ssebs ([#13](https://github.com/holooooo/markdown-kanban/issues/13))
* **feature:** Add support for header format
* **feature:** Optimize task and step dragging experience for task @ssebs ([#14](https://github.com/holooooo/markdown-kanban/issues/14))


## [1.2.3] (2025-07-05)

### Features

* **feature:** Add setting for task header format


## [1.3.0] (2025-07-05)

* **feature:** Add column archive support


## [1.3.1] (2025-07-06)

### Chore

* **chore:** shorten command name to "Kanban"

## mapctx CLI — [0.4.0] (Unreleased)

### Breaking (public contract): refusals leave on stderr

A refused `mapctx` command no longer prints its structured refusal to stdout.
It exits non-zero and leaves **stdout empty**; with `--json` the refusal is the
**first line of stderr** as one line of compact JSON, followed by the human
`Error: ...` line. Without `--json` only the `Error:` line is printed, so a
holder's lease token is not sprayed across a terminal.

Affected: `task move/update/create/start/claim/renew/release`,
`dispatch create`, `dispatch receipt`, `task acceptance revise/approve/unapprove`,
`acceptance import --commit`, `redact`, `export`, `task finish`.

**Gate reports are unchanged** and still print to stdout even when they exit
non-zero, because the document is the deliverable: `mapctx validate`,
`mapctx import --dry-run`, `mapctx store repair`.

Migration: read stderr's first line (or split stderr on `"\nError:"`) instead
of stdout. Check the exit code first, as before. No consumer in this repository
depended on the old channel.

### Features

* **feature:** `mapctx --help` prints an "Enumerated values" table for every
  enumerated flag, with the schema-derived rows marked, plus sections on prose
  ownership and output channels
* **feature:** `mapctx validate --task <id,...>` filters issues by task,
  `--baseline <file>` fails only on an issue the board did not already have, and
  `--write-baseline <file>` records the current run
* **feature:** `externalLinks` is editable through `mapctx task update --set`,
  validated as `https://host/...` (http too) or `provider:entity:id`
* **feature:** list-valued `--set` fields and `--tags`/`--domains`/`--depends-on`/
  `--blocking` accept a bare comma list or a JSON array, and refuse a bracketed
  guess instead of storing the brackets as part of the values

### Fixes

* **fix:** the `task update` unknown-field refusal names both the task and the
  `detail.*` field groups and redirects a field used on the wrong side
* **fix:** a flag written without its value is refused instead of swallowing the
  next argument (`--actor --json` used to journal an event attributed to
  `"--json"` in the append-only log). The test is pertinence, not shape, so a
  value that merely looks flag-ish (`--title "--foo is a flag"`) still works
* **feature:** `--flag=value` is accepted for value-taking flags, which is how
  you pass a value that is itself a flag name (`--query=--json`)
* **feature:** `mapctx task finish <id> --no-snapshot` applies the canonical
  done gate without regenerating TASKS.md or tasks/*.md and without journaling
  a checkpoint — for a shared checkout where rewriting every mirror would mix
  generated files into uncommitted work. The default still publishes; the
  success result carries `snapshot: "published" | "skipped"` and omits
  `checkpoint` when skipped
* **fix:** an acceptance refusal from either closing path (`task finish` and
  `task move --status done`, which have always shared the gate) now names the
  command that closes a task and mentions `--no-snapshot`
* **fix:** `externalLinks` refuses userinfo credentials (`https://user:pass@...`),
  caps each link at 2048 characters, and matches the `scheme:word:rest` provider
  form case-insensitively
* **fix:** a missing `--expect-revision` refusal reports the revision the store
  currently holds
* **fix:** list elements may not contain a comma, and a `{...}` group split
  across a comma is refused: the generated snapshots cannot represent either,
  and the resulting drift did not converge
