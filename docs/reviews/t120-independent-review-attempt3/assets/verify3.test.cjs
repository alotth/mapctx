const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const work=process.env.T120_REVIEW_DIR||__dirname,code=path.join(work,'code');const S=require(path.join(code,'packages/store/dist')),C=require(path.join(code,'packages/core/dist'));const K=require(path.join(code,'packages/sync-engine/dist/checkpoint')),B=require(path.join(code,'packages/sync-engine/dist/board-tools')),G=require(path.join(code,'packages/sync-engine/dist/github')),P=require(path.join(code,'packages/sync-engine/dist/push-store'));
const cli=path.join(code,'packages/sync-engine/dist/mapctx-cli.js');let n=0;const observations={};test.after(()=>fs.writeFileSync(path.join(work,'verify3-results.json'),JSON.stringify({... (fs.existsSync(path.join(work,'verify3-results.json'))?JSON.parse(fs.readFileSync(path.join(work,'verify3-results.json'),'utf8')):{}),...observations},null,2)));
function fixture(opts={}){const dir=path.join(work,'fixtures','r'+(++n)+'-'+crypto.randomUUID()),home=path.join(dir,'home'),repo=path.join(dir,'repo'),project=crypto.randomUUID();fs.mkdirSync(repo,{recursive:true});let previous=process.env.MAPCTX_HOME;process.env.MAPCTX_HOME=home;fs.writeFileSync(path.join(repo,'mapctx.toml'),`schemaVersion = 1\nprojectId = "${project}"\nplansAuthority = "store"\n[github]\nowner = "fixture"\nrepo = "fixture"\n[github.statusMap]\nbacklog = "Backlog"\nreview = "Review"\ndone = "Done"\n`);const storeDir=path.join(home,'projects',project),h=S.StoreHandle.open(storeDir);h.appendEvent({eventType:'project.initialized',actor:'review-fixture',payload:{projectId:project,boardTitle:'Review fixture',workDomains:[{key:'CORE',description:'core'}],notesMarkdown:'',plansAuthority:'store',sourceSnapshotHash:null}});assert.ok(S.createTask(h,{id:'T-001',title:'Review task',actor:'review-fixture',status:opts.status||'backlog',workload:'Normal',detail:{estimatedEffort:'1d'},...opts}).ok);fs.mkdirSync(path.join(repo,'tasks'));exportFiles(h,repo);return {h,repo,home,storeDir,close(){h.close();if(previous===undefined)delete process.env.MAPCTX_HOME;else process.env.MAPCTX_HOME=previous;}};}
function exportFiles(h,repo){const e=S.buildExport(h.db,{tasksRoot:repo});for(const f of [e.tasksMd,...e.taskDetailFiles])fs.writeFileSync(f.path,f.content);}
function run(f,args){return spawnSync(process.execPath,[cli,...args,'--json'],{cwd:f.repo,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});}
function reviseApprove(f,text='Current criterion'){let r=S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:[text],actor:'author',expectRevision:0});assert.ok(r.ok);assert.ok(S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,expectRevision:r.revision,actor:'reviewer',evidence:{uri:'proof://revision1'}}).ok);return r;}

const codes=(f)=>S.validateStoreRegime(f.repo).canonical.issues.map(x=>x.code+(x.taskId?':'+x.taskId:''));
const patch=(f,p,id='T-001')=>f.h.appendEvent({eventType:'task.patched',actor:'raw-fixture',payload:{taskId:id,patch:p}});
const sql=(f,q,...a)=>f.h.db.prepare(q).run(...a);

test('F1: null due/completed with startDate valid; both-present order errors; malformed no false order error',()=>{
 const out={};
 let f=fixture({startDate:'2026-01-01',status:'in-progress'});
 try{
  out.inProgressNullDates={codes:codes(f),cliExit:run(f,['validate']).status};
  assert.deepEqual(codes(f),[]);assert.equal(out.inProgressNullDates.cliExit,0);
  S.updateTask(f.h,{taskId:'T-001',patch:{dueDate:'2025-12-31'},actor:'a'});
  out.dueBeforeStart=codes(f);assert.deepEqual(out.dueBeforeStart,['due-before-start:T-001']);
  S.updateTask(f.h,{taskId:'T-001',patch:{dueDate:'2026-01-01'},actor:'a'});
  out.dueEqualsStart=codes(f);assert.deepEqual(out.dueEqualsStart,[]);
  S.updateTask(f.h,{taskId:'T-001',patch:{dueDate:'garbage'},actor:'a'});
  out.dueMalformedViaUpdate=codes(f);
  sql(f,"UPDATE task_projection SET due_date='garbage' WHERE task_id='T-001'");
  out.dueMalformedSql=codes(f);assert.deepEqual(out.dueMalformedSql,['invalid-due-date:T-001']);
  sql(f,"UPDATE task_projection SET due_date=NULL, start_date=NULL WHERE task_id='T-001'");
  out.startNullDueNull=codes(f);assert.deepEqual(out.startNullDueNull,[]);
  sql(f,"UPDATE task_projection SET due_date='2026-02-01', start_date=NULL WHERE task_id='T-001'");
  out.startNullDueSet=codes(f);assert.deepEqual(out.startNullDueSet,[]);
  sql(f,"UPDATE task_projection SET due_date=NULL, start_date=''  WHERE task_id='T-001'");
  out.startEmptyString=codes(f);
  sql(f,"UPDATE task_projection SET due_date='', start_date='2026-01-01'  WHERE task_id='T-001'");
  out.dueEmptyString=codes(f);
  sql(f,"UPDATE task_projection SET due_date=NULL, start_date='2026-13-45'  WHERE task_id='T-001'");
  out.impossibleStartDate=codes(f);
 }finally{f.close();}
 f=fixture({startDate:'2026-03-01',status:'review'});
 try{
  reviseApprove(f);assert.ok(S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x',now:()=>new Date('2026-02-01T00:00:00Z')}).ok);
  out.doneCompletedBeforeStart=codes(f);assert.deepEqual(out.doneCompletedBeforeStart,['completed-before-start:T-001']);
  sql(f,"UPDATE task_projection SET completed_on='2026-03-01' WHERE task_id='T-001'");
  out.doneCompletedEqualsStart=codes(f);assert.deepEqual(out.doneCompletedEqualsStart,[]);
  sql(f,"UPDATE task_projection SET completed_on='nope' WHERE task_id='T-001'");
  out.doneCompletedMalformed=codes(f);assert.deepEqual(out.doneCompletedMalformed,['invalid-completed-date:T-001']);
 }finally{f.close();}
 observations.F1=out;
});

test('T092 decision: done needs completedOn; archived/cancelled may be null, legacy date preserved+validated; nonterminal with date invalid; no mutation',()=>{
 const out={};
 let f=fixture({status:'review'});
 try{
  reviseApprove(f);
  assert.ok(S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'}).ok);
  out.doneViaMove={codes:codes(f),completedOn:S.getTask(f.h.db,'T-001').completedOn};assert.deepEqual(out.doneViaMove.codes,[]);assert.ok(out.doneViaMove.completedOn);
  sql(f,"UPDATE task_projection SET completed_on=NULL WHERE task_id='T-001'");
  out.doneNullCompleted=codes(f);assert.deepEqual(out.doneNullCompleted,['completion-date-missing:T-001']);
  sql(f,"UPDATE task_projection SET completed_on='2026-09-27' WHERE task_id='T-001'");
 }finally{f.close();}
 for(const to of ['cancelled','archived']){
  f=fixture({status:'backlog'});
  try{
   const mv=S.moveTask(f.h,{taskId:'T-001',to,actor:'x'});out[to+'Move']={ok:mv.ok,reason:mv.reason,message:mv.message};
   if(mv.ok){
    out[to+'NullCompleted']={codes:codes(f),completedOn:S.getTask(f.h.db,'T-001').completedOn,cliExit:run(f,['validate']).status};assert.deepEqual(out[to+'NullCompleted'].codes,[]);assert.equal(out[to+'NullCompleted'].cliExit,0);
    sql(f,"UPDATE task_projection SET completed_on='2026-09-27' WHERE task_id='T-001'");
    out[to+'LegacyDatePreserved']=codes(f);assert.deepEqual(out[to+'LegacyDatePreserved'],[]);
    sql(f,"UPDATE task_projection SET completed_on='bad' WHERE task_id='T-001'");
    out[to+'LegacyDateMalformed']=codes(f);assert.deepEqual(out[to+'LegacyDateMalformed'],['invalid-completed-date:T-001']);
    const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(f.storeDir,'mapctx.db'))).digest('hex');
    codes(f);
    out[to+'ValidateNoMutation']=hash===crypto.createHash('sha256').update(fs.readFileSync(path.join(f.storeDir,'mapctx.db'))).digest('hex');
   }
  }finally{f.close();}
 }
 f=fixture({status:'in-progress'});
 try{
  sql(f,"UPDATE task_projection SET completed_on='2026-01-01' WHERE task_id='T-001'");
  out.nonTerminalWithDate=codes(f);assert.deepEqual(out.nonTerminalWithDate,['completion-date-unexpected:T-001']);
 }finally{f.close();}
 f=fixture({status:'review'});
 try{
  reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});
  const date=S.getTask(f.h.db,'T-001').completedOn;
  const arch=S.moveTask(f.h,{taskId:'T-001',to:'archived',actor:'x'});out.doneToArchived={ok:arch.ok,reason:arch.reason,completedOn:S.getTask(f.h.db,'T-001').completedOn,preserved:S.getTask(f.h.db,'T-001').completedOn===date,codes:codes(f)};
  if(arch.ok){const re=S.reopenTask(f.h,{taskId:'T-001',to:'review',actor:'x'});out.reopenArchived={ok:re.ok,completedOn:S.getTask(f.h.db,'T-001').completedOn,codes:codes(f)};}
 }finally{f.close();}
 observations.T092=out;
});

