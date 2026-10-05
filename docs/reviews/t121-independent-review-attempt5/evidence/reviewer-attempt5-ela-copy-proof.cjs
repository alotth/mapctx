const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const sourceEla = '/Users/alt/repos/ela';
const mapctxRoot = '/tmp/mapctx-t121-attempt5-review-copy';
const incidentHead = 'fc3a5e2';
const projectId = 'b138e99c-2667-407f-a5a5-8ae2ff3289d5';
const reported = ['T-063','T-175','T-180','T-186','T-187','T-194','T-212','T-213','T-248','T-254','T-257','T-261','T-268','T-271','T-274'];
const evidenceRoot = '/Users/alt/.traycer/epics/e8873251-f6f0-490d-be16-8e5655300237/artifacts/t121-review-attempt3/evidence';
const priorInput = JSON.parse(fs.readFileSync(path.join(evidenceRoot,'recovery-input-manifest.json'),'utf8'));
const core = require(path.join(mapctxRoot,'packages/core/dist/task-detail.js'));
const storeApi = require(path.join(mapctxRoot,'packages/store/dist/index.js'));
const {parseTaskDetailFile, generateTaskDetailFile, parseAcceptanceChecklist, renderAcceptanceProse, acceptanceRenderObstruction, analyzeAcceptanceProse} = core;
const {StoreHandle, getAcceptance} = storeApi;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
const git = (...args) => {
  const result=execFileSync('git',['-C',sourceEla,...args],{encoding:args[0]==='show'?undefined:'utf8'});
  return args[0]==='show' ? result.toString('utf8') : result.trimEnd();
};
function pinReported() {
  return Object.fromEntries(reported.map(id => {
    const file = path.join(sourceEla,'tasks',`${id}.md`);
    return [id, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null];
  }));
}
function fenceOpen(line) {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? {char:m[1][0],length:m[1].length} : null;
}
function fenceClose(line, open) { return new RegExp('^\\s*'+open.char+'{'+open.length+',}[ \\t]*$').test(line); }
function sectionBounds(description) {
  const lines = description.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  let open=null, level=null, start=-1, end=lines.length;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(open) { if(fenceClose(line,open)) open=null; continue; }
    const op=fenceOpen(line); if(op) { open=op; continue; }
    const h=/^\s*(#{1,6})\s+(.+?)\s*$/.exec(line); if(!h) continue;
    const hLevel=h[1].length, title=h[2].trim().toLowerCase();
    if(level!==null) { if(hLevel>level) continue; level=null; end=i; }
    if(title==='acceptance') { level=hLevel; start=i; end=lines.length; }
  }
  if(start<0) fail('Missing real Acceptance section');
  return {lines,start,end};
}
function authoredLines(description, canonicalTexts) {
  const {lines,start,end}=sectionBounds(description), texts=new Set(canonicalTexts), consumed=new Set(), out=[];
  for(const line of lines.slice(start+1,end)) {
    if(line.trim()==='' || line.trimStart().startsWith('<!-- mapctx:store-owned acceptance revision')) continue;
    const b=/^\s*[-*+]\s+(?:(\[([ xX])\])\s+)?(.+?)\s*$/.exec(line);
    if(b) {
      const isCheckbox=b[1]!==undefined, text=b[3].trim();
      if(texts.has(text) && !consumed.has(text)) { consumed.add(text); continue; }
      if(isCheckbox && !texts.has(text)) { out.push(line); continue; }
    }
    out.push(line);
  }
  return out;
}
function preserveIncidentAcceptance(currentDescription, incidentDescription, canonicalTexts) {
  const current=sectionBounds(currentDescription), incident=sectionBounds(incidentDescription);
  const currentAuthored=authoredLines(currentDescription,canonicalTexts);
  const incidentAuthored=authoredLines(incidentDescription,canonicalTexts);
  const remaining=new Map(); for(const line of incidentAuthored) remaining.set(line,(remaining.get(line)||0)+1);
  const missing=[];
  for(const line of currentAuthored) { const n=remaining.get(line)||0; if(n) remaining.set(line,n-1); else missing.push(line); }
  if(missing.length) fail(`Current authored Acceptance lines lack incident counterpart; refusing recovery: ${missing.length} lines`);
  const block=incident.lines.slice(incident.start,incident.end);
  block[0]=current.lines[current.start];
  return [...current.lines.slice(0,current.start),...block,...current.lines.slice(current.end)].join('\n');
}
function sqliteSnapshot(dbPath) {
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
    const tableFacts={};
    for(const name of tables) {
      const rows=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort();
      tableFacts[name]={count:rows.length,sha256:sha(rows.join('\n'))};
    }
    const meta=db.prepare("SELECT value_json FROM store_meta WHERE key='logical_clock'").get();
    const checkpointCount=db.prepare('SELECT COUNT(*) AS n FROM export_checkpoint').get().n;
    const eventCount=db.prepare('SELECT COUNT(*) AS n FROM event_log').get().n;
    const checkpointEvents=db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type='checkpoint.exported'").get().n;
    return {tables:tableFacts,logicalClock:meta?.value_json??null,checkpointCount,eventCount,checkpointEvents};
  } finally { db.close(); }
}
function hashTree(root) {
  const out={};
  function walk(dir) { for(const name of fs.readdirSync(dir).sort()) { const p=path.join(dir,name), st=fs.statSync(p); if(st.isDirectory()) walk(p); else out[path.relative(root,p)]=sha(fs.readFileSync(p)); } }
  walk(root); return out;
}
function runExport(cli,cwd,home) {
  const r=spawnSync(process.execPath,[cli,'export','--reason','manual','--json'],{cwd,env:{...process.env,MAPCTX_HOME:home},encoding:'utf8'});
  let result=null; try { result=JSON.parse(r.stdout); } catch {}
  if(r.status!==0 || !result?.ok) fail(`Public export failed status=${r.status}; ${String(r.stderr).slice(0,240)} ${String(r.stdout).slice(0,240)}`);
  return result;
}
function copySafe(source,dest) { fs.cpSync(source,dest,{recursive:true,force:true,dereference:false}); }

