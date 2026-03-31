# Hooks examples

This folder keeps example hooks for environments that support hook files directly (for example Claude Code).

## Claude Code session-start example

1. Copy the script:

```bash
cp hooks/claude-session-start-sync.example.sh hooks/claude-session-start-sync.sh
chmod +x hooks/claude-session-start-sync.sh
```

2. Add this to `.claude/settings.json` (project scope):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/hooks/claude-session-start-sync.sh"
          }
        ]
      }
    ]
  }
}
```

Behavior:

- Runs only when `TASKS.md`, `sync.config.json`, and `packages/sync-engine/dist/cli.js` exist.
- Executes `status`, then `pull`, then `status`.
- If `MAPCS_AUTO_PULL=0`, it skips `pull`.
- Always exits `0`, so Claude startup is not blocked.