test('F2: canonical validator covers applicable DB structural/date/domain/spec/state/type/title/ref/dependency checks (raw admission + SQL poison)',()=>{
 const out={};
 const second=(f)=>{S.createTask(f.h,{id:'T-002',title:'Second',actor:'a'});return 'T-002';};
 const cases={
  'missing-title':f=>sql(f,"UPDATE task_projection SET title='  ' WHERE task_id='T-001'"),
  'invalid-type':f=>sql(f,"UPDATE task_projection SET type='nonsense' WHERE task_id='T-001'"),
  'invalid-planning-state':f=>sql(f,"UPDATE task_projection SET planning_state='not-a-state' WHERE task_id='T-001'"),
  'invalid-execution-state':f=>sql(f,"UPDATE task_projection SET execution_state='not-an-exec' WHERE task_id='T-001'"),
  'invalid-specmode':f=>sql(f,"UPDATE task_projection SET spec_mode='nonsense' WHERE task_id='T-001'"),
  'invalid-domain':f=>sql(f,`UPDATE task_projection SET domains_json='["NO_SUCH_DOMAIN"]' WHERE task_id='T-001'`),
  'domains-without-work-domains':f=>{sql(f,"UPDATE project_projection SET work_domains_json='[]'");sql(f,`UPDATE task_projection SET domains_json='["CORE"]' WHERE task_id='T-001'`);},
  'invalid-start-date':f=>sql(f,"UPDATE task_projection SET start_date='yesterday' WHERE task_id='T-001'"),
  'invalid-due-date':f=>sql(f,"UPDATE task_projection SET due_date='soon' WHERE task_id='T-001'"),
  'invalid-updated-date':f=>sql(f,"UPDATE task_projection SET updated_on='x' WHERE task_id='T-001'"),
  'unknown-parent':f=>sql(f,"UPDATE task_projection SET parent_task_id='NOPE' WHERE task_id='T-001'"),
  'parent-cycle':f=>{second(f);sql(f,"UPDATE task_projection SET parent_task_id='T-002' WHERE task_id='T-001'");sql(f,"UPDATE task_projection SET parent_task_id='T-001' WHERE task_id='T-002'");},
  'self-parent-cycle':f=>sql(f,"UPDATE task_projection SET parent_task_id='T-001' WHERE task_id='T-001'"),
  'unknown-dependency':f=>sql(f,"INSERT INTO dependency_projection VALUES('T-001','T-999','depends-on')"),
  'unknown-dependency-source-depends':f=>sql(f,"INSERT INTO dependency_projection VALUES('T-999','T-001','depends-on')"),
  'unknown-dependency-source-blocks':f=>sql(f,"INSERT INTO dependency_projection VALUES('T-999','T-001','blocks')"),
  'unknown-dependency-blocks-target':f=>sql(f,"INSERT INTO dependency_projection VALUES('T-001','T-999','blocks')"),
  'unknown-dependency-kind':f=>{second(f);sql(f,"INSERT INTO dependency_projection VALUES('T-001','T-002','weird')");},
  'self-dependency':f=>sql(f,"INSERT INTO dependency_projection VALUES('T-001','T-001','depends-on')"),
  'dependency-cycle':f=>{second(f);sql(f,"INSERT INTO dependency_projection VALUES('T-001','T-002','depends-on')");sql(f,"INSERT INTO dependency_projection VALUES('T-002','T-001','depends-on')");},
  'epic-prefix':f=>sql(f,"UPDATE task_projection SET type='epic' WHERE task_id='T-001'"),
  'non-epic-prefix':f=>{S.createTask(f.h,{id:'E-001',type:'epic',title:'e',actor:'a'});sql(f,"UPDATE task_projection SET type='task' WHERE task_id='E-001'");},
  'external-id-format(old warning)':f=>sql(f,"UPDATE task_projection SET external_id='garbage' WHERE task_id='T-001'"),
  'empty-work-domains(old warning)':f=>sql(f,"UPDATE project_projection SET work_domains_json='[]'"),
 };
 for(const [name,mutate] of Object.entries(cases)){
  const f=fixture();
  try{ mutate(f); const r=S.validateStoreRegime(f.repo); out[name]=r.canonical.issues.map(x=>x.severity[0]+':'+x.code); }
  catch(e){ out[name]='THROW '+e.message; }
  finally{f.close();}
 }
 // admission-path (public CLI/update + raw events): what does the front door do with poison?
 const f=fixture();
 try{
  const adm={};
  const upd=run(f,['task','update','T-001','--set','dueDate=garbage','--set','domains=NO_SUCH_DOMAIN','--set','specMode=nonsense']);
  adm.cliUpdate={exit:upd.status,stderr:upd.stderr.slice(0,200)};adm.afterCliUpdate=codes(f);
  for(const [k,p] of Object.entries({planning:{planningState:'not-a-state'},execution:{executionState:'not-an-exec'},type:{type:'nonsense'},title:{title:''}})){
   try{patch(f,p);adm[k+'RawPatch']='ADMITTED';}catch(e){adm[k+'RawPatch']='REFUSED: '+e.message.slice(0,120);}
  }
  adm.afterRaw=codes(f);out.admission=adm;
 }finally{f.close();}
 observations.F2=out;
 for(const k of ['missing-title','invalid-type','invalid-planning-state','invalid-execution-state','invalid-specmode','invalid-domain','domains-without-work-domains','invalid-start-date','invalid-due-date','invalid-updated-date','unknown-parent','unknown-dependency','unknown-dependency-source-depends','unknown-dependency-source-blocks','unknown-dependency-kind','self-dependency','dependency-cycle'])
  assert.ok(Array.isArray(out[k])&&out[k].some(x=>x==='e:'+k||x.endsWith(':'+k.replace(/-depends|-blocks$/,''))),k+' => '+JSON.stringify(out[k]));
 assert.ok(out['parent-cycle'].some(x=>x==='e:parent-cycle'));assert.ok(out['self-parent-cycle'].some(x=>x==='e:parent-cycle'));
 assert.ok(out['epic-prefix'].includes('w:epic-prefix'));assert.ok(out['non-epic-prefix'].includes('w:non-epic-prefix'));
});

function writeProse(f,prose){const fp=path.join(f.repo,'tasks/T-001.md');const d=C.parseTaskDetailFile(fs.readFileSync(fp,'utf8'));fs.writeFileSync(fp,C.generateTaskDetailFile({...d,description:prose}));return fp;}
function readProse(fp){return C.parseTaskDetailFile(fs.readFileSync(fp,'utf8')).description;}

