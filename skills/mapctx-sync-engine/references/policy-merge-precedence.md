# Merge and Sync Policy

Use this precedence policy unless the user explicitly asks for a different policy.

## Field Precedence

- Remote wins: `status`, labels (`priority`, `workload`, `tags`), `milestone`.
- Local wins: `detail`, `defaultExpanded`.
- `externalId` is the stable mapping key and should remain consistent once linked.

## Safety Rules

- Pull before push in active session.
- Do not delete tasks unless user explicitly requests destructive mode.
- Do not use `--force` unless user explicitly asks for force behavior.

## Output Expectation

When reporting sync actions, include:

- Current sync state
- Commands executed
- High-level fields changed
- Conflicts and chosen resolution
- Recommended next step
