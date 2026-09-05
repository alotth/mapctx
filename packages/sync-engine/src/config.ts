import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { DEFAULT_GITHUB_SOURCE_MODE, GithubSourceMode, SyncConfig, SyncOptions } from './types';
import { findTasksRoot } from '@mapctx/core/workspace';
import {
  DEFAULT_ALLOWED_STATUSES,
  DEFAULT_COMPLETION_STATUSES,
  getAllowedStatuses,
  getCompletionStatuses,
  normalizeStatus,
  normalizeStatusMap,
  validateStatusConfig
} from './statuses';

const DEFAULT_STATUS_MAP: Record<string, string> = {
  backlog: 'Backlog',
  'ready-for-do': 'Ready for Do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
  paused: 'Paused'
};

function inferRepoFromGitRemote(cwd: string): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const match = remote.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (!match) return null;

    return {
      owner: match[1],
      repo: match[2]
    };
  } catch {
    return null;
  }
}

export function initConfigCommand(options: SyncOptions = {}): { config: SyncConfig; configPath: string } {
  const cwd = process.cwd();
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : path.resolve(cwd, 'mapcs.config.json');

  if (fs.existsSync(configPath) && !options.force) {
    throw new Error(`Config already exists: ${configPath}. Re-run with --force to overwrite.`);
  }

  const inferred = inferRepoFromGitRemote(cwd);
  const fallbackRepo = path.basename(cwd) || 'your-repo';
  const config: SyncConfig = {
    owner: inferred?.owner || 'local',
    repo: inferred?.repo || fallbackRepo,
    tasksFile: options.tasksFileOverride || './TASKS.md',
    allowedStatuses: [...DEFAULT_ALLOWED_STATUSES],
    completionStatuses: [...DEFAULT_COMPLETION_STATUSES],
    statusMap: { ...DEFAULT_STATUS_MAP },
    bootstrap: {
      createMissingDetailFiles: true,
      defaultStatusForImportedIssues: 'backlog',
      requireConfirmFlag: true
    },
    idGeneration: {
      preferredPrefix: 'T'
    },
    remoteWinsFields: [
      'status',
      'tags',
      'priority',
      'workload',
      'milestone'
    ],
    localWinsFields: [
      'detail',
      'defaultExpanded'
    ],
    github: {
      sourceMode: 'projection'
    }
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (inferred) {
    console.log(`Created ${configPath} for ${inferred.owner}/${inferred.repo}`);
  } else {
    console.log(`Created ${configPath}`);
    console.log('This config works for local board commands. Fill in GitHub owner/repo/project fields only before GitHub sync commands.');
  }

  return { config, configPath };
}

function normalizeLoadedConfig(parsed: SyncConfig): SyncConfig {
  if (!parsed.owner || !parsed.repo) {
    throw new Error('Config must include owner and repo.');
  }
  if (!parsed.tasksFile) {
    parsed.tasksFile = './TASKS.md';
  }
  if (!parsed.statusMap) {
    throw new Error('Config must include statusMap.');
  }

  resolveGithubSourceMode(parsed);
  parsed.statusMap = normalizeStatusMap(parsed.statusMap);
  parsed.allowedStatuses = getAllowedStatuses(parsed);
  parsed.completionStatuses = getCompletionStatuses(parsed);

  if (parsed.bootstrap?.defaultStatusForImportedIssues) {
    parsed.bootstrap.defaultStatusForImportedIssues = normalizeStatus(parsed.bootstrap.defaultStatusForImportedIssues);
  }

  if (parsed.idGeneration?.preferredPrefix !== undefined) {
    parsed.idGeneration.preferredPrefix = String(parsed.idGeneration.preferredPrefix).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(parsed.idGeneration.preferredPrefix)) {
      throw new Error('idGeneration.preferredPrefix must match /^[A-Za-z][A-Za-z0-9]*$/.');
    }
  }

  validateStatusConfig(parsed);

  return parsed;
}

/**
 * Resolves and validates github.sourceMode (ADR 0003/0004 authority rules).
 * Absent defaults to `projection`. `canonical` is the future explicit-GitHub
 * authority mode and is not implemented, so it fails closed here — every sync
 * command loads config first, so no code path can silently treat GitHub as
 * canonical.
 */
export function resolveGithubSourceMode(config: SyncConfig): GithubSourceMode {
  const raw = config.github?.sourceMode;
  if (raw === undefined) {
    return DEFAULT_GITHUB_SOURCE_MODE;
  }
  if (raw !== 'projection' && raw !== 'canonical') {
    throw new Error(
      `github.sourceMode must be "projection" or "canonical", got: ${JSON.stringify(raw)}. ` +
      'MapCtx treats GitHub as a projection of local state (ADR 0003/0004); omit the field for the default.'
    );
  }
  if (raw === 'canonical') {
    throw new Error(
      'github.sourceMode "canonical" is not implemented. MapCtx only supports "projection" ' +
      '(one-way export with import explicit). Failing closed instead of silently treating ' +
      'GitHub as the source of truth.'
    );
  }
  return raw;
}

export function loadConfig(options: SyncOptions = {}): { config: SyncConfig; configPath: string } {
  const cwd = process.cwd();
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : path.resolve(cwd, 'mapcs.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Run "mapcs init" or create mapcs.config.json from mapcs.config.example.json.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as SyncConfig;

  return { config: normalizeLoadedConfig(parsed), configPath };
}

export function loadConfigOptionalForBoard(options: SyncOptions = {}): {
  config: SyncConfig;
  configPath: string;
  configExists: boolean;
} {
  const cwd = process.cwd();
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : path.join(findTasksRoot(cwd, 'mapcs.config.json') || cwd, 'mapcs.config.json');

  if (fs.existsSync(configPath)) {
    return { ...loadConfig({ ...options, configPath }), configExists: true };
  }

  const tasksRoot = findTasksRoot(cwd);
  const tasksFilePath = options.tasksFileOverride
    ? path.resolve(cwd, options.tasksFileOverride)
    : tasksRoot
      ? path.join(tasksRoot, 'TASKS.md')
      : path.resolve(cwd, './TASKS.md');
  if (!fs.existsSync(tasksFilePath)) {
    throw new Error(
      `Config not found: ${configPath}. No tasks file found at ${tasksFilePath}. ` +
      'Run "mapcs init" to create mapcs.config.json or pass --tasks-file <path> for read-only validate/plan.'
    );
  }

  const config: SyncConfig = {
    owner: 'local',
    repo: path.basename(cwd) || 'local',
    // Absolute path preserves discovery root when caller runs below repo root.
    tasksFile: tasksFilePath,
    allowedStatuses: [...DEFAULT_ALLOWED_STATUSES],
    completionStatuses: [...DEFAULT_COMPLETION_STATUSES],
    statusMap: { ...DEFAULT_STATUS_MAP }
  };

  return {
    config: normalizeLoadedConfig(config),
    configPath,
    configExists: false
  };
}