test('F3: fence-aware strip keeps Git prose; checkpoint bytes; idempotent; malformed fence edges documented',()=>{
 const out={};
 const cases={
  fencedExampleBeforeReal:'## Design\n\nExample syntax:\n```markdown\n## Acceptance\n- [x] Example ONLY\n```\n\nKEEP THIS DESIGN PARAGRAPH.\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES.',
  fencedOnlyNoRealSection:'## Design\n```md\n## Acceptance\n- [ ] not real\n```\nKEEP.',
  fencedHeadingInsideRealSection:'Intro\n\n## Acceptance\n- [ ] Canonical actual criterion\n```md\n## Notes\n- [ ] inside fence in section\n```\n- [ ] still in section\n\n## After\nKEEP AFTER.',
  nestedSubheadingInsideSection:'Intro\n\n## Acceptance\n- [ ] Canonical actual criterion\n### Sub detail\nprose inside acceptance\n\n## After\nKEEP AFTER.',
  tildeFence:'Intro\n~~~md\n## Acceptance\n- [ ] tilde example\n~~~\nKEEP TILDE TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  fourBacktickFence:'Intro\n````md\n```\n## Acceptance\n```\n````\nKEEP FOUR TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  indentedFence:'Intro\n  ```md\n## Acceptance\n- [ ] indented fence example\n  ```\nKEEP INDENT TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  unclosedFenceBeforeReal:'Intro\n```md\nunclosed example\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES.',
  inlineTripleBacktickLine:'Use ```code``` inline.\n```inline```\nKEEP AFTER INLINE.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  twoRealSections:'Intro\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Middle\nKEEP MIDDLE.\n\n## Acceptance\n- [ ] duplicate section',
  levelOneAcceptance:'Intro\n\n# Acceptance\n- [ ] Canonical actual criterion\n\n# Next\nKEEP NEXT.',
  crlf:'## Design\r\nKEEP CRLF.\r\n\r\n## Acceptance\r\n- [ ] Canonical actual criterion\r\n\r\n## Notes\r\nKEEP NOTES.',
 };
 for(const [name,prose] of Object.entries(cases)){
  const f=fixture();
  try{
   const fp=writeProse(f,prose);
   const parsed=C.parseAcceptanceChecklist(readProse(fp));
   const texts=parsed.items.length?parsed.items.map(i=>i.text):['Canonical actual criterion'];
   S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts,actor:'author',expectRevision:0});
   const before=readProse(fp);
   const c1=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});assert.ok(c1.ok);
   const after1=readProse(fp);const bytes1=fs.readFileSync(fp);
   const c2=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});assert.ok(c2.ok);
   const after2=readProse(fp);const bytes2=fs.readFileSync(fp);
   const stripped=C.stripAcceptanceSection(before);
   const prefixPreserved=after1.startsWith(stripped);
   const keeps=(before.match(/KEEP[A-Z ]*[A-Z.]/g)||[]);
   out[name]={parseFound:parsed.found,parseItems:parsed.items.length,keepMarkersBefore:keeps.length,keepMarkersAfter:keeps.filter(k=>after1.includes(k)).length,allKeepSurvive:keeps.every(k=>after1.includes(k)),prefixPreserved,idempotentBytes:Buffer.compare(bytes1,bytes2)===0,stableDescription:after1===after2,realAcceptanceHeadingsAfter:(after1.match(/^\s*#{1,6}\s+Acceptance\s*$/gim)||[]).length,after:after1};
  }catch(e){out[name]={error:e.message};}finally{f.close();}
 }
 observations.F3=out;
 for(const k of ['fencedExampleBeforeReal','fencedOnlyNoRealSection','fencedHeadingInsideRealSection','nestedSubheadingInsideSection','twoRealSections','levelOneAcceptance']){
  assert.ok(out[k].allKeepSurvive,k);assert.ok(out[k].idempotentBytes,k);
 }
 assert.ok(out.fencedExampleBeforeReal.after.includes('Example ONLY')&&out.fencedExampleBeforeReal.after.includes('KEEP THIS DESIGN PARAGRAPH'));
});

function pushBody(f){f.h.db.prepare('UPDATE task_projection SET external_id=NULL').run();let calls=[];G.setGhRunnerForTests(args=>{calls.push(args);if(args[0]==='api'&&args[1].includes('?state=all'))return '[]';if(args[0]==='api'&&args.includes('POST'))return JSON.stringify({number:1,node_id:'FIXTURE',title:'Review task',body:'',labels:[],state:'open',html_url:'https://example.invalid/1'});throw Error('Unexpected fake gh '+args.join(' '));});const old=process.cwd();process.chdir(f.repo);try{P.pushStoreCommand({});}finally{process.chdir(old);G.setGhRunnerForTests(null);}const b=calls.flat().find(x=>typeof x==='string'&&x.startsWith('body='));return {body:b?b.slice(5):null,calls:calls.length};}

test('F4: push body = Git prose + canonical Acceptance only; mocks only (no real gh)',()=>{
 const out={};
 // stale mirror vs canonical new revision, Git prose kept
 let f=fixture();
 try{
  const fp=writeProse(f,'## Design\nKEEP DESIGN PROSE.\n\n## Notes\nKEEP NOTES.');
  reviseApprove(f,'Old approved criterion');exportFiles(f.h,f.repo);
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['New pending criterion','Second new'],actor:'author',expectRevision:1});
  const {body,calls}=pushBody(f);
  out.staleMirrorCanonicalNew={calls,body};
  assert.ok(body.includes('- [ ] New pending criterion')&&body.includes('- [ ] Second new'));assert.ok(!body.includes('Old approved criterion'));assert.ok(body.includes('KEEP DESIGN PROSE')&&body.includes('KEEP NOTES'));
  assert.equal((body.match(/## Acceptance/g)||[]).length,1);
  // approve one in canonical, no export: push shows [x]
  S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,expectRevision:2,actor:'r'});
  out.approvedNoExport=pushBody(f).body;assert.ok(out.approvedNoExport.includes('- [x] New pending criterion'));
  // mirror deleted entirely -> no throw, canonical Acceptance absent because description===null
  fs.rmSync(fp);out.mirrorMissing=pushBody(f).body;
 }finally{f.close();}
 // empty condition and never revised
 f=fixture();
 try{
  writeProse(f,'## Design\nKEEP\n\n## Acceptance\n- [x] Legacy mirror claims done');
  out.neverRevisedMirrorStaleLegacy=pushBody(f).body;
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'empty',texts:[],actor:'a',expectRevision:0});
  out.emptyCondition=pushBody(f).body;
  assert.ok(!out.emptyCondition.includes('Legacy mirror claims done'));
 }finally{f.close();}
 // fenced example kept, real mirror section replaced
 f=fixture();
 try{
  writeProse(f,'Intro\n```md\n## Acceptance\n- [x] fenced example\n```\nKEEP TAIL\n\n## Acceptance\n- [x] stale mirror');
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['Canon'],actor:'a',expectRevision:0});
  out.fencedExample=pushBody(f).body;assert.ok(out.fencedExample.includes('fenced example')&&out.fencedExample.includes('KEEP TAIL')&&out.fencedExample.includes('- [ ] Canon')&&!out.fencedExample.includes('stale mirror'));
 }finally{f.close();}
 // dry-run + never invokes real gh: runner set; plus global PATH gh not executed (runner replaced)
 observations.F4=out;
});

const dumpProj=(db)=>{const t=['acceptance_revision_projection','acceptance_criterion_projection','task_projection'];const o={};for(const n of t)o[n]=db.prepare('SELECT * FROM '+n+' ORDER BY 1,2').all();return JSON.stringify(o);};
const journalCount=(dir)=>{const d=path.join(dir,'events');return fs.existsSync(d)?fs.readdirSync(d).filter(x=>x.endsWith('.json')).length:0;};

test('F5: raw acceptance.revised refuses approvedAt/approvedBy/evidence BEFORE journal; compose rollback; replay purity',()=>{
 const out={};
 const f=fixture();
 try{
  const r1=reviseApprove(f);const crit=S.getAcceptance(f.h.db,'T-001').criteria[0];
  const mkPayload=(extra)=>({taskId:'T-001',revision:2,condition:'criteria',criteria:[{criterionId:crypto.randomUUID(),revision:2,position:0,text:'Raw new',state:'pending',source:'authored',approvedAt:null,approvedBy:null,evidence:null,...extra}]});
  for(const [name,extra] of Object.entries({approvedAt:{approvedAt:'2026-10-05T00:00:00.000Z'},approvedBy:{approvedBy:'old-reviewer'},evidence:{evidence:{uri:'proof://old'}},carryAllFromOld:{approvedAt:crit.approvedAt,approvedBy:crit.approvedBy,evidence:crit.evidence},emptyStringApprovedBy:{approvedBy:''},stateApproved:{state:'approved'}})){
   const j0=journalCount(f.storeDir),e0=f.h.listEvents().length,p0=dumpProj(f.h.db);let refused=null;
   try{f.h.appendEvent({eventType:'acceptance.revised',actor:'raw',payload:mkPayload(extra)});}catch(e){refused=e.message.slice(0,140);}
   out[name]={refused,journalDelta:journalCount(f.storeDir)-j0,eventDelta:f.h.listEvents().length-e0,projectionUnchanged:dumpProj(f.h.db)===p0};
  }
  // undefined (omitted keys) fields must still be accepted as pending
  const omit=mkPayload({});delete omit.criteria[0].approvedAt;delete omit.criteria[0].approvedBy;delete omit.criteria[0].evidence;
  out.omittedKeysAccepted=(()=>{try{f.h.appendEvent({eventType:'acceptance.revised',actor:'raw',payload:omit});return true;}catch(e){return e.message;}})();
  // compose rollback: valid task.patched then invalid revise in ONE write transaction
  const j0=journalCount(f.storeDir),e0=f.h.listEvents().length,p0=dumpProj(f.h.db);let composeErr=null;
  try{f.h.runInWriteTransaction(append=>{append({eventType:'task.patched',actor:'x',payload:{taskId:'T-001',patch:{title:'Should roll back'}}});append({eventType:'acceptance.revised',actor:'raw',payload:{...mkPayload({approvedBy:'old'}),revision:3}});});}catch(e){composeErr=e.message.slice(0,120);}
  out.composeRollback={error:composeErr,journalDelta:journalCount(f.storeDir)-j0,eventDelta:f.h.listEvents().length-e0,projectionUnchanged:dumpProj(f.h.db)===p0,title:S.getTask(f.h.db,'T-001').title};
  // replay purity: historical poison event (pre-admission journal) must still replay; live == replayed
  const journal=require(path.join(code,'packages/store/dist/journal'));
  const last=f.h.listEvents().at(-1);
  const poison={taskId:'T-001',revision:last?S.getAcceptance(f.h.db,'T-001').revision+1:2,condition:'criteria',criteria:[{criterionId:crypto.randomUUID(),revision:S.getAcceptance(f.h.db,'T-001').revision+1,position:0,text:'Historic poison',state:'pending',source:'authored',approvedAt:'2026-01-01T00:00:00.000Z',approvedBy:'legacy',evidence:{uri:'proof://legacy'}}]};
  journal.writeJournalEntrySync(f.storeDir,{...last,sequence:last.sequence+1,logicalClock:last.logicalClock+1,eventType:'acceptance.revised',actor:'legacy',payload:poison,payloadSha256:journal.payloadSha256(poison)});
  f.h.close();
  const rep=S.repairStore(f.storeDir);
  const h2=S.StoreHandle.open(f.storeDir);
  const a=S.getAcceptance(h2.db,'T-001');
  out.replayHistoricalPoison={repair:rep.status,eventsReplayed:rep.eventsReplayed,revision:a.revision,carriedApprovedBy:a.criteria[0].approvedBy,carriedEvidence:a.criteria[0].evidence};
  const rep2=S.repairStore(f.storeDir);const h3=S.StoreHandle.open(f.storeDir);
  out.replayDeterministic={second:rep2.status,sameProjection:dumpProj(h2.db)===dumpProj(h3.db)};
  h2.close();h3.close();
 }finally{try{f.close();}catch{}}
 observations.F5=out;
 for(const k of ['approvedAt','approvedBy','evidence','carryAllFromOld','stateApproved']){assert.ok(out[k].refused,k);assert.equal(out[k].journalDelta,0);assert.equal(out[k].eventDelta,0);assert.ok(out[k].projectionUnchanged);}
 assert.equal(out.omittedKeysAccepted,true);
 assert.ok(out.composeRollback.error);assert.equal(out.composeRollback.journalDelta,0);assert.ok(out.composeRollback.projectionUnchanged);
});

