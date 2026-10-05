const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const copy='/tmp/mapctx-t121-attempt5-review-copy'
const storeApi=require(path.join(copy,'packages/store/dist/index.js'))
const core=require(path.join(copy,'packages/core/dist/task-detail.js'))
const push=require(path.join(copy,'packages/sync-engine/dist/push-store.js'))
const gh=require(path.join(copy,'packages/sync-engine/dist/github.js'))
const {StoreHandle,upsertProject,createTask,reviseAcceptance,buildExport}=storeApi
const {parseTaskDetailFile,generateTaskDetailFile}=core
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
function tree(root){const out={};function walk(dir){for(const n of fs.readdirSync(dir).sort()){const p=path.join(dir,n),s=fs.statSync(p);if(s.isDirectory())walk(p);else out[path.relative(root,p)]=sha(fs.readFileSync(p))}}walk(root);return out}
const cases=[
 {name:'reorder trailing evidence',canonical:['B.','A.'],prose:'## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'},
 {name:'added criterion trailing evidence',canonical:['A.','B.'],prose:'## Acceptance\n- [x] A.\nEvidence for A: docs/A.md'}
]
const results=[]
for(let i=0;i<cases.length;i++){
 const c=cases[i],root=fs.mkdtempSync(path.join(os.tmpdir(),'review-t121-push-')),repo=path.join(root,'repo'),home=path.join(root,'home'),project=`00000000-0000-0000-0000-00000000e12${i}`,storeDir=path.join(home,'projects',project)
 fs.mkdirSync(path.join(repo,'tasks'),{recursive:true});fs.writeFileSync(path.join(repo,'mapctx.toml'),[
  'schemaVersion = 1',`projectId = "${project}"`,'plansAuthority = "store"','', '[github]','owner = "example"','repo = "mapctx"','projectId = "PVT_test"','statusFieldId = "PVTSSF_test"','', '[github.statusMap]','backlog = "Backlog"','ready-for-do = "Ready"','doing = "Doing"','review = "Review"','done = "Done"','paused = "Paused"',''
 ].join('\n'))
 process.env.MAPCTX_HOME=home
 let h=StoreHandle.open(storeDir)
 try{
  upsertProject(h.db,{projectId:project,boardTitle:'Review',workDomains:[{key:'CORE',description:'core'}],notesMarkdown:'',plansAuthority:'store',sourceSnapshotHash:null})
  const made=createTask(h,{id:'T-121',title:c.name,actor:'review',status:'review',workload:'Normal',detail:{estimatedEffort:'1h',summary:'repro'}});assert(made.ok)
  assert(reviseAcceptance(h,{taskId:'T-121',condition:'criteria',texts:c.canonical,actor:'review',expectRevision:0}).ok)
  const built=buildExport(h.db,{tasksRoot:repo});fs.writeFileSync(built.tasksMd.path,built.tasksMd.content);for(const f of built.taskDetailFiles)fs.writeFileSync(f.path,f.content)
  const dpath=path.join(repo,'tasks','T-121.md'),d=parseTaskDetailFile(fs.readFileSync(dpath,'utf8'));fs.writeFileSync(dpath,generateTaskDetailFile({...d,description:c.prose}))
 }finally{h.close()}
 const beforeTree=tree(repo),calls=[];let error=''
 const old=process.cwd();process.chdir(repo)
 gh.setGhRunnerForTests(args=>{calls.push(args);throw Error('unexpected external gh execution')})
 try{push.pushStoreCommand({})}catch(e){error=String(e.message||e)}finally{gh.setGhRunnerForTests(null);process.chdir(old)}
 const afterTree=tree(repo)
 results.push({case:c.name,refused:/acceptance-render-refused/.test(error),error,ghCalls:calls.length,repoUnchanged:JSON.stringify(beforeTree)===JSON.stringify(afterTree)})
 assert.match(error,/acceptance-render-refused/);assert.equal(calls.length,0);assert.deepEqual(afterTree,beforeTree)
 fs.rmSync(root,{recursive:true,force:true})
}
console.log(JSON.stringify({verdict:'PASS',results},null,2))
