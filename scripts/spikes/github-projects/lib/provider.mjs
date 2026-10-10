// T-135 spike: the subset of the `TaskProvider` contract from
// docs/engineering/provider-authority-study.md that a GitHub adapter would
// implement, written against the real API so the study's claims can be
// checked instead of assumed.
//
// Every target is a parameter (owner / repo / project number). Pointing the
// read path at seeded issues in another repository is a flag change, not a
// code change -- that was an explicit requirement of this spike.

import { RATE_LIMIT_SELECTION } from './gh.mjs'

/** ProviderItemRef (study §TaskProvider contract sketch). */
function itemRef({ provider = 'github', workItem, projectItem }) {
  return { provider, workItem, ...(projectItem ? { projectItem } : {}) }
}

function freshness({ partial = false, omitted } = {}) {
  return {
    fetchedAt: new Date().toISOString(),
    source: 'live',
    stale: false,
    partial,
    ...(omitted ? { omitted } : {}),
  }
}

const PROJECT_FIELDS_QUERY = `
query($owner: String!, $number: Int!, $fieldsCursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      number
      title
      shortDescription
      readme
      public
      closed
      url
      updatedAt
      items(first: 1) { totalCount }
      fields(first: 100, after: $fieldsCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          ... on ProjectV2IterationField { id name dataType }
        }
      }
    }
  }
  ${RATE_LIMIT_SELECTION}
}`

const PROJECT_ITEMS_QUERY = `
query($projectId: ID!, $first: Int!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $first, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          updatedAt
          content {
            __typename
            ... on DraftIssue { id title body }
            ... on Issue { id number title url state repository { nameWithOwner } }
            ... on PullRequest { id number title url state repository { nameWithOwner } }
          }
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
            }
          }
        }
      }
    }
  }
  ${RATE_LIMIT_SELECTION}
}`

// One request carries identity, state, dependency edges and the sub-issue
// tree. `blockedBy` / `blocking` are real connections, not just the counters on
// `issueDependenciesSummary`.
const REPO_ITEMS_QUERY = `
query($owner: String!, $repo: String!, $first: Int!, $cursor: String, $states: [IssueState!]) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    isPrivate
    hasIssuesEnabled
    issues(first: $first, after: $cursor, states: $states, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        url
        state
        stateReason
        createdAt
        updatedAt
        closedAt
        body
        milestone { title }
        labels(first: 20) { totalCount nodes { name } }
        assignees(first: 10) { totalCount nodes { login } }
        issueType { name }
        parent { id number title }
        subIssuesSummary { total completed percentCompleted }
        subIssues(first: 50) { totalCount nodes { id number title } }
        issueDependenciesSummary { blockedBy blocking totalBlockedBy totalBlocking }
        blockedBy(first: 50) { totalCount nodes { id number title repository { nameWithOwner } } }
        blocking(first: 50) { totalCount nodes { id number title repository { nameWithOwner } } }
        relatesTo(first: 50) { totalCount nodes { id number repository { nameWithOwner } } }
      }
    }
  }
  ${RATE_LIMIT_SELECTION}
}`