test('F7: library expectRevision required at type+runtime; stale/absent -> no events (library, CLI, raw)',()=>{
 const out={};
 const f=fixture();
 try{
  const r=S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['A','B'],actor:'a',expectRevision:0});assert.ok(r.ok);
  const snap=()=>({events:f.h.listEvents().length,journal:journalCount(f.storeDir),proj:dumpProj(f.h.db)});
  const base=snap();
  const variants={undefinedRev:undefined,nullRev:null,nanRev:NaN,stringRev:'1',negative:-1,stale0:0,stale99:99};
  for(const [fn,call] of Object.entries({
    revise:(x)=>S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['C'],actor:'a',expectRevision:x}),
    approve:(x)=>S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,actor:'a',expectRevision:x}),
    approveById:(x)=>S.approveAcceptanceCriterion(f.h,{taskId:'T-001',criterionId:r.criteria[0].criterionId,actor:'a',expectRevision:x}),
    unapprove:(x)=>S.unapproveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,actor:'a',expectRevision:x}),
  })){
   out[fn]={};
   for(const [k,v] of Object.entries(variants)){let res;try{res=call(v);}catch(e){res={threw:e.message.slice(0,80)};}out[fn][k]={ok:res.ok,reason:res.reason,threw:res.threw};}
   out[fn].noEventsOrProjectionChange=JSON.stringify(snap())===JSON.stringify(base);
  }
  // correct revision works
  out.correct=S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,actor:'a',expectRevision:1}).ok;
  // raw stale events
  const crit=S.getAcceptance(f.h.db,'T-001').criteria[0];
  const b2=snap();out.rawStale={};
  for(const [name,payload,type] of [['approveStale',{taskId:'T-001',revision:0,criterionId:crit.criterionId,evidence:null,approvedAt:new Date().toISOString()},'acceptance.approved'],['unapproveStale',{taskId:'T-001',revision:7,criterionId:crit.criterionId},'acceptance.unapproved']]){try{f.h.appendEvent({eventType:type,actor:'raw',payload});out.rawStale[name]='ADMITTED';}catch(e){out.rawStale[name]='REFUSED '+e.message.slice(0,60);}}
  out.rawStale.noChange=JSON.stringify(snap())===JSON.stringify(b2);
  // CLI: missing / stale
  const b3=snap();
  fs.writeFileSync(path.join(f.repo,'src.md'),'## Acceptance\n- [ ] X\n');const cliCases={reviseNoExpect:['task','acceptance','revise','T-001','--from-file','src.md'],approveNoExpect:['task','acceptance','approve','T-001','--index','1'],unapproveNoExpect:['task','acceptance','unapprove','T-001','--index','0'],approveStale:['task','acceptance','approve','T-001','--index','1','--expect-revision','0'],unapproveStale:['task','acceptance','unapprove','T-001','--index','0','--expect-revision','9'],reviseStale:['task','acceptance','revise','T-001','--from-file','src.md','--expect-revision','0']};
  out.cli={};
  for(const [k,args] of Object.entries(cliCases)){const x=run(f,args);out.cli[k]={exit:x.status,msg:(x.stderr||x.stdout).trim().split('\n').slice(0,2).join(' | ').slice(0,160)};}
  out.cli.noChange=JSON.stringify(snap())===JSON.stringify(b3);
 }finally{f.close();}
 observations.F7=out;
 for(const fn of ['revise','approve','approveById','unapprove']){assert.ok(out[fn].noEventsOrProjectionChange,fn);assert.equal(out[fn].undefinedRev.ok,false);assert.equal(out[fn].undefinedRev.reason,'revision-conflict')}
 assert.ok(out.cli.noChange);for(const k of ['reviseNoExpect','approveNoExpect','unapproveNoExpect','approveStale','unapproveStale','reviseStale'])assert.notEqual(out.cli[k].exit,0,k);
});

const filesState=(f)=>{const r={};for(const p of ['TASKS.md','tasks/T-001.md']){const fp=path.join(f.repo,p);r[p]=crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');}r.tmpFiles=fs.readdirSync(f.repo).concat(fs.readdirSync(path.join(f.repo,'tasks'))).filter(x=>x.endsWith('.mapctx-tmp')).length;return r;};
const evCount=(f,type)=>f.h.listEvents().filter(e=>e.eventType===type).length;
const doneMoves=(f)=>f.h.listEvents().filter(e=>e.eventType==='task.patched'&&e.payload.patch&&e.payload.patch.planningState==='done').length;
// run `inject` once, exactly before the Nth write-transaction begins
function injectBeforeTx(f,n,inject){const old=f.h.runInWriteTransaction.bind(f.h);let c=0;f.h.runInWriteTransaction=fn=>{c++;if(c===n)inject();return old(fn);};}
// run `inject` once the first time the revision-capture SQL is prepared (between gate and capture)
function injectBeforeCapture(f,inject){const orig=f.h.db.prepare.bind(f.h.db);let done=false;const seen=[];f.h.db.prepare=sql=>{if(!done&&/SELECT revision FROM acceptance_revision_projection WHERE task_id = \?/.test(sql)){done=true;inject();}seen.push(sql.slice(0,80));return orig(sql);};return seen;}
const second=(f,fn)=>{const s=S.StoreHandle.open(f.storeDir);try{return fn(s);}finally{s.close();}};

test('F6: finish publication precondition inside the same writer tx, before FS writes (revise/reopen in every gap)',()=>{
 const out={};
 const scenarios={
  // retry-after-done path (tx #1 = publish)
  doneRetry_reviseBeforePublishTx:{status:'review',pre:(f)=>{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});},hook:(f,inj)=>injectBeforeTx(f,1,inj),inject:(f)=>second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'criteria',texts:['New pending in gap'],expectRevision:1,actor:'other'}))},
  doneRetry_reopenBeforePublishTx:{status:'review',pre:(f)=>{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});},hook:(f,inj)=>injectBeforeTx(f,1,inj),inject:(f)=>second(f,s=>S.reopenTask(s,{taskId:'T-001',to:'review',actor:'other'}))},
  doneRetry_reviseBetweenGateAndCapture:{status:'review',pre:(f)=>{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});},hook:(f,inj)=>{out._seen=injectBeforeCapture(f,inj);},inject:(f)=>second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'criteria',texts:['New pending between gate and capture'],expectRevision:1,actor:'other'}))},
  doneRetry_emptyReviseBetweenGateAndCapture:{status:'review',pre:(f)=>{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});},hook:(f,inj)=>injectBeforeCapture(f,inj),inject:(f)=>second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'empty',texts:[],expectRevision:1,actor:'other'}))},
  doneRetry_reopenBetweenGateAndCapture:{status:'review',pre:(f)=>{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});},hook:(f,inj)=>injectBeforeCapture(f,inj),inject:(f)=>second(f,s=>S.reopenTask(s,{taskId:'T-001',to:'review',actor:'other'}))},
  // first-time path (tx #1 = moveTask, tx #2 = publish)
  firstTime_reviseBeforePublishTx:{status:'review',pre:(f)=>{reviseApprove(f);},hook:(f,inj)=>injectBeforeTx(f,2,inj),inject:(f)=>second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'criteria',texts:['New pending after move'],expectRevision:1,actor:'other'}))},
  firstTime_reopenBeforePublishTx:{status:'review',pre:(f)=>{reviseApprove(f);},hook:(f,inj)=>injectBeforeTx(f,2,inj),inject:(f)=>second(f,s=>S.reopenTask(s,{taskId:'T-001',to:'review',actor:'other'}))},
  firstTime_reviseBetweenMoveAndCapture:{status:'review',pre:(f)=>{reviseApprove(f);},hook:(f,inj)=>injectBeforeCapture(f,inj),inject:(f)=>second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'criteria',texts:['New pending between move and capture'],expectRevision:1,actor:'other'}))},
 };
 for(const [name,sc] of Object.entries(scenarios)){
  const f=fixture({status:sc.status});
  try{
   sc.pre(f);exportFiles(f.h,f.repo);
   const before={files:filesState(f),ckpt:evCount(f,'checkpoint.exported'),journal:journalCount(f.storeDir)};
   sc.hook(f,()=>sc.inject(f));
   const doneBefore=doneMoves(f);
   const res=K.finishTask(f.h,f.repo,{taskId:'T-001',actor:'finisher'});
   const after={files:filesState(f),ckpt:evCount(f,'checkpoint.exported')};
   const state=S.getTask(f.h.db,'T-001').planningState,acc=S.getAcceptance(f.h.db,'T-001');
   out[name]={result:{ok:res.ok,stage:res.stage,move:res.move,checkpointStage:res.checkpoint&&res.checkpoint.stage,checkpointOk:res.checkpoint&&res.checkpoint.ok,error:(res.checkpoint&&res.checkpoint.error||'').slice(0,160),published:(res.checkpoint&&res.checkpoint.publishedFiles||[]).length},finalPlanningState:state,finalAcceptanceRevision:acc.revision,gateOkNow:S.checkTaskAcceptance(f.h.db,'T-001').ok,checkpointEventsAdded:after.ckpt-before.ckpt,filesUnchanged:JSON.stringify(after.files)===JSON.stringify(before.files),doneMovesTotal:doneMoves(f),doneMovesBefore:doneBefore};
   if(!res.ok){
    // re-approve if reverted to pending, then retry; must publish exactly once, no duplicate done move
    f.h.runInWriteTransaction=Object.getPrototypeOf(f.h).runInWriteTransaction.bind(f.h);
    const cur=S.getAcceptance(f.h.db,'T-001');
    if(S.getTask(f.h.db,'T-001').planningState!=='done'){
     if(cur.condition==='criteria'){S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,expectRevision:cur.revision,actor:'reviewer'});}
    }
    const retry=K.finishTask(f.h,f.repo,{taskId:'T-001',actor:'finisher'});
    out[name].retry={ok:retry.ok,stage:retry.stage,movePerformed:retry.move&&retry.move.performed,gateStage:retry.move&&retry.move.reason,doneMovesTotal:doneMoves(f),checkpointEvents:evCount(f,'checkpoint.exported')};
   }
  }catch(e){out[name]={error:e.message};}finally{try{f.close();}catch{}}
 }
 // manual export has no done guard and works on non-done tasks
 {const f=fixture({status:'backlog'});try{const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});out.manualExportBacklog={ok:c.ok,reason:c.reason};const x=run(f,['export']);out.manualExportCli={exit:x.status};}finally{f.close();}}
 // no FS writes when moveTask refuses on gate
 {const f=fixture({status:'review'});try{S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['Pending'],actor:'a',expectRevision:0});exportFiles(f.h,f.repo);const b=filesState(f);const r=K.finishTask(f.h,f.repo,{taskId:'T-001',actor:'finisher'});out.moveGateRefusalNoWrites={ok:r.ok,stage:r.stage,reason:r.move&&r.move.reason,filesUnchanged:JSON.stringify(filesState(f))===JSON.stringify(b),ckpt:evCount(f,'checkpoint.exported')};}finally{f.close();}}
 observations.F6=out;
 for(const name of Object.keys(scenarios)){const o=out[name];assert.ok(!o.error,name+': '+o.error);assert.equal(o.result.ok,false,name);assert.equal(o.result.checkpointStage,'precondition',name);assert.equal(o.checkpointEventsAdded,0,name);assert.ok(o.filesUnchanged,name);assert.equal(o.result.published,0,name);}
});

