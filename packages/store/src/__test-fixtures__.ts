/**
 * Small hand-authored golden board matching the real TASKS.md / tasks/<ID>.md
 * format used in this repo, covering the round-trip edge cases the T-049
 * acceptance criteria call out by name: multi-line description, Unicode,
 * an epic with a subtask, and empty optional fields.
 */

export const GOLDEN_TASKS_MD = `# Golden Fixture Board

## Work Domains

- CORE: core engine work
- DOCS: documentation

## Tasks

### [E-100] Épic with subtâsk 🚀

  - id: E-100
  - status: doing
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [epic, unicode]
  - domains: [CORE]
  - dependsOn: []
  - start: 2026-01-01
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-01-02
  - detail: ./tasks/E-100.md

### [T-101] Sübtask with ünicode and empty arrays

  - id: T-101
  - status: backlog
  - type: task
  - parent: E-100
  - subIssueProgress: null
  - priority: null
  - workload: null
  - tags: []
  - domains: []
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: null
  - detail: ./tasks/T-101.md

### [T-102] Multi-line description task

  - id: T-102
  - status: done
  - type: task
  - parent: null
  - subIssueProgress: null
  - priority: low
  - workload: Easy
  - tags: [docs]
  - domains: [DOCS]
  - dependsOn: [T-101]
  - start: 2026-01-03
  - due: 2026-01-10
  - completed: 2026-01-09
  - externalId: null
  - updated: 2026-01-09
  - detail: ./tasks/T-102.md

## Notes

Some trailing note.
`;

export const GOLDEN_DETAIL_E100 = `# E-100

  - role: coordination
  - impact: high
  - estimatedEffort: 2w
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Epic summary line.
  - description: |
      ## Goals

      Coordinate the sübtask below. Contains unicode: café, naïve, 日本語.

      - [ ] not yet done
`;

export const GOLDEN_DETAIL_T101 = `# T-101

  - role: implementation
  - impact: medium
  - estimatedEffort: 3d
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Empty optional fields everywhere.
  - description: |
      Single line description, no headings, no checklists.
`;

export const GOLDEN_DETAIL_T102 = `# T-102

  - role: docs
  - impact: low
  - estimatedEffort: 1d
  - prerequisites: [T-101]
  - blocking: []
  - filesAffected: [docs/readme.md, docs/guide.md]
  - testsRequired: [manual-review]
  - summary: Depends on T-101, has a long multi-line description.
  - description: |
      ## Section One

      Paragraph with **bold** and a blank line above.

      ## Section Two

      - [x] done item
      - [ ] pending item

      Trailing paragraph.
`;

export const GOLDEN_FILES: Record<string, string> = {
  "TASKS.md": GOLDEN_TASKS_MD,
  "tasks/E-100.md": GOLDEN_DETAIL_E100,
  "tasks/T-101.md": GOLDEN_DETAIL_T101,
  "tasks/T-102.md": GOLDEN_DETAIL_T102
};

export const GOLDEN_LEGACY_CONFIG = {
  owner: "octocat",
  repo: "golden-fixture",
  projectId: "PVT_fixture",
  statusFieldId: "PVTSSF_fixture",
  statusMap: {
    backlog: "Backlog",
    "ready-for-do": "Ready for Do",
    doing: "Doing",
    review: "Review",
    done: "Done",
    paused: "Paused"
  },
  tasksFile: "./TASKS.md",
  bootstrap: {
    createMissingDetailFiles: true,
    defaultStatusForImportedIssues: "backlog",
    requireConfirmFlag: false
  }
};
