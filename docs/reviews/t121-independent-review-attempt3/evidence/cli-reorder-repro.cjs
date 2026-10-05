const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), child=require('node:child_process'), crypto=require('node:crypto')
const reviewCopy=process.env.MAPCTX_REVIEW_COPY
if (!reviewCopy) throw new Error('Set MAPCTX_REVIEW_COPY to the isolated current-dirty worktree copy')
const core=require(path.join(reviewCopy, 'packages/core/dist/task-detail.js'))
const store=require(path.join(reviewCopy, 'packages/store/dist/index.js'))
const {StoreHandle,upsertProject,createTask,reviseAcceptance,buildExport}=store
const {parseTaskDetailFile,generateTaskDetailFile}=core
const root=fs.mkdtempSync('/tmp/mapctx-t121-reorder-cli-')
const repo=path.join(root,'repo'),home=path.join(root,'home'),storeDir=path.join(home,'projects','00000000-0000-0000-0000-00000000d121')
fs.mkdirSync(path.join(repo,'tasks'),{recursive:true})
fs.writeFileSync(path.join(repo,'mapctx.toml'),`schemaVersion = 1\nprojectId = "00000000-0000-0000-0000-00000000d121"\nplansAuthority = "store"\n`)
let h=StoreHandle.open(storeDir)
try {
  upsertProject(h.db,{projectId:'00000000-0000-0000-0000-00000000d121',boardTitle:'T121 CLI Repro',workDomains:[{key:'CORE',description:'core'}],notesMarkdown:'',plansAuthority:'store',sourceSnapshotHash:null})
  const created=createTask(h,{id:'T-121',title:'Reorder association repro',actor:'review-test',status:'review',workload:'Normal',detail:{estimatedEffort:'1h',summary:'repro'}})
  if(!created.ok) throw new Error(JSON.stringify(created))
  const revise=reviseAcceptance(h,{taskId:'T-121',condition:'criteria',texts:['B.','A.'],actor:'review-test',expectRevision:0})
  if(!revise.ok) throw new Error(JSON.stringify(revise))
  const generated=buildExport(h.db,{tasksRoot:repo}).taskDetailFiles[0]
  fs.writeFileSync(generated.path,generated.content)
  const parsed=parseTaskDetailFile(generated.content)
  const prose='## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'
  fs.writeFileSync(generated.path,generateTaskDetailFile({...parsed,description:prose}))
} finally { h.close() }
const cli=path.join(reviewCopy,'packages/sync-engine/dist/mapctx-cli.js')
const run=child.spawnSync(process.execPath,[cli,'export','--reason','manual','--json'],{cwd:repo,env:{...process.env,MAPCTX_HOME:home},encoding:'utf8'})
const output=fs.readFileSync(path.join(repo,'tasks','T-121.md'),'utf8')
const description=parseTaskDetailFile(output).description
const evidenceAt=description.indexOf('Evidence for B')
const section=description.slice(description.indexOf('## Acceptance'),description.indexOf('## Acceptance')+220)
const result={exitStatus:run.status,stderr:run.stderr.slice(0,500),outputLines:section,criterionLines:section.match(/^- \[[ x]\] [AB]\.\s*$/gm),evidenceAfterA:section.indexOf('Evidence for B')>section.indexOf('- [ ] A.'),eventLogRows:(()=>{let c=require('node:sqlite');let db=new c.DatabaseSync(path.join(storeDir,'mapctx.db'),{readOnly:true});let x=db.prepare("select count(*) n from event_log where event_type='checkpoint.exported'").get().n;db.close();return x})(),repoPath:repo,homePath:home}
console.log(JSON.stringify(result,null,2))
if(run.status!==0 || !result.evidenceAfterA) process.exitCode=1
