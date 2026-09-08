import { spawnSync } from 'child_process';
import { GitHubIssue, ProjectIssueItem, ProjectItemDates, ProjectItemStatus, SyncConfig } from './types';

export type GhRunner = (args: string[]) => string;

const PER_PAGE = 100;
const MAX_PAGES = 50;

const defaultGhRunner: GhRunner = (args: string[]): string => {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    // Plain error on purpose: runGh routes every failure through
    // diagnoseGhFailure so scope problems surface by name.
    throw new Error(stderr || `gh exited with status ${result.status}`);
  }
  // `gh auth status` prints to stderr even on success, so fall back to it.
  return (result.stdout || result.stderr || '');
};

let ghRunner: GhRunner = defaultGhRunner;

/**
 * Test seam only: swaps the `gh` process runner so adapter tests run against
 * fixtures. No test ever calls the real GitHub API. Passing null restores the
 * default spawn-based runner.
 */
export function setGhRunnerForTests(runner: GhRunner | null): void {
  ghRunner = runner ?? defaultGhRunner;
}

export class GhCommandError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly missingScope: string | null;

  constructor(args: string[], stderr: string, missingScope: string | null = null) {
    super(formatGhErrorMessage(args, stderr, missingScope));
    this.name = 'GhCommandError';
    this.args = args;
    this.stderr = stderr;
    this.missingScope = missingScope;
  }
}

function formatGhErrorMessage(args: string[], stderr: string, missingScope: string | null): string {
  const command = `gh ${args.join(' ')}`;
  if (missingScope) {
    const remedy = missingScope === 'read:project'
      ? `Remedy: gh auth refresh -h github.com -s read:project (Projects v2 requires the read:project scope).`
      : `Remedy: gh auth refresh -h github.com -s ${missingScope}.`;
    return `gh command failed: ${command}\nGitHub token is missing the required scope '${missingScope}'. ${remedy}\n${stderr}`;
  }
  if (/Bad credentials|HTTP 401/.test(stderr)) {
    return `gh command failed: ${command}\nGitHub rejected the credentials. Remedy: run \`gh auth login\` and retry.\n${stderr}`;
  }
  return `gh command failed: ${command}\n${stderr}`;
}

function tokenScopesFromAuthStatus(): string[] | null {
  let out: string;
  try {
    out = ghRunner(['auth', 'status']);
  } catch {
    return null;
  }
  const line = out.split(/\r?\n/).find(l => /Token scopes:/i.test(l));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1)
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Distinguishes missing-scope failures from generic auth/4xx errors by name.
 * Project v2 access needs `read:project`; private repos need `repo`. Scope
 * inspection only runs on the failure path, never on success.
 */
function diagnoseGhFailure(args: string[], stderr: string): GhCommandError {
  // args[0] is 'api' for REST/GraphQL calls; args[1] is the endpoint.
  const endpoint = args[1] ?? '';
  const scopeSensitive = endpoint === 'graphql' || /projects?/.test(endpoint);
  if (/Bad credentials|HTTP 401/.test(stderr)) {
    return new GhCommandError(args, stderr);
  }
  if (/HTTP 40[34]/.test(stderr) || /Resource not accessible|FORBIDDEN|INSUFFICIENT_SCOPES/i.test(stderr)) {
    const scopes = tokenScopesFromAuthStatus();
    if (scopes) {
      const hasProjectScope = scopes.includes('read:project') || scopes.includes('project');
      if (scopeSensitive && !hasProjectScope) {
        return new GhCommandError(args, stderr, 'read:project');
      }
      if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
        return new GhCommandError(args, stderr, 'repo');
      }
    }
  }
  return new GhCommandError(args, stderr);
}

function runGh(args: string[]): string {
  try {
    return ghRunner(args).trim();
  } catch (error) {
    if (error instanceof GhCommandError) throw error;
    // A runner that throws plain Errors (spawn failures, test stubs) is still
    // routed through diagnostics so scope problems surface by name.
    const stderr = error instanceof Error ? error.message : String(error);
    throw diagnoseGhFailure(args, stderr);
  }
}

function ghApiJson<T>(args: string[]): T {
  const out = runGh(['api', ...args]);
  if (!out) throw new Error('Empty response from gh api');
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`Invalid JSON from gh api: ${out.slice(0, 200)}`);
  }
}

export function createIssue(config: SyncConfig, input: {
  title: string;
  body?: string;
  labels?: string[];
  milestone?: string;
}): GitHubIssue {
  const args = [`repos/${config.owner}/${config.repo}/issues`, '-X', 'POST', '-f', `title=${input.title}`];
  if (input.body) args.push('-f', `body=${input.body}`);
  if (input.labels && input.labels.length > 0) {
    for (const label of input.labels) {
      args.push('-f', `labels[]=${label}`);
    }
  }
  if (input.milestone) args.push('-f', `milestone=${input.milestone}`);
  return ghApiJson<GitHubIssue>(args);
}

export function updateIssue(config: SyncConfig, issueNumber: number, input: {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
}): GitHubIssue {
  const args = [`repos/${config.owner}/${config.repo}/issues/${issueNumber}`, '-X', 'PATCH'];
  if (input.title !== undefined) args.push('-f', `title=${input.title}`);
  if (input.body !== undefined) args.push('-f', `body=${input.body}`);
  if (input.state !== undefined) args.push('-f', `state=${input.state}`);
  if (input.labels !== undefined) {
    for (const label of input.labels) {
      args.push('-f', `labels[]=${label}`);
    }
    if (input.labels.length === 0) {
      args.push('-f', 'labels[]');
    }
  }
  return ghApiJson<GitHubIssue>(args);
}

