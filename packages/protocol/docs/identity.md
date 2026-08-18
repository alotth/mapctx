# Identity scheme

MapCtx identity is local and stable. External systems attach through `ExternalRef`.
No external id becomes the MapCtx primary key.

## Worked example

One planning task, one Traycer epic, one Traycer artifact, one GitHub issue:

| System | Kind | Key | URI |
|---|---|---|---|
| MapCtx | task | `T-048` | `mapctx://task/T-048` |
| MapCtx | epic | `E-009` | `mapctx://epic/E-009` |
| Traycer | epic | `e8873251-f6f0-490d-be16-8e5655300237` | `traycer://epic/e8873251-f6f0-490d-be16-8e5655300237` |
| Traycer | artifact | `mapctx-vnext-t049-external-store-tech-plan` | `traycer://epic/e8873251-f6f0-490d-be16-8e5655300237/artifact/mapctx-vnext-t049-external-store-tech-plan` |
| GitHub | issue | `42` | `https://github.com/alotth/mapctx/issues/42` |

`ExternalRef` rows for this example live in the v1 golden fixture
`ExternalRef.json` plus the three sibling refs in `src/fixtures.ts`.

```text
T-048  ── ExternalRef(provider=traycer, entityKind=artifact)
       ── ExternalRef(provider=github,  entityKind=issue)
E-009  ── ExternalRef(provider=traycer, entityKind=epic)
```

## Rules

- MapCtx `taskId` / `epicId` never change on import, sync, or adapter rewrite.
- Traycer ticket status 0/1/2 maps only to `executionState`.
- GitHub issue number is a projection, not identity.
- A missing external system is a missing `ExternalRef`, not a missing task.
- Event identity is `(nodeId, sequence)`. Global autoincrement is forbidden.
