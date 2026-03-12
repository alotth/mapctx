# Retry Policy

Apply retries by error class. Do not use a single generic retry loop.

## Error Classes

### 1) Authentication (`401 Unauthorized`)

- Max retries: `1` extra attempt.
- Behavior:
  - Retry once only if failure may be a transient token read issue.
  - If it fails again, stop.
  - Return actionable message to re-authenticate the configured agent CLI.
- Do not continue loop after repeated 401.

### 2) Transient Network

Classify as transient when stderr/output contains patterns such as:

- `ETIMEDOUT`
- `ECONNRESET`
- `ENOTFOUND`
- `EAI_AGAIN`
- HTTP `429`
- HTTP `500`, `502`, `503`, `504`

Policy:

- Max retries: `3`.
- Backoff with jitter:
  - retry 1: `2s + random(0..500ms)`
  - retry 2: `5s + random(0..1000ms)`
  - retry 3: `11s + random(0..1500ms)`
- If still failing, stop and return concise diagnostics.

### 3) Prompt/Parse/Validation Errors

Examples:

- invalid slash command format
- task ID normalization failure
- missing task block in `TASKS.md`
- missing detail file
- malformed prompt contract

Policy:

- Fail fast.
- Max retries: `0`.
- Return clear error and required correction.

## Retry Report

Always include retry summary in final response:

- detected error class
- attempts performed
- last error excerpt
- next required user action (if any)