test('F6b: unapprove in gap refused; checkpoint cursor/revisions/hashes from one consistent locked read; concurrent writer cannot interleave publication',()=>{
 const out={};
 {const f=fixture({status:'review'});try{reviseApprove(f);S.moveTask(f.h,{taskId:'T-001',to:'done',actor:'x'});exportFiles(f.h,f.repo);const b=filesState(f);injectBeforeTx(f,1,()=>second(f,s=>S.unapproveAcceptanceCriterion(s,{taskId:'T-001',index:0,expectRevision:1,actor:'other'})));const r=K.finishTask(f.h,f.repo,{taskId:'T-001',actor:'finisher'});out.unapproveInGap={ok:r.ok,stage:r.checkpoint&&r.checkpoint.stage,filesUnchanged:JSON.stringify(filesState(f))===JSON.stringify(b),ckpt:evCount(f,'checkpoint.exported'),error:(r.checkpoint&&r.checkpoint.error||'').slice(0,120)};assert.equal(r.ok,false);assert.equal(r.checkpoint.stage,'precondition');}finally{f.close();}}
 {const f=fixture({status:'review'});try{
  reviseApprove(f);S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['Rev2 criterion'],actor:'a',expectRevision:1});S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,expectRevision:2,actor:'r'});
  const lastBefore=f.h.listEvents().at(-1);
  const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});assert.ok(c.ok);
  const cp=S.listExportCheckpoints(f.h.db).at(-1);
  const onDisk={};for(const p of ['TASKS.md','tasks/T-001.md'])onDisk[p]=crypto.createHash('sha256').update(fs.readFileSync(path.join(f.repo,p))).digest('hex');
  const detail=fs.readFileSync(path.join(f.repo,'tasks/T-001.md'),'utf8');
  out.consistentRead={cursorMatchesLastPriorEvent:cp.eventCursor.node===lastBefore.nodeId&&cp.eventCursor.sequence===lastBefore.sequence,filesHashMatchesDisk:JSON.stringify(cp.filesHash)===JSON.stringify(onDisk),revisionInPayload:cp.sourceState&&cp.sourceState.acceptanceRevisions,mirrorGuardsRevision:(detail.match(/acceptance revision (\d+)/)||[])[1],mirrorCriterionApproved:/- \[x\] Rev2 criterion/.test(detail)};
  assert.ok(out.consistentRead.cursorMatchesLastPriorEvent&&out.consistentRead.filesHashMatchesDisk);assert.equal(String(out.consistentRead.revisionInPayload['T-001']),out.consistentRead.mirrorGuardsRevision);
  // concurrent writer during publication must not interleave: second connection blocked by BEGIN IMMEDIATE
  const old=fs.renameSync;let attempt=null,t0=0;fs.renameSync=(a,b)=>{if(attempt===null&&String(b).endsWith('TASKS.md')){t0=Date.now();attempt='pending';try{second(f,s=>S.reviseAcceptance(s,{taskId:'T-001',condition:'criteria',texts:['Interleaved writer'],expectRevision:2,actor:'other'}));attempt='WRITE SUCCEEDED';}catch(e){attempt='BLOCKED: '+e.message.slice(0,60);}}return old(a,b);};
  try{K.publishCheckpoint(f.h,f.repo,{reason:'manual'});}finally{fs.renameSync=old;}
  out.noInterleave={attempt,waitedMs:Date.now()-t0,revisionAfter:S.getAcceptance(f.h.db,'T-001').revision};
 }finally{f.close();}}
 observations.F6b=out;
});

