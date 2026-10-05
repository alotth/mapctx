const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), child=require('node:child_process'), crypto=require('node:crypto')
const reviewCopy=process.env.MAPCTX_REVIEW_COPY
if (!reviewCopy) throw new Error('Set MAPCTX_REVIEW_COPY to isolated current-dirty worktree copy')
const core=require(path.join(reviewCopy,'packages/core/dist/task-detail.js'))
const store=require(path.join(reviewCopy,'packages/store/dist/index.js'))
const {StoreHandle,upsertProject,createTask,reviseAcceptance,buildExport}=store
const {parseTaskDetailFile,generateTaskDetailFile}=core
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
function tree(root){const out={};function walk(dir){for(const n of fs.readdirSync(dir).sort()){const p=path.join(dir,n),st=fs.statSync(p);if(st.isDirectory())walk(p);else out[path.relative(root,p)]=sha(fs.readFileSync(p))}}walk(root);return out}
const cases=[
 {name:'reorder A,B with trailing B evidence',criteria:['B.','A.'], prose:'## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'},
 {name:'add B after trailing A evidence',criteria:['A.','B.'], prose:'## Acceptance\n- [x] A.\nEvidence for A: docs/A.md'}
]
const results=[]
for(let i=0;i<cases.length;i++){
 const c=cases[i], root=fs.mkdtempSync(path.join(os.tmpdir(),'review-t121-cli-')), repo=path.join(root,'repo'), home=path.join(root,'home'), id=`00000000-0000-0000-0000-00000000d12${i}`
 fs.mkdirSync(path.join(repo,'tasks'),{recursive:true});fs.writeFileSync(path.join(repo,'mapctx.toml'),`schemaVersion = 1\nprojectId = "${id}"\nplansAuthority = "store"\n`)
 const storeDir=path.join(home,'projects',id);process.env.MAPCTX_HOME=home
 const h=StoreHandle.open(storeDir)
 try{
  upsertProject(h.db,{projectId:id,boardTitle:'Review T121',workDomains:[{key:'CORE',description:'core'}],notesMarkdown:'',plansAuthority:'store',sourceSnapshotHash:null})
  const made=createTask(h,{id:'T-121',title:c.name,actor:'review',status:'review',workload:'Normal',detail:{estimatedEffort:'1h',summary:'repro'}})
  if(!made.ok)throw Error(JSON.stringify(made))
  const revised=reviseAcceptance(h,{taskId:'T-121',condition:'criteria',texts:c.criteria,actor:'review',expectRevision:0})
  if(!revised.ok)throw Error(JSON.stringify(revised))
  const initial=buildExport(h.db,{tasksRoot:repo}).taskDetailFiles[0];fs.writeFileSync(initial.path,initial.content)
  const detail=parseTaskDetailFile(initial.content);fs.writeFileSync(initial.path,generateTaskDetailFile({...detail,description:c.prose}))
 }finally{h.close()}
 const dbPath=path.join(storeDir,'mapctx.db'), db=()=>{const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(dbPath,{readOnly:true});const f={clock:d.prepare("select value_json from store_meta where key='logical_clock'").get().value_json,events:d.prepare('select count(*) n from event_log').get().n,checkpoints:d.prepare('select count(*) n from export_checkpoint').get().n};d.close();return f}
 const beforeTree=tree(repo),beforeDb=db()
 const run=child.spawnSync(process.execPath,[path.join(reviewCopy,'packages/sync-engine/dist/mapctx-cli.js'),'export','--reason','manual','--json'],{cwd:repo,env:{...process.env,MAPCTX_HOME:home},encoding:'utf8'})
 const afterTree=tree(repo),afterDb=db();let result
 try{result=JSON.parse(run.stdout)}catch{result={parseError:true,stdout:run.stdout,stderr:run.stderr}}
 const unchanged=JSON.stringify(beforeTree)===JSON.stringify(afterTree)&&JSON.stringify(beforeDb)===JSON.stringify(afterDb)
 results.push({case:c.name,exitStatus:run.status,stage:result.stage,error:result.error,filesUnchanged:JSON.stringify(beforeTree)===JSON.stringify(afterTree),storeUnchanged:JSON.stringify(beforeDb)===JSON.stringify(afterDb),unchanged,dbBefore:beforeDb,dbAfter:afterDb,treeCount:Object.keys(beforeTree).length})
 if(run.status===0||result.stage!=='build'||!unchanged||!String(result.error).includes('acceptance-render-refused'))process.exitCode=1
 fs.rmSync(root,{recursive:true,force:true})
}
console.log(JSON.stringify({results},null,2))
