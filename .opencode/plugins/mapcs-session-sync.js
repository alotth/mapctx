const CLI_RELATIVE_PATH = "packages/sync-engine/dist/cli.js";
const CONFIG_RELATIVE_PATH = "sync.config.json";
const TASKS_RELATIVE_PATH = "TASKS.md";

async function log(client, level, message, extra = {}) {
  if (!client?.app?.log) return;
  await client.app.log({
    body: {
      service: "mapcs-session-sync",
      level,
      message,
      extra,
    },
  });
}

async function runMapcs($, cliPath, configPath, tasksPath, command) {
  await $`node ${cliPath} ${command} --config ${configPath} --tasks-file ${tasksPath}`;
}

export const MapcsSessionSyncPlugin = async ({ client, $, worktree }) => {
  return {
    "session.created": async () => {
      const shouldPull = process.env.MAPCS_AUTO_PULL !== "0";
      const cliPath = `${worktree}/${CLI_RELATIVE_PATH}`;
      const configPath = `${worktree}/${CONFIG_RELATIVE_PATH}`;
      const tasksPath = `${worktree}/${TASKS_RELATIVE_PATH}`;

      const hasCli = await Bun.file(cliPath).exists();
      const hasConfig = await Bun.file(configPath).exists();
      const hasTasks = await Bun.file(tasksPath).exists();

      if (!hasCli || !hasConfig || !hasTasks) {
        await log(client, "warn", "Skipping session auto sync: required files missing", {
          hasCli,
          hasConfig,
          hasTasks,
          cliPath,
          configPath,
          tasksPath,
        });
        return;
      }

      try {
        await log(client, "info", "Running mapcs status before auto pull");
        await runMapcs($, cliPath, configPath, tasksPath, "status");

        if (shouldPull) {
          await log(client, "info", "Running mapcs pull on session start");
          await runMapcs($, cliPath, configPath, tasksPath, "pull");
          await runMapcs($, cliPath, configPath, tasksPath, "status");
        } else {
          await log(client, "info", "Skipping pull by MAPCS_AUTO_PULL=0");
        }
      } catch (error) {
        await log(client, "error", "Session auto sync failed", {
          error: String(error),
        });
      }
    },
  };
};
