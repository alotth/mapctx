#!/usr/bin/env bash

WORKTREE="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TASKS_FILE="$WORKTREE/TASKS.md"
CONFIG_FILE="$WORKTREE/sync.config.json"
CLI_FILE="$WORKTREE/packages/sync-engine/dist/cli.js"

if [ ! -f "$TASKS_FILE" ] || [ ! -f "$CONFIG_FILE" ] || [ ! -f "$CLI_FILE" ]; then
  exit 0
fi

node "$CLI_FILE" status --config "$CONFIG_FILE" --tasks-file "$TASKS_FILE" >/dev/null 2>&1 || exit 0

if [ "${MAPCS_AUTO_PULL:-1}" = "0" ]; then
  exit 0
fi

node "$CLI_FILE" pull --config "$CONFIG_FILE" --tasks-file "$TASKS_FILE" >/dev/null 2>&1 || exit 0
node "$CLI_FILE" status --config "$CONFIG_FILE" --tasks-file "$TASKS_FILE" >/dev/null 2>&1 || exit 0

exit 0
