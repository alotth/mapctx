# OpenCode session auto-sync plugin

This project uses an OpenCode plugin (not a Cursor/Claude hook folder) to run sync on session start.

Plugin file:

- `./mapcs-session-sync.js`

Behavior on `session.created`:

1. Run `mapcs status`
2. Run `mapcs pull`
3. Run `mapcs status` again

It uses:

- CLI: `packages/sync-engine/dist/cli.js`
- Config: `sync.config.json`
- Tasks file: `TASKS.md`

Environment toggles:

- `MAPCS_AUTO_PULL=0` runs only `status` (skips `pull`)

Failure behavior:

- Errors are logged through `client.app.log`
- Startup is not blocked when sync fails
