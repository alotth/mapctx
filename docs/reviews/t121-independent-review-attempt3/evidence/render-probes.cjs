const assert = require('node:assert/strict')
const reviewCopy = process.env.MAPCTX_REVIEW_COPY
if (!reviewCopy) throw new Error('Set MAPCTX_REVIEW_COPY to the isolated current-dirty worktree copy')
const { renderAcceptanceProse, renderAcceptanceProseUnowned, parseAcceptanceChecklist } = require(require('node:path').join(reviewCopy, 'packages/core/dist/task-detail.js'))
const out = {}
const T063 = [
  '## Expected Outcome',
  'Gateway executes declared capabilities only.',
  '',
  '## Acceptance',
  '- [x] Remote provider exposes only declared tools.',
  '- [x] CLI runs approved operations only.',
  'Review: docs/reviews/T-063.md',
  '',
  '### Evidence',
  '```md',
  '- [ ] example only',
  '```',
  '',
  '## Open Decisions',
  '- retain original notes'
].join('\n')
const t063Criteria = [
  { text: 'Remote provider exposes only declared tools.', completed: false },
  { text: 'CLI runs approved operations only.', completed: true }
]
const rendered = renderAcceptanceProse(T063, t063Criteria, 7)
assert.ok(rendered.includes('Review: docs/reviews/T-063.md'))
assert.ok(rendered.includes('### Evidence\n```md\n- [ ] example only\n```'))
assert.ok(rendered.includes('## Open Decisions\n- retain original notes'))
assert.deepEqual(parseAcceptanceChecklist(rendered).items.map(i => [i.text, i.completed]), [['Remote provider exposes only declared tools.', false], ['CLI runs approved operations only.', true]])
out.T063 = { pass: true, renderedSha256: require('node:crypto').createHash('sha256').update(rendered).digest('hex') }
const empty = renderAcceptanceProse('## Acceptance\nAuthored closure note.\n- Plain authored evidence.', [], 8)
assert.ok(empty.includes('Authored closure note.'))
assert.ok(!empty.includes('store-owned acceptance revision'))
out.emptyCanonical = { pass: true, output: empty }
const absent = '## Acceptance\nAuthored plain criterion\n- Evidence: docs/evidence.md'
assert.equal(renderAcceptanceProseUnowned(absent), absent)
assert.throws(() => renderAcceptanceProseUnowned('## Acceptance\n- [x] Legacy checkbox'), /acceptance-render-refused/)
out.absentCanonical = { pass: true }
const duplicate = renderAcceptanceProse('## Acceptance\n- Same text.\n- Same text.', [
  { text: 'Same text.', completed: true }, { text: 'Same text.', completed: false }
], 2)
assert.equal((duplicate.match(/^- \[[ x]\] Same text\.$/gm) || []).length, 2)
assert.ok(duplicate.includes('- [x] Same text.\n- [ ] Same text.'))
out.duplicateCriteria = { pass: true, output: duplicate }
const interleaved = '## Acceptance\n- [x] A.\nNote for A above.\n- [x] B.'
assert.throws(() => renderAcceptanceProse(interleaved, [{text:'B.',completed:false},{text:'A.',completed:false}], 2), /acceptance-render-refused/)
out.interleavedReorderRefuses = { pass: true }
assert.throws(() => renderAcceptanceProse('## Acceptance\n- [x] Old criterion.\nEvidence for old criterion: docs/old.md\n- [x] B.', [{text:'B.',completed:false}], 3), /acceptance-render-refused/)
out.removedCriterionWithEvidenceRefuses = { pass: true }
const trailing = '## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'
const reordered = renderAcceptanceProse(trailing, [{text:'B.',completed:false},{text:'A.',completed:false}], 2)
out.trailingReorder = { input: trailing, output: reordered, evidenceIndexBefore: trailing.indexOf('Evidence for B'), afterCriterion: reordered.slice(reordered.indexOf('Evidence for B') - 35, reordered.indexOf('Evidence for B')) }
const added = renderAcceptanceProse('## Acceptance\n- [x] A.\nEvidence for A: docs/A.md', [{text:'A.',completed:false},{text:'B.',completed:false}], 3)
out.missingCriterionWithTrailingEvidence = { input: '## Acceptance\n- [x] A.\nEvidence for A: docs/A.md', output: added }
const nested = '## Acceptance\n- [x] Parent.\n  - [x] Child.'
assert.ok(renderAcceptanceProse(nested, [{text:'Parent.',completed:true},{text:'Child.',completed:true}], 1).includes('  - [x] Child.'))
assert.throws(() => renderAcceptanceProse('## Acceptance\n- [x] Parent.\n  - [x] Child.', [{text:'Child.',completed:true},{text:'Parent.',completed:true}], 2), /acceptance-render-refused/)
out.nested = { pass: true, hierarchicalReorderRefused: true }
assert.throws(() => renderAcceptanceProse('## Acceptance\n- [ ] A.\n## Acceptance\n- [ ] B.', [{text:'A.',completed:false}], 1), /acceptance-render-refused/)
out.multipleSections = { pass: true }
assert.throws(() => renderAcceptanceProse('## Acceptance\n- [ ] A\n```md\nopen', [{text:'A',completed:false}], 1), /acceptance-render-refused/)
out.openFence = { pass: true }
console.log(JSON.stringify(out, null, 2))