const startHead=git('rev-parse','HEAD');
const startPins=pinReported();
const priorById=new Map(priorInput.files.map(x=>[x.id,x]));
const currentWorktreeCopies={};
const tempRoot=fs.mkdtempSync('/tmp/mapctx-acceptance-prose-preservation/reviewer-attempt5-ela-copy-');
fs.chmodSync(tempRoot,0o700);
const repo=path.join(tempRoot,'repo'), home=path.join(tempRoot,'home');
fs.mkdirSync(repo,{mode:0o700}); fs.mkdirSync(home,{mode:0o700});
fs.copyFileSync(path.join(sourceEla,'mapctx.toml'),path.join(repo,'mapctx.toml'));
fs.copyFileSync(path.join(sourceEla,'TASKS.md'),path.join(repo,'TASKS.md'));
copySafe(path.join(sourceEla,'tasks'),path.join(repo,'tasks'));
const sourceHome=process.env.MAPCTX_HOME||path.join(os.homedir(),'.mapctx');
const sourceStore=path.join(sourceHome,'projects',projectId);
const copiedStore=path.join(home,'projects',projectId);
if(!fs.existsSync(sourceStore)) fail('Source store missing');
copySafe(sourceStore,copiedStore);
for(const entry of fs.readdirSync(copiedStore)) { const p=path.join(copiedStore,entry); if(fs.statSync(p).isFile()) fs.chmodSync(p,0o600); }
const dbPath=path.join(copiedStore,'mapctx.db');
const storeBefore=sqliteSnapshot(dbPath);
const store=StoreHandle.open(copiedStore);
const beforeAcceptance={};
const mergeInputs={};
try {
  for(const id of reported) {
    const taskPath=path.join(repo,'tasks',`${id}.md`);
    const currentRaw=fs.readFileSync(taskPath,'utf8');
    currentWorktreeCopies[id]=sha(currentRaw);
    const incidentRaw=git('show',`${incidentHead}:tasks/${id}.md`);
    const pin=priorById.get(id);
    if(!pin || sha(incidentRaw)!==pin.incidentHeadSha256) fail(`Incident source pin mismatch for ${id}`);
    const currentTask=parseTaskDetailFile(currentRaw), incidentTask=parseTaskDetailFile(incidentRaw);
    const acceptance=getAcceptance(store.db,id);
    if(!acceptance || acceptance.condition!=='criteria') fail(`No canonical criteria revision for ${id}`);
    const canonical=acceptance.criteria.map(c=>({text:c.text,completed:c.state==='approved'}));
    const merged=preserveIncidentAcceptance(currentTask.description,incidentTask.description,canonical.map(x=>x.text));
    const obstruction=acceptanceRenderObstruction(merged); if(obstruction) fail(`${id} obstruction: ${obstruction}`);
    const once=renderAcceptanceProse(merged,canonical,acceptance.revision);
    const twice=renderAcceptanceProse(once,canonical,acceptance.revision);
    if(once!==twice) fail(`${id} current renderer not idempotent`);
    const beforeOutside=analyzeAcceptanceProse(currentTask.description).keptLines.join('\n');
    const outputOutside=analyzeAcceptanceProse(twice).keptLines.join('\n');
    if(beforeOutside!==outputOutside) fail(`${id} current outside-Acceptance prose changed during recovery input`);
    const sectionBefore=authoredLines(merged,canonical.map(x=>x.text));
    const sectionAfter=authoredLines(twice,canonical.map(x=>x.text));
    if(JSON.stringify(sectionBefore)!==JSON.stringify(sectionAfter)) fail(`${id} authored Acceptance lines changed during render`);
    const parsed=parseAcceptanceChecklist(twice);
    const expected=canonical.map(c=>({text:c.text,completed:c.completed}));
    if(JSON.stringify(parsed.items)!==JSON.stringify(expected)) fail(`${id} rendered criteria/state differ from canonical store`);
    const generated=generateTaskDetailFile({...currentTask,description:merged});
    fs.writeFileSync(taskPath,generated,'utf8');
    beforeAcceptance[id]={revision:acceptance.revision,condition:acceptance.condition,criteria:acceptance.criteria.map(c=>({criterionId:c.criterionId,text:c.text,state:c.state,evidence:c.evidence,approvedAt:c.approvedAt,approvedBy:c.approvedBy})),authoredLines:sectionBefore.length,outsideSha256:sha(beforeOutside),currentInputSha256:currentWorktreeCopies[id],incidentInputSha256:sha(incidentRaw)};
    mergeInputs[id]={currentDescription:currentTask.description,canonical,revision:acceptance.revision,incidentDescription:incidentTask.description};
  }
} finally { store.close(); }
const mergedTree=hashTree(repo);
const cli=path.join(mapctxRoot,'packages/sync-engine/dist/mapctx-cli.js');
const first=runExport(cli,repo,home);
const checkpointOneTree=hashTree(repo);
const firstDescriptions={};
const storeAfterOne=StoreHandle.open(copiedStore);
try {
  for(const id of reported) {
    const taskPath=path.join(repo,'tasks',`${id}.md`), raw=fs.readFileSync(taskPath,'utf8'), d=parseTaskDetailFile(raw).description;
    const original=mergeInputs[id];
    const afterOutside=analyzeAcceptanceProse(d).keptLines.join('\n');
    if(afterOutside!==analyzeAcceptanceProse(original.currentDescription).keptLines.join('\n')) fail(`${id} outside-Acceptance authored prose changed after checkpoint 1`);
    const afterAuthored=authoredLines(d,original.canonical.map(x=>x.text));
    const expectedAuthored=authoredLines(preserveIncidentAcceptance(original.currentDescription,original.incidentDescription,original.canonical.map(x=>x.text)),original.canonical.map(x=>x.text));
    if(JSON.stringify(afterAuthored)!==JSON.stringify(expectedAuthored)) fail(`${id} authored Acceptance lines changed after checkpoint 1`);
    const parsed=parseAcceptanceChecklist(d), expected=original.canonical;
    if(JSON.stringify(parsed.items)!==JSON.stringify(expected)) fail(`${id} criteria/state changed after checkpoint 1`);
    const acceptance=getAcceptance(storeAfterOne.db,id);
    const state=acceptance?.criteria.map(c=>({criterionId:c.criterionId,text:c.text,state:c.state,evidence:c.evidence,approvedAt:c.approvedAt,approvedBy:c.approvedBy}));
    if(JSON.stringify(state)!==JSON.stringify(beforeAcceptance[id].criteria)) fail(`${id} canonical acceptance projection changed`);
    firstDescriptions[id]=d;
  }
} finally { storeAfterOne.close(); }
const second=runExport(cli,repo,home);
const checkpointTwoTree=hashTree(repo);
for(const id of reported) {
  const d=parseTaskDetailFile(fs.readFileSync(path.join(repo,'tasks',`${id}.md`),'utf8')).description;
  if(d!==firstDescriptions[id]) fail(`${id} second checkpoint changed rendered description`);
}
if(JSON.stringify(first.filesHash)!==JSON.stringify(second.filesHash)) fail('Public checkpoint file/hash manifests differ');
const storeAfter=sqliteSnapshot(dbPath);
const changedTables=Object.keys(storeBefore.tables).filter(name=>JSON.stringify(storeBefore.tables[name])!==JSON.stringify(storeAfter.tables[name]));
const allowedChanges=['event_log','export_checkpoint','store_meta'];
const unexpectedTables=changedTables.filter(name=>!allowedChanges.includes(name));
if(unexpectedTables.length) fail(`Unexpected canonical domain table changes: ${unexpectedTables.join(',')}`);
if(storeAfter.checkpointCount!==storeBefore.checkpointCount+2) fail('Expected exactly two checkpoint rows');
if(storeAfter.checkpointEvents!==storeBefore.checkpointEvents+2) fail('Expected exactly two checkpoint.exported events');
const beforeClock=Number(JSON.parse(storeBefore.logicalClock)), afterClock=Number(JSON.parse(storeAfter.logicalClock));
if(!Number.isFinite(beforeClock)||afterClock!==beforeClock+2) fail('Logical clock did not advance exactly twice');
const endHead=git('rev-parse','HEAD'); const endPins=pinReported();
if(endHead!==startHead || JSON.stringify(startPins)!==JSON.stringify(endPins)) fail('Real ELA HEAD or one of the 15 source paths changed during copy proof');
const changedPaths=Object.keys(mergedTree).filter(p=>mergedTree[p]!==checkpointOneTree[p]);
const firstFiles=first.files.map(file=>[path.relative(repo,file.path),file.sha256]);
const secondFiles=second.files.map(file=>[path.relative(repo,file.path),file.sha256]);
const summary={generatedAt:new Date().toISOString(),sourceElaHead:startHead,sourceElaHeadEnd:endHead,incidentHead,reportedPathHashesBefore:startPins,reportedPathHashesAfter:endPins,realElaUntouched:true,copy:{root:tempRoot,repoFilesBeforeCheckpoint:Object.keys(mergedTree).length,checkpointOneFiles:Object.keys(checkpointOneTree).length,checkpointTwoFiles:Object.keys(checkpointTwoTree).length,changedFilesOnCheckpoint1:changedPaths},reportedTasks:reported.map(id=>({id,canonicalRevision:beforeAcceptance[id].revision,criteria:beforeAcceptance[id].criteria.length,authoredAcceptanceLinesPreserved:beforeAcceptance[id].authoredLines,outsideAcceptanceSha256:beforeAcceptance[id].outsideSha256})),checkpoints:{first:{ok:first.ok,reason:first.reason,filesHashSha256:sha(JSON.stringify(firstFiles))},second:{ok:second.ok,reason:second.reason,filesHashSha256:sha(JSON.stringify(secondFiles))},stable:JSON.stringify(firstFiles)===JSON.stringify(secondFiles)},store:{before:{logicalClock:beforeClock,checkpointCount:storeBefore.checkpointCount,checkpointEvents:storeBefore.checkpointEvents,eventCount:storeBefore.eventCount},after:{logicalClock:afterClock,checkpointCount:storeAfter.checkpointCount,checkpointEvents:storeAfter.checkpointEvents,eventCount:storeAfter.eventCount},changedTables,unexpectedDomainTables:unexpectedTables},inputRestoration:{source:'incident commit fc3a5e2',currentDescriptionOutsideAcceptanceRetained:true,currentAuthoredAcceptanceLinesRetained:true,canonicalStoreCriteriaAndStatesRetained:true,allRenderedDescriptionsStable:true}};
const resultPath=path.join(tempRoot,'proof-summary.json');
fs.writeFileSync(resultPath,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(summary,null,2));
