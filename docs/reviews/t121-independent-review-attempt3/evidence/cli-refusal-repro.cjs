const fs=require('node:fs'), path=require('node:path'), child=require('node:child_process'), crypto=require('node:crypto')
const reviewCopy=process.env.MAPCTX_REVIEW_COPY
if (!reviewCopy) throw new Error('Set MAPCTX_REVIEW_COPY to the isolated current-dirty worktree copy')
const core=require(path.join(reviewCopy, 'packages/core/dist/task-detail.js'))
const store=require(path.join(reviewCopy, 'packages/store/dist/index.js'))
const {StoreHandle,upsertProject,createTask,reviseAcceptance,buildExport}=store
const {parseTaskDetailFile,generateTaskDetailFile}=core
const root=fs.mkdtempSync('/tmp/mapctx-t121-refusal-cli-'), repo=path.join(root,'repo'), home=path.join(root,'home')
const projectId='00000000-0000-0000-0000-00000000d122', storeDir=path.join(home,'projects',projectId)
fs.mkdirSync(path.join(repo,'tasks'),{recursive:true});fs.writeFileSync(path.join(repo,'mapctx.toml'),`schemaVersion = 1\nprojectId = "${projectId}"\nplansAuthority = "store"\n`)
let h=StoreHandle.open(storeDir)
try {
 upsertProject(h.db,{projectId,boardTitle:'T121 refusal repro',workDomains:[{key:'CORE',description:'core'}],notesMarkdown:'',plansAuthority:'store',sourceSnapshotHash:null})
 const created=createTask(h,{id:'T-122',title:'Refusal repro',actor:'review-test',status:'review',workload:'Normal',detail:{estimatedEffort:'1h',summary:'repro'}})
 if(!created.ok)throw new Error(JSON.stringify(created))
 const revision=reviseAcceptance(h,{taskId:'T-122',condition:'criteria',texts:['B.'],actor:'review-test',expectRevision:0})
 if(!revision.ok)throw new Error(JSON.stringify(revision))
 const initial=buildExport(h.db,{tasksRoot:repo}).taskDetailFiles[0]
 fs.writeFileSync(initial.path,initial.content)
 const d=parseTaskDetailFile(initial.content)
 fs.writeFileSync(initial.path,generateTaskDetailFile({...d,description:'## Acceptance\n- [x] Old criterion.\nEvidence for old criterion: docs/old.md\n- [x] B.'}))
} finally {h.close()}
function hashTree(dir){const result={};for(const name of fs.readdirSync(dir).sort()){const f=path.join(dir,name),st=fs.statSync(f);if(st.isDirectory())Object.assign(result,hashTree(f));else result[path.relative(dir,f)]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}return result}
function dbFacts(){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(storeDir,'mapctx.db'),{readOnly:true});const result={clock:db.prepare("select value_json from store_meta where key='logical_clock'").get().value_json,events:db.prepare('select count(*) n from event_log').get().n,checkpoints:db.prepare('select count(*) n from export_checkpoint').get().n};db.close();return result}
const beforeTree=hashTree(repo),beforeDb=dbFacts()
const cli=path.join(reviewCopy,'packages/sync-engine/dist/mapctx-cli.js')
const run=child.spawnSync(process.execPath,[cli,'export','--reason','manual','--json'],{cwd:repo,env:{...process.env,MAPCTX_HOME:home},encoding:'utf8'})
const afterTree=hashTree(repo),afterDb=dbFacts()
const result={exitStatus:run.status,stdout:run.stdout.trim().slice(0,600),stderr:run.stderr.trim().slice(0,600),repoBytesUnchanged:JSON.stringify(beforeTree)===JSON.stringify(afterTree),dbFactsBefore:beforeDb,dbFactsAfter:afterDb}
console.log(JSON.stringify(result,null,2))
if(run.status===0||!result.repoBytesUnchanged||JSON.stringify(beforeDb)!==JSON.stringify(afterDb))process.exitCode=1