test('consumers: show/context/search/plan/board/gantt/validate identical with absent or malicious mirrors; routine mutations never regenerate mirrors',()=>{
 const out={};
 const f=fixture({status:'ready'});
 try{
  reviseApprove(f);
  const base=path.dirname(f.repo);
  const mk=(name,files)=>{const d=path.join(base,name);fs.mkdirSync(d);fs.copyFileSync(path.join(f.repo,'mapctx.toml'),path.join(d,'mapctx.toml'));for(const [p,c] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(d,p)),{recursive:true});fs.writeFileSync(path.join(d,p),c);}return d;};
  const dirs={A:f.repo,B:mk('B',{}),C:mk('C',{'TASKS.md':'## Tasks\n### T-001 Poisoned\n  - status: done\n  - completed: 1999-01-01\n  - dependsOn: [T-404]\n','tasks/T-001.md':'# T-001\n  - description: |\n      ## Acceptance\n      - [x] poisoned approval\n'})};
  const norm=x=>x.replace(/"tasksFilePath": "[^"]+"/g,'"tasksFilePath": "P"').replace(/"estimateId": "[^"]+"/g,'"estimateId": "U"').replace(/"generatedAt": "[^"]+"/g,'"generatedAt": "X"').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'TS');const cmds={show:['task','show','T-001'],context:['task','context','T-001','--budget','2000'],search:['task','search','--query','review'],plan:['plan'],board:['board'],gantt:['gantt'],validate:['validate']};
  const results={};
  for(const [n,args] of Object.entries(cmds)){results[n]={};for(const [d,dir] of Object.entries(dirs)){const x=spawnSync(process.execPath,[cli,...args,'--json'],{cwd:dir,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});results[n][d]={exit:x.status,out:x.stdout,err:x.stderr.slice(0,200)};}
   fs.mkdirSync(path.join(work,'consumer-outputs'),{recursive:true});for(const d of ['A','B','C'])fs.writeFileSync(path.join(work,'consumer-outputs',n+'.'+d+'.json'),results[n][d].out);out[n]={sample:(n==='show'||n==='plan'||n==='context'||n==='gantt')?{A:results[n].A.out.slice(0,500),B:results[n].B.out.slice(0,500),C:results[n].C.out.slice(0,500)}:undefined,exits:Object.fromEntries(Object.entries(results[n]).map(([d,v])=>[d,v.exit])),identicalABC:norm(results[n].A.out)===norm(results[n].B.out)&&norm(results[n].B.out)===norm(results[n].C.out),identicalAB_raw:results[n].A.out===results[n].B.out};}
  // routine mutations from the mirror-less dir B must not create/modify mirrors anywhere
  const hashTree=(d)=>JSON.stringify(fs.readdirSync(d,{recursive:true}).sort().map(p=>{const fp=path.join(d,p);return fs.statSync(fp).isFile()?[p,crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')]:[p];}));
  const before={A:hashTree(dirs.A),B:hashTree(dirs.B),C:hashTree(dirs.C)};
  const mut={};const rb=(args,dir=dirs.B)=>{const x=spawnSync(process.execPath,[cli,...args,'--json'],{cwd:dir,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});return {exit:x.status,tail:(x.stdout||x.stderr).slice(0,140).replace(/\s+/g,' ')};};
  mut.update=rb(['task','update','T-001','--set','title=Renamed from mirrorless dir']);
  mut.start=rb(['task','start','T-001','--actor','review']);
  const startOut=JSON.parse(spawnSync(process.execPath,[cli,'task','show','T-001','--json'],{cwd:dirs.B,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'}).stdout||'{}');
  mut.moveReview=rb(['task','move','T-001','--to','review']);
  out.mutations=mut;out.noRegeneration={A:hashTree(dirs.A)===before.A,B:hashTree(dirs.B)===before.B,C:hashTree(dirs.C)===before.C};
  out.canonicalTitleAfter=S.getTask(f.h.db,'T-001').title;
  // explicit export is the only thing that writes mirrors
  const ex=rb(['export']);out.explicitExport={exit:ex.exit,wroteTasksMdInB:fs.existsSync(path.join(dirs.B,'TASKS.md'))};
 }finally{f.close();}
 observations.consumers=out;for(const n of ['show','context','search','plan','board','gantt','validate'])assert.ok(out[n].identicalABC,n);assert.ok(out.noRegeneration.A&&out.noRegeneration.B&&out.noRegeneration.C);
});

test('export into checkout without tasks/ dir: reported partial publication (observation)',()=>{
 const f=fixture({status:'backlog'});
 try{
  const d=path.join(path.dirname(f.repo),'NOTASKSDIR');fs.mkdirSync(d);fs.copyFileSync(path.join(f.repo,'mapctx.toml'),path.join(d,'mapctx.toml'));
  const x=spawnSync(process.execPath,[cli,'export','--json'],{cwd:d,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});
  const evBefore=evCount(f,'checkpoint.exported');
  observations.exportNoTasksDir={exit:x.status,stdout:x.stdout.slice(0,600),stderr:x.stderr.slice(0,300),files:fs.readdirSync(d),checkpointEvents:evCount(f,'checkpoint.exported'),tmpLeft:fs.readdirSync(d).filter(n=>n.endsWith('.mapctx-tmp')).length};
 }finally{f.close();}
});

// ---------- attempt 3: N1 tokenizer, independent reference oracle (NOT the old backtick-only one) ----------
function refAnalyze(prose){
 const lines=prose.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
 const ws=c=>c===' '||c==='\t';
 const lead=l=>{let i=0;while(i<l.length&&ws(l[i]))i++;return i;};
 const run=(l,i,ch)=>{let n=0;while(l[i+n]===ch)n++;return n;};
 const opener=l=>{const i=lead(l),ch=l[i];if(ch!=='`'&&ch!=='~')return null;const n=run(l,i,ch);if(n<3)return null;if(ch==='`'&&l.slice(i+n).indexOf('`')>=0)return null;return {ch,n};};
 const closes=(l,f)=>{const i=lead(l);if(l[i]!==f.ch)return false;const n=run(l,i,f.ch);return n>=f.n&&l.slice(i+n).split('').every(ws);};
 const heading=l=>{const i=lead(l);const n=run(l,i,'#');if(n<1||n>6)return null;if(!ws(l[i+n]))return null;const t=l.slice(i+n).trim();return t===''?null:{level:n,title:t.toLowerCase()};};
 const bullet=l=>{const i=lead(l);if('-*+'.indexOf(l[i])<0||l[i]===undefined||!ws(l[i+1]))return null;let r=l.slice(i+1).replace(/^[ \t]+/,'').replace(/[ \t]+$/,'');let m=/^\[([ xX])\][ \t]+(.+)$/.exec(r);if(m)return {text:m[2].trim(),completed:m[1].toLowerCase()==='x'};return {text:r.trim(),completed:false};};
 const kept=[],items=[];let lvl=null,found=false,closedFirst=false,f=null,fenceOutside=false,unterminated=false;
 for(const l of lines){
  if(f){if(closes(l,f)){f=null;}if(lvl===null)kept.push(l);continue;}
  const o=opener(l);if(o){f=o;fenceOutside=lvl===null;if(lvl===null)kept.push(l);continue;}
  const h=heading(l);
  if(h){
   if(lvl!==null){if(h.level<=lvl){lvl=null;closedFirst=true;if(h.title==='acceptance'){lvl=h.level;found=true;continue;}kept.push(l);}continue;}
   if(h.title==='acceptance'){lvl=h.level;found=true;continue;}
   kept.push(l);continue;
  }
  if(lvl===null){kept.push(l);continue;}
  if(!closedFirst){const b=bullet(l);if(b)items.push(b);}
 }
 if(f&&fenceOutside)unterminated=true;
 while(kept.length&&kept[kept.length-1]==='')kept.pop();
 return {kept:kept.join('\n'),items,found,unterminated};
}

test('N1 property: shared analyzer vs independent NEW-semantics reference (20000 random docs) + render round-trip',()=>{
 let seed=987654321;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 const vocab=['','text line','## Acceptance','### Acceptance','# Acceptance','## Other','### Sub','#### Deep','- [ ] item','- [x] done','- plain bullet','```','```md','```js','~~~','~~~md','````','````md','~~~~','      ```','   ~~~','``` trailing','```x```','prose ```inline``` code','`````','## ACCEPTANCE','##   Acceptance  ','####### seven','\t```','   ````md'];
 const n=20000;let mism=0,idem=0,sub=0,roundtripBad=0,unt=0,ex=[];
 for(let i=0;i<n;i++){
  const len=1+Math.floor(rnd()*16);const lines=[];for(let j=0;j<len;j++)lines.push(vocab[Math.floor(rnd()*vocab.length)]);
  const doc=lines.join(i%7===0?'\r\n':'\n');
  const a=C.analyzeAcceptanceProse(doc),r=refAnalyze(doc);
  if(a.keptLines.join('\n')!==r.kept||a.found!==r.found||a.unterminatedFence!==r.unterminated||JSON.stringify(a.items)!==JSON.stringify(r.items)){mism++;if(ex.length<3)ex.push(doc);}
  // wrappers consistent with analyzer
  if(C.stripAcceptanceSection(doc)!==r.kept||C.parseAcceptanceChecklist(doc).found!==r.found||C.hasUnterminatedFence(doc)!==r.unterminated)mism++;
  if(r.unterminated){unt++;continue;}
  if(C.stripAcceptanceSection(r.kept)!==r.kept)idem++;
  // render round-trip as export does: strip + generated section; re-analysis must see exactly 1 section, same items, same kept prose
  const rendered=C.renderAcceptanceSection([{text:'Canon A',completed:false},{text:'Canon B',completed:true}],3);
  const out=r.kept?r.kept+'\n\n'+rendered:rendered;
  const b=C.analyzeAcceptanceProse(out);
  if(b.keptLines.join('\n')!==r.kept||!b.found||b.unterminatedFence||b.items.map(x=>x.text+x.completed).join('|')!=='Canon Afalse|Canon Btrue')roundtripBad++;
 }
 observations.N1property={cases:n,unterminatedCases:unt,mismatchesVsNewReference:mism,nonIdempotentStrip:idem,renderRoundTripBad:roundtripBad,examples:ex};
 assert.equal(mism,0);assert.equal(idem,0);assert.equal(roundtripBad,0);
});

test('N1 named cases via real checkpoint export: markers survive, deterministic bytes, single generated section',()=>{
 const out={};
 const cases={
  tilde:'Intro\n~~~md\n## Acceptance\n- [x] tilde example\n~~~\nKEEP TILDE TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES.',
  fourBacktick:'Intro\n````md\n```\n## Acceptance\n```\n````\nKEEP FOUR TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  longerCloser:'Intro\n```md\n## Acceptance\n- [x] ex\n`````\nKEEP LONGER CLOSER TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  mismatchTildeInsideBacktick:'Intro\n```md\n~~~\n## Acceptance\n~~~\n```\nKEEP MISMATCH TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  deepIndented:'Intro\n        ```md\n## Acceptance\n- [x] deep indented example\n        ```\nKEEP DEEP TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  fenceInList:'- step one\n  ```bash\n  ## Acceptance\n  run\n  ```\nKEEP LIST TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  closerWithTrailingWs:'Intro\n```md\n## Acceptance\n```   \nKEEP TRAILING WS TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  inlineTripleBacktick:'Use it like:\n```npm test```\nKEEP INLINE TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion',
  fullClosedNoHeading:'Intro\n```md\n## Acceptance\n- [x] only fenced\n```\nKEEP ONLY FENCED.',
  crlf:'## Design\r\nKEEP CRLF.\r\n~~~\r\n## Acceptance\r\n~~~\r\n\r\n## Acceptance\r\n- [ ] Canonical actual criterion\r\n\r\n## Notes\r\nKEEP NOTES.',
  fenceInsideSectionClosed:'Intro\n\n## Acceptance\n- [ ] Canonical actual criterion\n```md\n## Notes\nin-section fenced\n```\n- [ ] still in section\n\n## After\nKEEP AFTER.',
 };
 for(const [name,prose] of Object.entries(cases)){
  const f=fixture();
  try{
   const fp=writeProse(f,prose);const before=readProse(fp);
   const a=C.analyzeAcceptanceProse(before);
   S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:a.items.length?a.items.map(i=>i.text):['Canonical actual criterion'],actor:'author',expectRevision:0});
   const hashes=[],sizes=[];let ok=true;
   for(let i=0;i<4;i++){const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});ok=ok&&c.ok;hashes.push(crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').slice(0,12));sizes.push(fs.statSync(fp).size);}
   const after=readProse(fp);const an=C.analyzeAcceptanceProse(after);
   const keeps=(before.match(/KEEP[A-Z ]*[A-Z.]/g)||[]);
   const snap=spawnSync(process.execPath,[cli,'validate','--snapshots','--json'],{cwd:f.repo,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});
   out[name]={exportsOk:ok,sizes,stable:new Set(hashes).size===1,allKeepSurvive:keeps.every(k=>after.includes(k)),keepCount:keeps.length,keptProseExact:an.keptLines.join('\n')===C.stripAcceptanceSection(before),generatedSections:(after.match(/mapctx:store-owned acceptance revision/g)||[]).length,realSections:an.found?1:0,itemsAfter:an.items.length,snapshotsExit:snap.status};
  }catch(e){out[name]={error:e.message};}finally{f.close();}
 }
 observations.N1named=out;
 for(const [k,v] of Object.entries(out)){assert.ok(!v.error,k+': '+v.error);assert.ok(v.exportsOk,k);assert.ok(v.stable,k);assert.ok(v.allKeepSurvive,k);assert.ok(v.keptProseExact,k);assert.equal(v.snapshotsExit,0,k);assert.equal(v.generatedSections,1,k);}
});

const dbHash=(f)=>crypto.createHash('sha256').update(fs.readFileSync(path.join(f.storeDir,'mapctx.db'))).digest('hex');
function snapState(f){return JSON.stringify({events:f.h.listEvents().length,journal:journalCount(f.storeDir),files:filesState(f)});}

test('N1 refusal: unterminated fence OUTSIDE owned section refuses before any write; stable x4; snapshots honest read-only; repair then export ok; no-canonical unaffected',()=>{
 const out={};
 const bad='Intro\n```md\nunclosed example\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES.';
 // with canonical revision
 let f=fixture();
 try{
  const fp=writeProse(f,bad);const bytes0=fs.readFileSync(fp);
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['Canonical actual criterion'],actor:'author',expectRevision:0});
  const s0=snapState(f);const rs=[];
  for(let i=0;i<4;i++){const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});rs.push({ok:c.ok,stage:c.stage,refused:/acceptance-render-refused/.test(c.error||''),published:(c.publishedFiles||[]).length,state:snapState(f)===s0});}
  out.canonicalRefusal={results:rs,proseBytesUnchanged:Buffer.compare(fs.readFileSync(fp),bytes0)===0,tmpLeft:filesState(f).tmpFiles,checkpointEvents:evCount(f,'checkpoint.exported')};
  // CLI export exit + message
  const ex=run(f,['export']);out.cliExport={exit:ex.status,err:ex.stderr.slice(0,120),stdoutRefused:/acceptance-render-refused/.test(ex.stdout)};
  // explicit snapshots: honest, read-only, not crash
  const h0=dbHash(f);const sn=spawnSync(process.execPath,[cli,'validate','--snapshots','--json'],{cwd:f.repo,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});
  out.snapshotsAfterRefusal={exit:sn.status,mentionsRefusal:/acceptance-render-refused|snapshot comparison refused/.test(sn.stdout+sn.stderr),crash:/TypeError|at .*\.js:\d+/.test(sn.stderr),dbReadOnly:h0===dbHash(f),canonicalStillOk:JSON.parse(sn.stdout||'{}').store?.canonical?.errors===0,excerpt:(sn.stdout.match(/snapshot comparison refused[^"]{0,200}/)||[''])[0]};
  const def=run(f,['validate']);out.defaultValidateAfterRefusal={exit:def.status};
  // finish for the same task: done persists, checkpoint refused at build stage, no false checkpoint
  // repair the prose (close the fence) -> export ok -> snapshot pass
  fs.writeFileSync(fp,C.generateTaskDetailFile({...C.parseTaskDetailFile(fs.readFileSync(fp,'utf8')),description:bad.replace('unclosed example','unclosed example\n```')}));
  const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});const sn2=spawnSync(process.execPath,[cli,'validate','--snapshots','--json'],{cwd:f.repo,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'});
  const c2=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});
  out.afterRepair={exportOk:c.ok,snapshotsExit:sn2.status,secondExportSameHashes:JSON.stringify(c.files)===JSON.stringify(c2.files),sections:(readProse(fp).match(/mapctx:store-owned acceptance revision/g)||[]).length};
 }finally{f.close();}
 // without canonical revision: no refusal, Git bytes preserved
 f=fixture();
 try{
  const fp=writeProse(f,bad);const before=fs.readFileSync(fp);
  const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});
  out.noCanonical={ok:c.ok,proseBytesSame:Buffer.compare(fs.readFileSync(fp),before)===0,snapshotsExit:spawnSync(process.execPath,[cli,'validate','--snapshots','--json'],{cwd:f.repo,env:{...process.env,MAPCTX_HOME:f.home},encoding:'utf8'}).status};
  // empty condition + unterminated (export renders empty section -> refused?)
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'empty',texts:[],actor:'a',expectRevision:0});
  const c3=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});out.emptyConditionUnterminated={ok:c3.ok,refused:/acceptance-render-refused/.test(c3.error||'')};
 }finally{f.close();}
 observations.N1refusal=out;
 assert.ok(out.canonicalRefusal.results.every(r=>!r.ok&&r.refused&&r.published===0&&r.state));assert.ok(out.canonicalRefusal.proseBytesUnchanged);assert.equal(out.canonicalRefusal.checkpointEvents,0);
 assert.equal(out.noCanonical.ok,true);assert.ok(out.noCanonical.proseBytesSame);
 assert.ok(out.afterRepair.exportOk&&out.afterRepair.snapshotsExit===0&&out.afterRepair.secondExportSameHashes&&out.afterRepair.sections===1);
});

