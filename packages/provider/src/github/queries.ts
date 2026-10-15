/**
 * The GraphQL documents the read adapter uses.
 *
 * Kept as named constants with a stable `label` so a recorded fixture key is
 * readable and so the recorder and the adapter cannot drift apart: both import
 * from here.
 *
 * Every document selects `rateLimit { limit cost remaining resetAt }`. The
 * spike measured that a query reports its own cost in the payload while a
 * mutation cannot, and that the `x-ratelimit-used` header drifts under
 * concurrency — so for a read adapter the payload is the only trustworthy
 * meter, and asking for it costs nothing.
 */

const RATE_LIMIT = "rateLimit { limit cost remaining resetAt }"

/**
 * Issue fields, in one place.
 *
 * `blockedBy` / `blocking` / `relatesTo` are real connections rather than the
 * counters on `issueDependenciesSummary`, which the spike confirmed are counts
 * only. The nested `totalCount` is selected next to `nodes` on purpose: a
 * truncated edge list must be reportable as a partial page, because a cut-off
 * `blockedBy` list read as "no dependencies" would silently flatten the plan.
 */
const ISSUE_FIELDS = `
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
  labels(first: 50) { totalCount nodes { name } }
  assignees(first: 20) { totalCount nodes { login } }
  issueType { name }
  parent { id number title url }
  subIssuesSummary { total completed }
  subIssues(first: 50) { totalCount nodes { id number title url } }
  issueDependenciesSummary { blockedBy blocking totalBlockedBy totalBlocking }
  blockedBy(first: 50) { totalCount nodes { id number title url repository { nameWithOwner } } }
  blocking(first: 50) { totalCount nodes { id number title url repository { nameWithOwner } } }
  relatesTo(first: 50) { totalCount nodes { id number title url repository { nameWithOwner } } }
  projectItems(first: 10) {
    totalCount
    nodes {
      id
      project { id number title }
      fieldValues(first: 50) {
        totalCount
        nodes {
          __typename
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldIterationValue { iterationId title field { ... on ProjectV2FieldCommon { id name } } }
        }
      }
    }
  }
`

/** Project item fields: the board view, where a draft issue also appears. */
const PROJECT_ITEM_FIELDS = `
  id
  type
  updatedAt
  isArchived
  content {
    __typename
    ... on DraftIssue { id title body createdAt updatedAt }
    ... on Issue { ${ISSUE_FIELDS} }
    ... on PullRequest { id number title url state updatedAt }
  }
  fieldValues(first: 50) {
    totalCount
    nodes {
      __typename
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldIterationValue { iterationId title field { ... on ProjectV2FieldCommon { id name } } }
    }
  }
`

export const Q_PROJECT = {
  label: "project",
  document: `
    query($owner: String!, $number: Int!) {
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
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_PROJECT_FIELDS = {
  label: "project-fields",
  document: `
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name description } }
            }
          }
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_PROJECT_ITEMS = {
  label: "project-items",
  document: `
    query($projectId: ID!, $first: Int!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: $first, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { ${PROJECT_ITEM_FIELDS} }
          }
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_REPO_ISSUES = {
  label: "repo-issues",
  document: `
    query($owner: String!, $repo: String!, $first: Int!, $cursor: String, $states: [IssueState!]) {
      repository(owner: $owner, name: $repo) {
        id
        nameWithOwner
        isPrivate
        hasIssuesEnabled
        issues(first: $first, after: $cursor, states: $states, orderBy: { field: CREATED_AT, direction: ASC }) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { ${ISSUE_FIELDS} }
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_NODE = {
  label: "node",
  document: `
    query($id: ID!) {
      node(id: $id) {
        __typename
        ... on Issue { ${ISSUE_FIELDS} }
        ... on DraftIssue { id title body createdAt updatedAt }
        ... on ProjectV2Item { ${PROJECT_ITEM_FIELDS} }
      }
      ${RATE_LIMIT}
    }`
} as const

/**
 * Key resolution through search.
 *
 * `findByKey` has to answer "which issue carries `[T-150]`" without walking the
 * board. GitHub's search is the only index for that, and it is a different
 * subsystem with its own freshness: a just-created issue can be missing from it
 * for a while, which the adapter reports rather than hides.
 */
export const Q_SEARCH_KEYS = {
  label: "search-keys",
  document: `
    query($query: String!, $first: Int!) {
      search(query: $query, type: ISSUE, first: $first) {
        issueCount
        pageInfo { hasNextPage endCursor }
        nodes { ... on Issue { ${ISSUE_FIELDS} } }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_ISSUE_COMMENTS = {
  label: "issue-comments",
  document: `
    query($id: ID!, $first: Int!, $cursor: String) {
      node(id: $id) {
        ... on Issue {
          id
          comments(first: $first, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id body createdAt author { login } }
          }
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_ISSUE_TIMELINE = {
  label: "issue-timeline",
  document: `
    query($id: ID!, $first: Int!, $cursor: String) {
      node(id: $id) {
        ... on Issue {
          id
          timelineItems(first: $first, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on IssueComment { id createdAt author { login } }
              ... on ClosedEvent { id createdAt actor { login } }
              ... on ReopenedEvent { id createdAt actor { login } }
              ... on LabeledEvent { id createdAt actor { login } label { name } }
              ... on UnlabeledEvent { id createdAt actor { login } label { name } }
              ... on AssignedEvent { id createdAt actor { login } }
              ... on RenamedTitleEvent { id createdAt actor { login } previousTitle currentTitle }
              ... on MilestonedEvent { id createdAt actor { login } milestoneTitle }
              ... on ParentIssueAddedEvent { id createdAt actor { login } }
              ... on SubIssueAddedEvent { id createdAt actor { login } }
            }
          }
        }
      }
      ${RATE_LIMIT}
    }`
} as const

export const Q_RATE_LIMIT = {
  label: "rate-limit",
  document: `query { ${RATE_LIMIT} }`
} as const