export function getIssues(config: SyncConfig): GitHubIssue[] {
  const issues: GitHubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = ghApiJson<GitHubIssue[]>([
      `repos/${config.owner}/${config.repo}/issues?state=all&per_page=${PER_PAGE}&page=${page}`
    ]);
    issues.push(...batch);
    if (batch.length < PER_PAGE) return issues;
  }
  return issues;
}

function projectItemsQuery(itemFields: string): string {
  return `
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
${itemFields}
            }
          }
        }
      }
    }
  `;
}

function fetchProjectItemNodes(config: SyncConfig, itemFields: string): any[] {
  const query = projectItemsQuery(itemFields);
  const nodes: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['graphql', '-f', `query=${query}`, '-f', `projectId=${config.projectId}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const response = ghApiJson<any>(args);
    const connection = response?.data?.node?.items;
    nodes.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
  }
  return nodes;
}

export function getProjectStatuses(config: SyncConfig): ProjectItemStatus[] {
  if (!config.projectId || !config.statusFieldId) return [];

  const itemsFields = `
              id
              content {
                ... on Issue {
                  number
                  repository {
                    name
                    owner { login }
                  }
                }
              }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        id
                      }
                    }
                  }
                }
              }
      `.trim();

  const nodes = fetchProjectItemNodes(config, itemsFields);
  const out: ProjectItemStatus[] = [];

  for (const node of nodes) {
    const issue = node?.content;
    if (!issue || issue.repository?.owner?.login !== config.owner || issue.repository?.name !== config.repo) continue;
    const statusNode = (node.fieldValues?.nodes || []).find((fv: any) => fv?.field?.id === config.statusFieldId && typeof fv?.name === 'string');
    if (!statusNode || !statusNode.name) continue;
    out.push({ issueNumber: issue.number, itemId: node.id, statusName: statusNode.name });
  }
  return out;
}

export function getProjectIssueItems(config: SyncConfig): ProjectIssueItem[] {
  if (!config.projectId) return [];

  const itemsFields = `
              id
              content {
                ... on Issue {
                  number
                  repository {
                    name
                    owner { login }
                  }
                }
              }
      `.trim();

  const nodes = fetchProjectItemNodes(config, itemsFields);
  const out: ProjectIssueItem[] = [];

  for (const node of nodes) {
    const issue = node?.content;
    if (!issue || issue.repository?.owner?.login !== config.owner || issue.repository?.name !== config.repo) continue;
    out.push({ issueNumber: issue.number, itemId: node.id });
  }

  return out;
}

export function getProjectDates(config: SyncConfig): ProjectItemDates[] {
  if (!config.projectId) return [];
  const hasDateField = Boolean(config.startDateFieldId || config.dueDateFieldId || config.completedDateFieldId);
  if (!hasDateField) return [];

  const itemsFields = `
              id
              content {
                ... on Issue {
                  number
                  repository {
                    name
                    owner { login }
                  }
                }
              }
              fieldValues(first: 50) {
                nodes {
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field {
                      ... on ProjectV2Field {
                        id
                      }
                    }
                  }
                }
              }
      `.trim();

  const nodes = fetchProjectItemNodes(config, itemsFields);
  const out: ProjectItemDates[] = [];

  for (const node of nodes) {
    const issue = node?.content;
    if (!issue || issue.repository?.owner?.login !== config.owner || issue.repository?.name !== config.repo) continue;

    const row: ProjectItemDates = { issueNumber: issue.number, itemId: node.id };
    for (const fv of node.fieldValues?.nodes || []) {
      const fieldId = fv?.field?.id;
      if (!fieldId || typeof fv?.date !== 'string') continue;
      if (config.startDateFieldId && fieldId === config.startDateFieldId) row.start = fv.date;
      if (config.dueDateFieldId && fieldId === config.dueDateFieldId) row.due = fv.date;
      if (config.completedDateFieldId && fieldId === config.completedDateFieldId) row.completed = fv.date;
    }
    out.push(row);
  }

  return out;
}

export function getStatusOptionIds(config: SyncConfig): Record<string, string> {
  if (!config.projectId || !config.statusFieldId) return {};
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;
  const response = ghApiJson<any>(['graphql', '-f', `query=${query}`, '-f', `projectId=${config.projectId}`]);
  const fields = response?.data?.node?.fields?.nodes || [];
  const statusField = fields.find((f: any) => f?.id === config.statusFieldId);
  const map: Record<string, string> = {};
  for (const opt of statusField?.options || []) {
    map[opt.name] = opt.id;
  }
  return map;
}

export function addIssueToProject(config: SyncConfig, issueNodeId: string): string {
  if (!config.projectId) throw new Error('projectId is required to add issue to project');
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item {
          id
        }
      }
    }
  `;
  const response = ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `contentId=${issueNodeId}`
  ]);
  return response?.data?.addProjectV2ItemById?.item?.id;
}

export function setProjectItemStatus(config: SyncConfig, itemId: string, optionId: string): void {
  if (!config.projectId || !config.statusFieldId) return;
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${config.statusFieldId}`,
    '-f', `optionId=${optionId}`
  ]);
}

export function setProjectItemDate(config: SyncConfig, itemId: string, fieldId: string, date: string): void {
  if (!config.projectId) return;
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { date: $date }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${fieldId}`,
    '-f', `date=${date}`
  ]);
}

export function clearProjectItemFieldValue(config: SyncConfig, itemId: string, fieldId: string): void {
  if (!config.projectId) return;
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${fieldId}`
  ]);
}