test('N1 ownership pathologies: unclosed fence INSIDE owned section, adjacent cases',()=>{
 const out={};
 const mk=(name,prose,texts)=>{
  const f=fixture();
  try{
   const fp=writeProse(f,prose);const an=C.analyzeAcceptanceProse(prose);
   S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:texts||(an.items.length?an.items.map(i=>i.text):['Canon']),actor:'a',expectRevision:0});
   const c=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});const after=readProse(fp);const c2=K.publishCheckpoint(f.h,f.repo,{reason:'manual'});
   const keeps=(prose.match(/KEEP[A-Z ]*[A-Z.]/g)||[]);
   out[name]={unterminatedFlag:an.unterminatedFence,exportOk:c.ok,refused:/acceptance-render-refused/.test(c.error||''),lostMarkers:keeps.filter(k=>!after.includes(k)),deterministic:c.ok&&c2.ok&&JSON.stringify(c.files)===JSON.stringify(c2.files),afterTail:after.slice(-260)};
  }catch(e){out[name]={error:e.message};}finally{f.close();}
 };
 mk('unclosedInsideSection_siblingHeadingAfter','Intro KEEP INTRO.\n\n## Acceptance\n- [ ] Canon\n```md\nforgot to close\n\n## Notes\nKEEP SIBLING NOTES AFTER UNCLOSED.\n\n## Design\nKEEP DESIGN AFTER UNCLOSED.');
 mk('unclosedInsideSection_atEnd','Intro KEEP INTRO.\n\n## Acceptance\n- [ ] Canon\n```md\nforgot to close');
 mk('unclosedOpenerInKeptTailAfterSection','Intro KEEP INTRO.\n\n## Acceptance\n- [ ] Canon\n\n## Notes\nKEEP NOTES.\n```bash\nnever closed KEEP TAIL.');
 mk('acceptanceNestedHeadingInsideFenceInsideSection','Intro KEEP INTRO.\n\n## Acceptance\n- [ ] Canon\n~~~\n## After\n~~~\n\n## After\nKEEP AFTER.');
 mk('criterionTextWithFence','Intro KEEP INTRO.\n\n## Acceptance\n- [ ] Canon ```x``` ok\n- [ ] second','');
 observations.N1ownership=out;
});

