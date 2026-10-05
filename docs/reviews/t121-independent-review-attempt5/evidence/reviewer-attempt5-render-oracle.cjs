const assert=require('node:assert/strict')
const c=require('/tmp/mapctx-t121-attempt5-review-copy/packages/core/dist/task-detail.js')
const {renderAcceptanceProse:r,renderAcceptanceProseUnowned:u,parseAcceptanceChecklist:p}=c
const pass={}
const criteria=[{text:'A criterion.',completed:false},{text:'B criterion.',completed:true}]
const t063=['## Summary','T-063 design','## Acceptance','- [x] A criterion.','Evidence: docs/T063.md','### Example','```md','- [ ] not canonical','```','- [ ] B criterion.','## Notes','Keep notes.'].join('\n')
let out=r(t063,[{text:'A criterion.',completed:true},{text:'B criterion.',completed:false}],7)
assert(out.includes('Evidence: docs/T063.md\n### Example\n```md\n- [ ] not canonical\n```'))
assert.deepEqual(p(out).items,[{text:'A criterion.',completed:true},{text:'B criterion.',completed:false}]);assert.equal(r(out,[{text:'A criterion.',completed:true},{text:'B criterion.',completed:false}],7),out);pass.T063='PASS'
const empty='## Acceptance\nAuthored closure note.\n- Plain evidence list.'
assert.equal(r(empty,[],4).replace('## Acceptance\n\n','## Acceptance\n'),empty);assert.equal(u(empty),empty);assert(!r(empty,[],4).includes('store-owned acceptance'));pass.empty='PASS'
const absent='## Acceptance\nAuthored criterion bullet\n- Evidence: docs/evidence.md'
assert.equal(u(absent),absent);assert.throws(()=>u('## Acceptance\n- [x] stale'),/acceptance-render-refused/);pass.absent='PASS'
assert.throws(()=>r('## Acceptance\n- [x] old A\nEvidence for old A\n- [ ] B',[{text:'B',completed:false}],2),/acceptance-render-refused/);pass.orphan='PASS'
const reordered=r('## Acceptance\n- [ ] A criterion.\n- [ ] B criterion.',[{text:'B criterion.',completed:false},{text:'A criterion.',completed:true}],3);assert(reordered.indexOf('B criterion.')<reordered.indexOf('A criterion.'));assert.equal(r(reordered,[{text:'B criterion.',completed:false},{text:'A criterion.',completed:true}],3),reordered);pass.checkboxOnlyReorder='PASS'
assert.throws(()=>r('## Acceptance\n- [x] A.\nEvidence for A\n- [x] B.',[{text:'B.',completed:false},{text:'A.',completed:false}],2),/acceptance-render-refused/)
assert.throws(()=>r('## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md',[{text:'B.',completed:false},{text:'A.',completed:false}],2),/acceptance-render-refused/)
assert.throws(()=>r('## Acceptance\n- [x] A.\nEvidence for A: docs/A.md',[{text:'A.',completed:false},{text:'B.',completed:false}],2),/acceptance-render-refused/);pass.reorderInsertAssociations='PASS'
const pre=r('## Acceptance\nPreface note.\n- [ ] A.\n- [ ] B.',[{text:'B.',completed:false},{text:'A.',completed:false}],2);assert(pre.indexOf('Preface note.')<pre.indexOf('- [ ] B.'));pass.preface='PASS'
const nested=r('## Acceptance\n- [ ] Parent.\n  - Child.\n- [ ] Other.',[{text:'Parent.',completed:false},{text:'Child.',completed:true},{text:'Other.',completed:false}],1);assert(nested.includes('  - [x] Child.'));assert.throws(()=>r('## Acceptance\n- [ ] Parent.\n  - Child.',[{text:'Child.',completed:true},{text:'Parent.',completed:false}],2),/acceptance-render-refused/);pass.hierarchy='PASS'
const fenced='## Acceptance\n- [ ] A.\n```md\n## Acceptance\n- [ ] sample\n```\n- [ ] B.';assert(r(fenced,[{text:'A.',completed:false},{text:'B.',completed:false}],1).includes('## Acceptance\n- [ ] sample'));assert.throws(()=>r('## Acceptance\n- [ ] A.\n- [ ] B.\n```md\nexample\n```',[{text:'B.',completed:false},{text:'A.',completed:false}],2),/acceptance-render-refused/);assert.throws(()=>r('## Acceptance\n- [ ] A.\n```md\nopen',[{text:'A.',completed:false}],2),/acceptance-render-refused/);assert.throws(()=>r('prose\n```md\nopen',[{text:'A.',completed:false}],2),/acceptance-render-refused/);assert.throws(()=>r('## Acceptance\n- [ ] A\n## Acceptance\n- [ ] B',[{text:'A',completed:false}],2),/acceptance-render-refused/);pass.fencesAndSections='PASS'
const dup=r('## Acceptance\n- Criterion.\n- Criterion.',[{text:'Criterion.',completed:true},{text:'Criterion.',completed:false}],2);assert.equal((dup.match(/^- \[[ x]\] Criterion\.$/gm)||[]).length,2);pass.duplicate='PASS'
const generated=r('## Notes\nNotes.',[{text:'A.',completed:false}],1);assert.equal(r(generated,[{text:'A.',completed:false}],1),generated);pass.newSection='PASS'
console.log(JSON.stringify({verdict:'PASS',probes:pass},null,2))
