import * as fs from 'fs';
import * as path from 'path';
import { SyncConfig, SyncOptions } from './types';
import {
  getAllowedStatuses,
  getCompletionStatuses,
  normalizeStatus,
  normalizeStatusMap,
  validateStatusConfig
} from './statuses';

export function loadConfig(options: SyncOptions = {}): { config: SyncConfig; configPath: string } {
  const cwd = process.cwd();
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : path.resolve(cwd, 'kanban-sync-engine.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Create kanban-sync-engine.config.json from kanban-sync-engine/kanban-sync-engine.config.example.json.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as SyncConfig;

  if (!parsed.owner || !parsed.repo) {
    throw new Error('Config must include owner and repo.');
  }
  if (!parsed.tasksFile) {
    parsed.tasksFile = './TASKS.md';
  }
  if (!parsed.statusMap) {
    throw new Error('Config must include statusMap.');
  }

  parsed.statusMap = normalizeStatusMap(parsed.statusMap);
  parsed.allowedStatuses = getAllowedStatuses(parsed);
  parsed.completionStatuses = getCompletionStatuses(parsed);

  if (parsed.bootstrap?.defaultStatusForImportedIssues) {
    parsed.bootstrap.defaultStatusForImportedIssues = normalizeStatus(parsed.bootstrap.defaultStatusForImportedIssues);
  }

  validateStatusConfig(parsed);

  return { config: parsed, configPath };
}