export function createGithubProvider(client) {
  /** Capabilities are filled in from what the spike actually observed. */
  const observed = {
    fields: {},
    relations: {},
    comments: { read: false, write: false },
    criteria: { read: false, write: false },
    timeline: { read: false },
  }

  async function getProject({ owner, number }) {
    const res = await client.graphql(
      PROJECT_FIELDS_QUERY,
      { owner, number, fieldsCursor: null },
      { label: 'getProject(fields,100)' },
    )
    if (!res.ok) return res
    const p = res.value?.user?.projectV2
    if (!p) return { ok: false, error: { kind: 'not-found', message: `project ${owner}/#${number}` } }
    return {
      ok: true,
      value: {
        id: p.id,
        number: p.number,
        title: p.title,
        shortDescription: p.shortDescription,
        readme: p.readme,
        public: p.public,
        closed: p.closed,
        url: p.url,
        revision: p.updatedAt,
        itemCount: p.items.totalCount,
        fieldCount: p.fields.totalCount,
        fieldsHasNextPage: p.fields.pageInfo.hasNextPage,
        fields: p.fields.nodes.filter(Boolean),
      },
    }
  }

  async function findProjectByTitle({ owner, title }) {
    const res = await client.graphql(
      `query($owner: String!) {
         user(login: $owner) { projectsV2(first: 50) { totalCount nodes { id number title closed } } }
         ${RATE_LIMIT_SELECTION}
       }`,
      { owner },
      { label: 'findProjectByTitle' },
    )
    if (!res.ok) return res
    const match = (res.value?.user?.projectsV2?.nodes ?? []).find((n) => n?.title === title)
    return { ok: true, value: match ?? null }
  }

  async function createProject({ ownerId, title, repositoryId }) {
    const res = await client.graphql(
      `mutation($ownerId: ID!, $title: String!, $repositoryId: ID, $cid: String!) {
         createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId, clientMutationId: $cid }) {
           clientMutationId
           projectV2 { id number title public url }
         }
       }`,
      { ownerId, title, repositoryId, cid: `t135-create-project` },
      { label: 'createProjectV2', mutation: true },
    )
    if (!res.ok) return res
    return { ok: true, value: res.value.createProjectV2.projectV2, echoedClientMutationId: res.value.createProjectV2.clientMutationId }
  }

  async function setProjectMeta({ projectId, patch, clientOperationId }) {
    // Covers the study's setProjectField({ field: 'title' | 'notes' }).
    const res = await client.graphql(
      `mutation($projectId: ID!, $title: String, $short: String, $readme: String, $public: Boolean, $cid: String!) {
         updateProjectV2(input: { projectId: $projectId, title: $title, shortDescription: $short, readme: $readme, public: $public, clientMutationId: $cid }) {
           clientMutationId
           projectV2 { id title shortDescription public updatedAt }
         }
       }`,
      {
        projectId,
        title: patch.title ?? null,
        short: patch.shortDescription ?? null,
        readme: patch.readme ?? null,
        public: patch.public ?? null,
        cid: clientOperationId,
      },
      { label: 'updateProjectV2(meta)', mutation: true },
    )
    if (!res.ok) return res
    return { ok: true, value: res.value.updateProjectV2.projectV2 }
  }

  async function createField({ projectId, name, dataType, singleSelectOptions, clientOperationId }) {
    const res = await client.graphql(
      `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!], $cid: String!) {
         createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $options, clientMutationId: $cid }) {
           clientMutationId
           projectV2Field {
             ... on ProjectV2FieldCommon { id name dataType }
             ... on ProjectV2SingleSelectField { options { id name } }
           }
         }
       }`,
      { projectId, name, dataType, options: singleSelectOptions ?? null, cid: clientOperationId },
      { label: `createProjectV2Field(${dataType})`, mutation: true },
    )
    if (!res.ok) return res
    return { ok: true, value: res.value.createProjectV2Field.projectV2Field }
  }

  async function listItems({ projectId, first = 50, cursor = null }) {
    const res = await client.graphql(
      PROJECT_ITEMS_QUERY,
      { projectId, first, cursor },
      { label: `listItems(project,first=${first})` },
    )
    if (!res.ok) return res
    const conn = res.value?.node?.items
    if (!conn) return { ok: false, error: { kind: 'not-found', message: 'project items' } }
    const items = conn.nodes.filter(Boolean).map((n) => {
      const c = n.content ?? {}
      return {
        ref: itemRef({
          workItem: { id: c.id ?? n.id, key: c.number ? `${c.repository?.nameWithOwner}#${c.number}` : `draft:${n.id}`, url: c.url ?? '' },
          projectItem: { projectId, itemId: n.id },
        }),
        contentKind: c.__typename ?? n.type,
        revision: n.updatedAt,
        fields: {
          title: c.title ?? null,
          body: c.body ?? null,
          planningState: c.state ?? null,
        },
        projectFieldValues: (n.fieldValues?.nodes ?? []).filter((v) => v?.field).map((v) => ({
          fieldId: v.field.id,
          fieldName: v.field.name,
          kind: v.__typename,
          value: v.number ?? v.text ?? v.date ?? v.name ?? null,
          optionId: v.optionId ?? null,
        })),
      }
    })
    return {
      ok: true,
      value: {
        items,
        totalCount: conn.totalCount,
        nextCursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : undefined,
        freshness: freshness({ partial: conn.pageInfo.hasNextPage }),
      },
    }
  }

  /**
   * listItems over a repository's issues plus getDependencies in one request.
   * `owner`/`repo`/`states` are parameters: aiming this at a seeded repository
   * needs no code change.
   */
  async function listRepoItemsWithDependencies({ owner, repo, first = 50, cursor = null, includeClosed = true }) {
    const res = await client.graphql(
      REPO_ITEMS_QUERY,
      { owner, repo, first, cursor, states: includeClosed ? ['OPEN', 'CLOSED'] : ['OPEN'] },
      { label: `listRepoItems+deps(first=${first})` },
    )
    if (!res.ok) return res
    const r = res.value?.repository
    if (!r) return { ok: false, error: { kind: 'not-found', message: `${owner}/${repo}` } }
    const conn = r.issues
    const items = []
    const dependencies = []
    const subIssueEdges = []
    let truncatedEdges = 0

    for (const n of conn.nodes.filter(Boolean)) {
      const ref = itemRef({
        workItem: { id: n.id, key: `${r.nameWithOwner}#${n.number}`, url: n.url },
      })
      items.push({
        ref,
        contentKind: 'Issue',
        revision: n.updatedAt,
        number: n.number,
        fields: {
          title: n.title,
          body: n.body,
          planningState: n.state,
          completedOn: n.closedAt,
          type: n.issueType?.name ?? null,
          parent: n.parent ? `${r.nameWithOwner}#${n.parent.number}` : null,
          tags: (n.labels?.nodes ?? []).map((l) => l.name),
          assignees: (n.assignees?.nodes ?? []).map((a) => a.login),
          milestone: n.milestone?.title ?? null,
        },
        dependencySummary: n.issueDependenciesSummary,
        subIssuesSummary: n.subIssuesSummary,
        labelsTruncated: (n.labels?.totalCount ?? 0) > (n.labels?.nodes?.length ?? 0),
      })

      for (const b of n.blockedBy?.nodes ?? []) {
        dependencies.push({
          from: ref,
          to: itemRef({ workItem: { id: b.id, key: `${b.repository?.nameWithOwner}#${b.number}`, url: '' } }),
          kind: 'blocked-by',
          revision: n.updatedAt,
        })
      }
      for (const b of n.blocking?.nodes ?? []) {
        dependencies.push({
          from: ref,
          to: itemRef({ workItem: { id: b.id, key: `${b.repository?.nameWithOwner}#${b.number}`, url: '' } }),
          kind: 'blocks',
          revision: n.updatedAt,
        })
      }
      for (const b of n.relatesTo?.nodes ?? []) {
        dependencies.push({
          from: ref,
          to: itemRef({ workItem: { id: b.id, key: `${b.repository?.nameWithOwner}#${b.number}`, url: '' } }),
          kind: 'relates-to',
          revision: n.updatedAt,
        })
      }
      for (const s of n.subIssues?.nodes ?? []) {
        subIssueEdges.push({ parent: ref.workItem.key, child: `${r.nameWithOwner}#${s.number}` })
      }
      // A nested connection that is cut off is a partial page, not an absence.
      if ((n.blockedBy?.totalCount ?? 0) > (n.blockedBy?.nodes?.length ?? 0)) truncatedEdges += 1
      if ((n.blocking?.totalCount ?? 0) > (n.blocking?.nodes?.length ?? 0)) truncatedEdges += 1
      if ((n.subIssues?.totalCount ?? 0) > (n.subIssues?.nodes?.length ?? 0)) truncatedEdges += 1
    }

    observed.relations['blocked-by'] = { read: true, write: false }
    observed.relations.blocks = { read: true, write: false }
    observed.relations['relates-to'] = { read: true, write: false }

    return {
      ok: true,
      value: {
        repository: { nameWithOwner: r.nameWithOwner, isPrivate: r.isPrivate, hasIssuesEnabled: r.hasIssuesEnabled },
        items,
        dependencies,
        subIssueEdges,
        totalCount: conn.totalCount,
        nextCursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : undefined,
        freshness: freshness({
          partial: conn.pageInfo.hasNextPage || truncatedEdges > 0,
          omitted: truncatedEdges > 0 ? [`${truncatedEdges} nested relation page(s) truncated`] : undefined,
        }),
      },
    }
  }

  /** The REST half of getDependencies, for cost/shape comparison. */
  async function getDependenciesRest({ owner, repo, number }) {
    const out = { blockedBy: [], blocking: [], calls: [] }
    for (const [key, path] of [
      ['blockedBy', `/repos/${owner}/${repo}/issues/${number}/dependencies/blocked_by`],
      ['blocking', `/repos/${owner}/${repo}/issues/${number}/dependencies/blocking`],
    ]) {
      const res = await client.rest('GET', `${path}?per_page=100`, { label: `rest deps ${key}` })
      if (!res.ok) return res
      out[key] = (res.value ?? []).map((i) => ({ number: i.number, id: i.node_id, repo: i.repository?.full_name }))
      out.calls.push({ key, status: res.metric.status, latencyMs: res.metric.latencyMs, restRemaining: res.metric.restRemaining })
    }
    return { ok: true, value: out }
  }

  async function createDraftItem({ projectId, title, body, clientOperationId }) {
    const res = await client.graphql(
      `mutation($projectId: ID!, $title: String!, $body: String, $cid: String!) {
         addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body, clientMutationId: $cid }) {
           clientMutationId
           projectItem { id type content { ... on DraftIssue { id title } } }
         }
       }`,
      { projectId, title, body: body ?? null, cid: clientOperationId },
      { label: 'addProjectV2DraftIssue', mutation: true },
    )
    if (!res.ok) return res
    const pi = res.value.addProjectV2DraftIssue.projectItem
    return {
      ok: true,
      value: {
        ref: itemRef({
          workItem: { id: pi.content?.id ?? pi.id, key: `draft:${pi.id}`, url: '' },
          projectItem: { projectId, itemId: pi.id },
        }),
        contentKind: 'DraftIssue',
      },
      echoedClientMutationId: res.value.addProjectV2DraftIssue.clientMutationId,
    }
  }

  async function addExistingItem({ projectId, contentId, clientOperationId }) {
    const res = await client.graphql(
      `mutation($projectId: ID!, $contentId: ID!, $cid: String!) {
         addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId, clientMutationId: $cid }) {
           clientMutationId
           item { id type }
         }
       }`,
      { projectId, contentId, cid: clientOperationId },
      { label: 'addProjectV2ItemById', mutation: true },
    )
    if (!res.ok) return res
    return { ok: true, value: res.value.addProjectV2ItemById.item, echoedClientMutationId: res.value.addProjectV2ItemById.clientMutationId }
  }

  /**
   * setField for the study's `surface: 'project-item'` FieldRef. The write
   * needs project id + item id + field id, and for a single select the resolved
   * option id -- four identities that are all distinct from issue identity.
   */
  async function setField({ fieldRef, value, clientOperationId }) {
    const { projectId, projectItemId, providerFieldId, dataType, optionId } = fieldRef
    let graphqlValue
    if (value === null || value === undefined) graphqlValue = null
    else if (dataType === 'NUMBER') graphqlValue = { number: Number(value) }
    else if (dataType === 'DATE') graphqlValue = { date: value }
    else if (dataType === 'TEXT') graphqlValue = { text: String(value) }
    else if (dataType === 'SINGLE_SELECT') graphqlValue = { singleSelectOptionId: optionId }
    else return { ok: false, error: { kind: 'unsupported', message: `dataType ${dataType}`, capability: 'setField' } }

    if (graphqlValue === null) {
      const res = await client.graphql(
        `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $cid: String!) {
           clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, clientMutationId: $cid }) {
             clientMutationId
             projectV2Item { id updatedAt }
           }
         }`,
        { projectId, itemId: projectItemId, fieldId: providerFieldId, cid: clientOperationId },
        { label: 'clearProjectV2ItemFieldValue', mutation: true },
      )
      if (!res.ok) return res
      return { ok: true, value: res.value.clearProjectV2ItemFieldValue.projectV2Item, cleared: true }
    }

    const res = await client.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!, $cid: String!) {
         updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value, clientMutationId: $cid }) {
           clientMutationId
           projectV2Item { id updatedAt }
         }
       }`,
      { projectId, itemId: projectItemId, fieldId: providerFieldId, value: graphqlValue, cid: clientOperationId },
      { label: `setField(${dataType})`, mutation: true },
    )
    if (!res.ok) return res
    observed.fields[fieldRef.semantic ?? 'derived'] = { read: true, write: true }
    return {
      ok: true,
      value: res.value.updateProjectV2ItemFieldValue.projectV2Item,
      echoedClientMutationId: res.value.updateProjectV2ItemFieldValue.clientMutationId,
    }
  }

  return {
    kind: 'github',
    get capabilities() {
      return observed
    },
    getProject,
    findProjectByTitle,
    createProject,
    setProjectMeta,
    createField,
    listItems,
    listRepoItemsWithDependencies,
    getDependenciesRest,
    createDraftItem,
    addExistingItem,
    setField,
  }
}