test('N1 blast radius: one task with unterminated prose + canonical Acceptance blocks finish/export of OTHER tasks (observation, retry after fix)',()=>{
 const out={};
 const f=fixture({status:'review'});
 try{
  S.createTask(f.h,{id:'T-002',title:'Other task',actor:'a',status:'review'});exportFiles(f.h,f.repo);
  // T-001: stray fence + canonical acceptance ; T-002: clean, approved, finishing
  writeProse(f,'Intro\n```md\nunclosed\n');S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['A'],actor:'a',expectRevision:0});
  S.reviseAcceptance(f.h,{taskId:'T-002',condition:'criteria',texts:['B'],actor:'a',expectRevision:0});S.approveAcceptanceCriterion(f.h,{taskId:'T-002',index:0,expectRevision:1,actor:'r'});
  const r=K.finishTask(f.h,f.repo,{taskId:'T-002',actor:'finisher'});
  out.finishOther={ok:r.ok,stage:r.stage,ckptStage:r.checkpoint&&r.checkpoint.stage,refused:/acceptance-render-refused: task T-001/.test(r.checkpoint&&r.checkpoint.error||''),movePerformed:r.move&&r.move.performed,plan:S.getTask(f.h.db,'T-002').planningState,checkpointEvents:evCount(f,'checkpoint.exported')};
  // fix T-001 prose, retry finish: no duplicate move
  const fp=path.join(f.repo,'tasks/T-001.md');fs.writeFileSync(fp,C.generateTaskDetailFile({...C.parseTaskDetailFile(fs.readFileSync(fp,'utf8')),description:'Intro\n```md\nunclosed\n```'}));
  const doneBefore=f.h.listEvents().filter(e=>e.eventType==='task.patched'&&e.payload.taskId==='T-002'&&e.payload.patch.planningState==='done').length;
  const r2=K.finishTask(f.h,f.repo,{taskId:'T-002',actor:'finisher'});
  out.retryAfterFix={ok:r2.ok,movePerformed:r2.move&&r2.move.performed,doneMovesTotal:f.h.listEvents().filter(e=>e.eventType==='task.patched'&&e.payload.taskId==='T-002'&&e.payload.patch.planningState==='done').length,doneBefore,checkpointEvents:evCount(f,'checkpoint.exported')};
 }finally{f.close();}
 observations.N1blast=out;
 assert.equal(out.finishOther.ok,false);assert.ok(out.finishOther.refused);assert.equal(out.finishOther.plan,'done');assert.equal(out.finishOther.checkpointEvents,0);
 assert.ok(out.retryAfterFix.ok);assert.equal(out.retryAfterFix.movePerformed,false);assert.equal(out.retryAfterFix.doneMovesTotal,1);
});

test('N4 push: missing mirror -> canonical Acceptance + explicit note; no canonical -> no invented section; unterminated -> refuse before ANY gh call; mocks only',()=>{
 const out={};
 function pushWithCalls(f){f.h.db.prepare('UPDATE task_projection SET external_id=NULL').run();const calls=[];G.setGhRunnerForTests(args=>{calls.push(args.join(' ').slice(0,80));if(args[0]==='api'&&args[1].includes('?state=all'))return '[]';if(args[0]==='api'&&args.includes('POST'))return JSON.stringify({number:1,node_id:'FIXTURE',title:'Review task',body:'',labels:[],state:'open',html_url:'https://example.invalid/1'});throw Error('Unexpected fake gh '+args.join(' '));});const old=process.cwd();process.chdir(f.repo);let err=null,dry=null;try{P.pushStoreCommand({});}catch(e){err=e.message;}finally{process.chdir(old);G.setGhRunnerForTests(null);}const b=calls.map(x=>x);return {err,calls,body:null};}
 const bodyOf=(f)=>{f.h.db.prepare('UPDATE task_projection SET external_id=NULL').run();let calls=[];G.setGhRunnerForTests(args=>{calls.push(args);if(args[0]==='api'&&args[1].includes('?state=all'))return '[]';if(args[0]==='api'&&args.includes('POST'))return JSON.stringify({number:1,node_id:'FIXTURE',title:'Review task',body:'',labels:[],state:'open',html_url:'https://example.invalid/1'});throw Error('Unexpected fake gh '+args.join(' '));});const old=process.cwd();process.chdir(f.repo);let err=null;try{P.pushStoreCommand({});}catch(e){err=e.message;}finally{process.chdir(old);G.setGhRunnerForTests(null);}const b=calls.flat().find(x=>typeof x==='string'&&x.startsWith('body='));return {err,callCount:calls.length,body:b?b.slice(5):null};};
 let f=fixture();
 try{
  reviseApprove(f,'Done criterion');S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['Pending canonical','Second'],actor:'a',expectRevision:1});S.approveAcceptanceCriterion(f.h,{taskId:'T-001',index:0,expectRevision:2,actor:'r'});
  fs.rmSync(path.join(f.repo,'tasks/T-001.md'));
  out.missingMirrorCanonical=bodyOf(f);
  assert.ok(/not available in this checkout/.test(out.missingMirrorCanonical.body)&&/- \[x\] Pending canonical/.test(out.missingMirrorCanonical.body)&&/- \[ \] Second/.test(out.missingMirrorCanonical.body));
  // also: no detailPath mirror dir at all
  fs.rmSync(path.join(f.repo,'tasks'),{recursive:true,force:true});out.missingDirCanonical=bodyOf(f);assert.ok(/- \[x\] Pending canonical/.test(out.missingDirCanonical.body));
 }finally{f.close();}
 f=fixture();
 try{
  fs.rmSync(path.join(f.repo,'tasks/T-001.md'));out.missingMirrorNoCanonical=bodyOf(f);assert.ok(!/Acceptance|not available/.test(out.missingMirrorNoCanonical.body));
  S.reviseAcceptance(f.h,{taskId:'T-001',condition:'empty',texts:[],actor:'a',expectRevision:0});out.missingMirrorEmptyCondition=bodyOf(f);assert.ok(!/## Acceptance/.test(out.missingMirrorEmptyCondition.body));
 }finally{f.close();}
 f=fixture();
 try{
  writeProse(f,'Intro\n```md\nunclosed\n\n## Notes\nKEEP');S.reviseAcceptance(f.h,{taskId:'T-001',condition:'criteria',texts:['A'],actor:'a',expectRevision:0});
  const mirrorBefore=fs.readFileSync(path.join(f.repo,'tasks/T-001.md'));const ext0=S.getTask(f.h.db,'T-001').externalId;
  out.unterminatedWithCanonical=bodyOf(f);assert.ok(/acceptance-render-refused/.test(out.unterminatedWithCanonical.err));assert.equal(out.unterminatedWithCanonical.callCount,0);
  out.unterminatedWithCanonical.mirrorUntouched=Buffer.compare(fs.readFileSync(path.join(f.repo,'tasks/T-001.md')),mirrorBefore)===0;out.unterminatedWithCanonical.externalIdNull=S.getTask(f.h.db,'T-001').externalId===null;
 }finally{f.close();}
 f=fixture();
 try{
  writeProse(f,'Intro\n```md\nunclosed\n\n## Notes\nKEEP');
  out.unterminatedNoCanonical=bodyOf(f);assert.equal(out.unterminatedNoCanonical.err,null);
 }finally{f.close();}
 observations.N4=out;
});

test('N3: external-id-format + empty-work-domains are warnings, DB-only, do not change error counts or exit',()=>{
 const out={};
 for(const [name,mut] of Object.entries({externalGarbage:f=>sql(f,"UPDATE task_projection SET external_id='garbage' WHERE task_id='T-001'"),externalValid:f=>sql(f,"UPDATE task_projection SET external_id='github:issue:123' WHERE task_id='T-001'"),externalNull:f=>{},emptyDomains:f=>sql(f,"UPDATE project_projection SET work_domains_json='[]'"),emptyDomainsWithTaskDomains:f=>{sql(f,"UPDATE project_projection SET work_domains_json='[]'");sql(f,`UPDATE task_projection SET domains_json='["CORE"]' WHERE task_id='T-001'`);}})){
  const f=fixture();try{mut(f);const r=S.validateStoreRegime(f.repo);const x=run(f,['validate']);out[name]={issues:r.canonical.issues.map(i=>i.severity[0]+':'+i.code),errors:r.canonical.errors,warnings:r.canonical.warnings,cliExit:x.status};}finally{f.close();}
 }
 observations.N3=out;
 assert.deepEqual(out.externalGarbage.issues,['w:external-id-format']);assert.equal(out.externalGarbage.cliExit,0);assert.deepEqual(out.externalValid.issues,[]);assert.deepEqual(out.externalNull.issues,[]);
 assert.deepEqual(out.emptyDomains.issues,['w:empty-work-domains']);assert.equal(out.emptyDomains.cliExit,0);assert.equal(out.emptyDomainsWithTaskDomains.errors,1);
});
