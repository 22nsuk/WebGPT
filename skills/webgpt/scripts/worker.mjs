import { createServer, validateHeaderValue } from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { grantWorkspace, listWorkspace, probeWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';
import { configuration, configurationFile } from './client.mjs';
import { hasPendingResults, inspectPendingResults, storeResult, verifySavedResult } from './results.mjs';
import { acquireRuntimeLock, readStateBytes, readStateMarker, createStateMarker, assertNoStateStage, writeStateBytes, parseState, fault, startupExitCode } from './runtime.mjs';
import { protocolVersions, validateMessage, negotiateProtocol, validateArguments } from './protocol.mjs';
import { auditFromEnvironment, createAuditWriter } from './audit.mjs';
import { validatedEntryPath } from './installation.mjs';
import { windowProperties, readWindowOptions, textWindow } from './text-window.mjs';

const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str = {type:'string'};
export const tools = [
  {name:'list_files',description:'List a local project directory, up to 500 entries per page. Use path . for the root. Pass nextCursor as cursor for the next page; restart without a cursor if the directory changes.',inputSchema:{...schema({token:str,path:str}),properties:{token:str,path:str,cursor:str,limit:{type:'integer',minimum:1,maximum:500}}},annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_file',description:'Read a project text file and its whole-file SHA256 revision. Optional offset (1-based), limit (lines) or maxChars returns a bounded window with partial/range/nextOffset metadata. Missing file returns exists:false. Never replace a file with only an excerpt; read the whole file before editing.',inputSchema:{...schema({token:str,path:str}),properties:{token:str,path:str,...windowProperties}},annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'write_file',description:'Directly create or replace a local project text file. No per-file grants. Read first; expectedSha256 must match its revision, or null for a new file. Original is backed up. No Git or shell.',inputSchema:schema({token:str,path:str,text:str,expectedSha256:{type:['string','null']}}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'delete_file',description:'Directly delete an existing local project file after reading it. Requires matching expectedSha256; original and path are saved for recovery. No directory or recursive deletion.',inputSchema:schema({token:str,path:str,expectedSha256:str}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'get_task',description:'Read the assigned task and input names using its private task token. No repository or Git setup needed.',inputSchema:schema({token:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_input',description:'Read one explicitly supplied input by name; no filesystem access. Optional offset (1-based), limit (lines) or maxChars returns complete lines with partial/range/nextOffset and the whole-input SHA256. Without options returns the original full text. Follow nextOffset for required context; an excerpt is not the full input.',inputSchema:{...schema({token:str,name:str}),properties:{token:str,name:str,...windowProperties}},annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'submit_result',description:'Save the task deliverable, evidence and limitations, and notify the supervisor. No file changes required. Terminal: stops backup checks. Retry identical submission safely. Do not delete the chat.',inputSchema:schema({token:str,status:{type:'string',enum:['completed','failed','cancelled']},summary:str,result:str}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
export async function start({dir,port=43137,controlPort=43139,publicMcp=false,backupMs=900000,waitMs=55000,closeGraceMs=5000,now=Date.now,configFile=configurationFile(),audit=false,entryPath}={}) {
  const entryRoot=dirname(validatedEntryPath(import.meta.url,entryPath));
  if(typeof audit!=='boolean')throw fault('CONFIG_INVALID','audit must be boolean');
  if(!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>55000)throw Error('waitMs must be between 1 and 55000');
  if(typeof configFile!=='string'||!isAbsolute(configFile))throw fault('CONFIG_INVALID','configFile must be absolute');
  dir=resolve(dir); mkdirSync(dir,{recursive:true,mode:0o700});
  if(!Number.isSafeInteger(closeGraceMs)||closeGraceMs<1||closeGraceMs>30000)throw Error('invalid closeGraceMs');
  let auditClosed=false;
  const ownership=acquireRuntimeLock(dir), release=()=>{auditClosed=true;ownership.release();};
  try{
  const statePath=resolve(dir,'state.json'), keyPath=resolve(dir,'controller.key');
  const key=existsSync(keyPath)?readFileSync(keyPath,'utf8'):randomUUID();
  // Validate before opening either listener; HTTP removes trailing header whitespace.
  try{
    if(!key||/[ \t]$/.test(key))throw Error();
    validateHeaderValue('authorization','Bearer '+key);
  }catch{throw fault('CONFIG_INVALID','invalid controller.key');}
  if(!existsSync(keyPath))writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});
  // URL capability authenticates the remote MCP connection; task tokens separately grant work.
  // Keep the URL out of stdout, task prompts and HTTP error responses.
  let mcpPath='/mcp';
  if(publicMcp){
    const pathKey=resolve(dir,'mcp-path.key');
    if(!existsSync(pathKey))writeFileSync(pathKey,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    const secret=readFileSync(pathKey,'utf8');
    if(!/^[a-f0-9]{64}$/.test(secret))throw fault('CONFIG_INVALID','invalid mcp-path.key');
    mcpPath+='/'+secret;
  }
  const markerPath=resolve(dir,'state.initialized');
  let savedState=readStateBytes(statePath), stateInitialized=readStateMarker(markerPath);
  if(savedState===null&&(stateInitialized||existsSync(statePath+'.tmp')||readdirSync(dir).some(name=>(name.endsWith('.result.txt')||name.endsWith('.result.txt.tmp')))
      ||existsSync(resolve(dir,'recovery'))))
    throw fault('STATE_INVALID','state.json is missing beside recovery evidence; do not start an empty runtime');
  assertNoStateStage(statePath);
  let tasks=parseState(savedState,dir), stopping=false, closePromise;
  // Existing valid state is the evidence needed to migrate legacy runtimes.
  // Keys alone may belong to a worker that has never registered a task.
  if(savedState!==null&&!stateInitialized){createStateMarker(markerPath);stateInitialized=true;}
  let storageFailure=null, stateFailure=null;
  const waiters=new Set();
  let waking=false,wakePending=false;
  const wake=()=>{
    // A waiter's state check can report storage failure and wake its peers.
    // Drain that notification without recursively revisiting completed waiters.
    wakePending=true;
    if(waking)return;
    waking=true;
    try{
      do{
        wakePending=false;
        for(const fn of [...waiters])fn();
        // A prior waiter may have re-parked before a later one found the error.
      }while(wakePending);
    }finally{waking=false;}
  };
  const storageError=error=>{
    if(error.code==='STATE_INVALID')stateFailure=error;
    else storageFailure={code:error.code??'STORAGE_UNAVAILABLE'};
    wake();
    return Object.assign(error,{statusCode:503,retryable:false});
  };
  const verifyState=()=>{
    if(stateFailure)throw stateFailure;
    try{
      if(readStateMarker(markerPath)!==stateInitialized)
        throw fault('STATE_INVALID','state initialization marker changed outside this worker; preserve evidence and inspect');
      const actual=readStateBytes(statePath);
      if(savedState===null?actual!==null:actual===null||!savedState.equals(actual))
        throw fault('STATE_INVALID','state.json changed outside this worker; preserve evidence and inspect');
    }catch(error){throw storageError(error);}
  };
  // Publish in-memory transitions only after the matching file was replaced.
  // A failed write does not revoke tokens, acknowledge results or erase evidence.
  const persist=(next=tasks)=>{
    verifyState();
    try{
      if(!stateInitialized){createStateMarker(markerPath);stateInitialized=true;}
      const bytes=Buffer.from(JSON.stringify(next));
      writeStateBytes(statePath,bytes);
      savedState=bytes;tasks=next;storageFailure=null;
    }catch(error){throw storageError(error);}
  };
  const updateTask=(task,changes)=>persist(tasks.map(t=>t===task?{...t,...changes}:t));
  const codeRoot=realpathSync.native(fileURLToPath(new URL('.',import.meta.url)));
  const deploymentRoots=[...new Set([codeRoot,entryRoot].map(root=>resolve(root,'../deploy')))];
  const canonicalOperationalPath=path=>{
    // Deployment can be omitted from a scripts-only install, and config may
    // not exist yet. Resolve existing ancestors without creating either path.
    let cursor=resolve(path);const suffix=[];
    for(;;){
      try{lstatSync(cursor);}catch(error){
        if(error.code!=='ENOENT'||dirname(cursor)===cursor)throw error;
        suffix.unshift(basename(cursor));cursor=dirname(cursor);continue;
      }
      return resolve(realpathSync.native(cursor),...suffix);
    }
  };
  const checkDataBoundary=workspace=>{
    if(!workspace)return;
    const workspaceRoot=realpathSync.native(workspace.root);
    // An unattended restart must never execute code modified through its own grant.
    // Use a separate source checkout to edit WebGPT, not the running installation.
    // The shipped service launchers live beside scripts, not beneath it. Check
    // both their named location and current native target on every grant/use.
    for(const [protectedRoot,label] of [[realpathSync.native(dir),'private worker data'],[codeRoot,'running worker code'],
      [entryRoot,'running worker code'],[canonicalOperationalPath(entryRoot),'running worker code'],
      ...deploymentRoots.flatMap(root=>[root,canonicalOperationalPath(root),canonicalOperationalPath(resolve(root,'windows')),
        ...['run-worker-task.ps1','register-worker-task.ps1','worker.xml.example']
          .map(name=>canonicalOperationalPath(resolve(root,'windows',name)))]
        .map(path=>[path,'worker deployment files']))])
      for(const rel of [relative(workspaceRoot,protectedRoot),relative(protectedRoot,workspaceRoot)])
        if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))
          throw Error('workspace overlaps '+label+'; use a separate project root');
    // Configuration is operational authority, including publicMcp and dataDir.
    // It may live outside runtime; protect both its named path and actual target.
    for(const protectedFile of [resolve(configFile),canonicalOperationalPath(configFile)]){
      const rel=relative(workspaceRoot,protectedFile);
      if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))
        throw Error('workspace overlaps worker configuration; use a separate project root');
    }
  };
  const revoke=t=>{delete t.token;t.inputs={};t.instructions='';};
  const recoveryFor=task=>{
    const recovery=inspectRecovery(dir,task.id);
    const directory=resolve(dir,'recovery',task.id), unresolved=new Set(recovery.unresolved);
    // inspectRecovery binds each validated operation to its unique journal name.
    // Index candidates for this inspection only; an ID match is not receipt equality.
    const byOperation=new Map(recovery.receipts.map(receipt=>[receipt.operation,receipt]));
    const unrecorded=new Set(recovery.receipts);
    for(const expected of task.changes??[]){
      const actual=byOperation.get(expected.operation);
      if(actual&&isDeepStrictEqual(actual,expected))unrecorded.delete(actual);
      // Inspect both directions, including every duplicate state receipt. A root
      // diagnostic suppresses child noise, not matching of later valid receipts.
      else if(!unresolved.has(directory)){
        const operation=expected.operation;
        unresolved.add(typeof operation==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation)
          ?resolve(directory,operation+'.json'):directory);
      }
    }
    return {...recovery,unresolved:[...unresolved],unrecorded};
  };
  // Recover recorded mutations; never guess whether an interrupted mutation was applied.
  for(const t of tasks){
    if(t.collected)revoke(t);
    if(t.status!=='running')continue;
    const {receipts,unresolved}=recoveryFor(t);
    const pending=new Set(unresolved);
    // Preserve find()'s first-match rule for conflicting duplicate state records.
    const recorded=new Map();
    for(const change of t.changes??[])if(!recorded.has(change.operation))recorded.set(change.operation,change);
    for(const receipt of receipts) {
      const existing=recorded.get(receipt.operation);
      if(!existing){(t.changes??=[]).push(receipt);recorded.set(receipt.operation,receipt);}
      else if(!isDeepStrictEqual(existing,receipt))
        pending.add(resolve(dir,'recovery',t.id,receipt.operation+'.json'));
    }
    // Normalize diagnostic paths, never the original (possibly conflicting) receipts.
    t.recoveryRequired=[...pending];
  }
  if(tasks.length)persist();
  const pendingResultTasks=(selected=tasks)=>selected.filter(t=>t.status==='running'&&hasPendingResults(t,dir)).map(t=>t.id);
  const view=(selected=tasks)=>{
    const resultRecoveryRequired=pendingResultTasks(selected).map(id=>({id}));
    const recoveryRequired=selected.filter(t=>t.status==='running'&&t.recoveryRequired?.length).map(t=>({id:t.id,journals:t.recoveryRequired}));
    return {events:selected.filter(t=>t.status!=='running'&&!t.collected).map(t=>({id:t.id,status:t.status,summary:t.summary,artifact:t.artifact,sha256:t.sha256})),backupDue:selected.filter(t=>t.status==='running'&&now()>=t.nextCheck).map(t=>t.id),...(recoveryRequired.length?{recoveryRequired}:{}),...(resultRecoveryRequired.length?{resultRecoveryRequired}:{})};
  };
  const flagUnrecordedChanges=task=>{
    const {unrecorded,unresolved}=recoveryFor(task);
    const pending=new Set([...(task.recoveryRequired??[]),...unresolved]);
    for(const receipt of unrecorded)
      pending.add(resolve(dir,'recovery',task.id,receipt.operation+'.json'));
    // This safety block intentionally stays live even if state storage is unavailable.
    if(pending.size){task.recoveryRequired=[...pending];wake();}
    return unresolved;
  };
  const reconciliationTask=(t,journalIssues=recoveryFor(t).unresolved)=>({
    id:t.id,status:t.status,collected:t.collected,discarded:t.discarded??false,nextCheck:t.nextCheck,
    artifact:t.artifact??null,sha256:t.sha256??null,changes:t.changes??[],
    workspace:t.workspace?{root:t.workspace.root,mode:t.workspace.mode,device:t.workspace.device,inode:t.workspace.inode}:null,
    recoveryRequired:t.recoveryRequired??[],journalIssues,pendingResults:inspectPendingResults(t,dir)
  });
  // The controller owns both the decision and the state transition. No await or
  // event-loop yield may split these checks from persist. This serializes worker
  // requests, not arbitrary external filesystem writers or power-loss recovery.
  const commitCollection=a=>{
    if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['id','expectedStatus','expectedSha256'].includes(k))
        ||typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)
        ||!['completed','failed','cancelled'].includes(a.expectedStatus)
        ||typeof a.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(a.expectedSha256))throw Error('invalid conditional collection');
    const t=tasks.find(t=>t.id===a.id);if(!t)throw Error('unknown task');
    const conflict=(code,message,extra={})=>Object.assign(fault(code,message),{statusCode:409,...extra});
    if(t.discarded)throw conflict('COLLECTION_DISCARDED','result was discarded; inspect with collect --resume');
    if(t.status!==a.expectedStatus||t.sha256!==a.expectedSha256)
      throw conflict('COLLECTION_UNCONFIRMED','saved result differs from the requested collection; preserve evidence and reconcile');
    // Check bytes at the state owner, not only in an earlier client observation.
    // Keep raw filesystem errors and paths out of the conditional response.
    try{verifySavedResult(t,dir);}catch{
      throw conflict('COLLECTION_UNCONFIRMED','saved result cannot be verified; preserve evidence and reconcile');
    }
    const inspected=reconciliationTask(t);
    const attention=inspected.recoveryRequired.length||inspected.journalIssues.length?'inspect_recovery'
      :inspected.pendingResults.length?'inspect_uncommitted_result':null;
    if(attention)throw conflict('COLLECTION_RECOVERY_REQUIRED','saved result requires recovery inspection before collection',{
      attention,reconciliation:inspected
    });
    if(!t.collected){
      const next={...t,collected:true};revoke(next);
      persist(tasks.map(task=>task===t?next:task));wake();
    }
    return {ok:true,id:t.id,status:t.status,sha256:t.sha256,collected:true,duplicate:t.collected};
  };
  const readiness=(journalIssuesByTask)=>{
    let probe,stateVerified=false;
    try{
      verifyState();
      stateVerified=true; // Fresh state evidence is distinct from write readiness and other tasks.
      assertNoStateStage(statePath);
      // Check write/rename ability without rewriting state or recovery evidence.
      probe=resolve(dir,'.health-'+randomUUID());
      writeFileSync(probe+'.tmp','probe',{flag:'wx',mode:0o600,flush:true});
      renameSync(probe+'.tmp',probe);unlinkSync(probe);
    }catch(error){storageError(error);}
    finally{if(probe)for(const file of [probe+'.tmp',probe])try{unlinkSync(file);}catch{}}
    for(const task of tasks.filter(t=>t.status==='running')){
      const issues=flagUnrecordedChanges(task);
      journalIssuesByTask?.set(task,issues);
    }
    const recoveryRequired=tasks.filter(t=>t.status==='running'&&t.recoveryRequired?.length).map(t=>t.id);
    const unavailableWorkspaces=tasks.filter(t=>t.status==='running'&&t.workspace).filter(t=>{
      try{checkDataBoundary(t.workspace);probeWorkspace(t.workspace);return false;}catch{return true;}
    }).map(t=>t.id);
    const pendingResults=pendingResultTasks();
    const issues=[...(stopping?['SHUTTING_DOWN']:[]),...(stateFailure?['STATE_INVALID']:[]),
      ...(storageFailure?['STORAGE_UNAVAILABLE']:[]),...(recoveryRequired.length?['RECOVERY_REQUIRED']:[]),
      ...(unavailableWorkspaces.length?['WORKSPACE_UNAVAILABLE']:[]),...(pendingResults.length?['RESULT_RECOVERY_REQUIRED']:[])];
    return {ok:!issues.length,stateVerified:stateVerified&&!stateFailure,instanceId:ownership.instanceId,issues,recoveryRequired,unavailableWorkspaces,pendingResultTasks:pendingResults,
      storage:storageFailure?{ok:false,...storageFailure}:{ok:!stateFailure},automaticRestartRecommended:false};
  };
  const json=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const body=async(req,limit=2*1024*1024)=>{
    const chunks=[];let bytes=0;
    for await(const c of req){bytes+=c.length;if(bytes>limit)throw Object.assign(Error('request too large'),{statusCode:413});chunks.push(c);}
    // Reject invalid wire bytes rather than silently substituting replacement characters.
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  };
  const call=(name,args)=>{
    if(stopping)throw fault('SHUTTING_DOWN','worker is stopping');
    verifyState();
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('tool arguments must be an object');
    const t=typeof args.token==='string'&&tasks.find(t=>t.token&&t.token===args.token);if(!t)throw Error('unknown task token');
    const tool=tools.find(tool=>tool.name===name);if(!tool)throw Error('unknown tool');
    if(['list_files','read_file','write_file','delete_file'].includes(name))checkDataBoundary(t.workspace);
    validateArguments(tool,args);
    if(name==='get_task'){
      const inputs=Object.keys(t.inputs);
      // Keep legacy malformed records inspectable by the parent, not repaired
      // or promoted to ordinary tool text. Other tasks can still operate.
      if(!t.instructions.isWellFormed()||inputs.some(name=>!name.isWellFormed()))
        throw Error('stored task text is not well-formed Unicode; supervisor inspection required');
      return {id:t.id,instructions:t.instructions,inputs,status:t.status,workspace:t.workspace??null,changes:t.changes??[],recoveryRequired:t.recoveryRequired??[]};
    }
    if(name==='read_input'){
      if(!Object.hasOwn(t.inputs,args.name))throw Error('unknown input');
      const text=t.inputs[args.name];
      if(!text.isWellFormed())throw Error('stored input is not well-formed Unicode; supervisor inspection required');
      const range=readWindowOptions({offset:args.offset,limit:args.limit,maxChars:args.maxChars});
      if(!range)return {name:args.name,text}; // Preserve the original response exactly.
      return {name:args.name,...textWindow(text,range,'input'),sha256:createHash('sha256').update(text).digest('hex')};
    }
    if(['list_files','read_file','write_file','delete_file'].includes(name)) {
      if(t.status!=='running')throw Error('task is terminal; file access closed');
      if(name==='list_files')return listWorkspace(t.workspace,args.path,{cursor:args.cursor,limit:args.limit});
      if(name==='read_file')return readWorkspace(t.workspace,args.path,{offset:args.offset,limit:args.limit,maxChars:args.maxChars});
      if(hasPendingResults(t,dir))throw fault('RESULT_CONFLICT','uncommitted result: reconcile before further edits');
      flagUnrecordedChanges(t);
      if(t.recoveryRequired?.length)throw Error('interrupted mutation: supervisor recovery required before further edits');
      // A pre-existing state candidate cannot record a new file receipt. Refuse
      // before creating parents, backups or changing project bytes. Keep explicit
      // same-byte controller/result retries available for their existing recovery.
      try{assertNoStateStage(statePath);}catch(error){throw storageError(error);}
      try {
        const receipt=changeWorkspace(t.workspace,dir,t.id,args,name==='delete_file');
        updateTask(t,{changes:[...(t.changes??[]),receipt]});
        return receipt;
      } catch(e) {
        if(['EACCES','EPERM','ENOSPC','EROFS','EIO','EISDIR','ENOTDIR','EMFILE','ENFILE'].includes(e.code))storageError(e);
        flagUnrecordedChanges(t);
        if(t.recoveryRequired?.length)throw Error('file operation not fully recorded; supervisor recovery required: '+e.message);
        throw e;
      }
    }
    if(name!=='submit_result')throw Error('unknown tool');
    if(!['completed','failed','cancelled'].includes(args.status)||typeof args.result!=='string'||typeof args.summary!=='string'||args.summary.length>2048||Buffer.byteLength(args.result)>1024*1024)throw Error('invalid result');
    flagUnrecordedChanges(t);
    if(args.status==='completed'&&t.recoveryRequired?.length)throw Error('supervisor recovery required; preserve partial output with failed status');
    const sha=createHash('sha256').update(args.result).digest('hex');
    if(t.status!=='running'){
      if(sha!==t.sha256||args.status!==t.status||args.summary!==t.summary)throw Error('terminal result differs');
      verifySavedResult(t,dir);
      return {accepted:true,duplicate:true,sha256:sha};
    }
    let artifact;
    try{({artifact}=storeResult(dir,t.id,args.result));}
    catch(error){if(['RESULT_CONFLICT','RESULT_INVALID'].includes(error.code))throw error;throw storageError(error);}
    updateTask(t,{status:args.status,summary:args.summary,artifact,sha256:sha,nextCheck:null});
    wake();return {accepted:true,sha256:sha};
  };
  const captureAudit=createAuditWriter(dir,audit), auditResponses=new Set();
  const writeAudit=event=>{if(!auditClosed)captureAudit(event);};
  const mcp=createServer(async(req,res)=>{
    // Generated IDs only: request URLs, headers and caller JSON-RPC IDs stay private.
    let transportId;
    if(audit){
      transportId=randomUUID();
      const started=performance.now(), record={requestId:transportId,method:['GET','HEAD','POST'].includes(req.method)?req.method:'OTHER'};
      writeAudit({...record,phase:'http_received'});
      let recorded=false;
      const finished=aborted=>{
        if(recorded)return;recorded=true;auditResponses.delete(finishAudit);
        writeAudit({...record,phase:'http_completed',statusCode:res.headersSent?res.statusCode:null,
          aborted,durationMs:Math.max(0,Math.round(performance.now()-started))});
      };
      const finishAudit=()=>finished(!res.writableFinished);
      auditResponses.add(finishAudit);
      res.once('finish',()=>finished(false));
      res.once('close',()=>finished(!res.writableFinished));
    }
    if(req.headers.origin)return json(res,403,{});
    if(req.url==='/health'){
      if(req.method==='GET')return json(res,200,{ok:true,name:'WebGPT Worker'});
      if(req.method==='HEAD'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end();}
      res.setHeader('allow','GET, HEAD');return json(res,405,{});
    }
    if(stopping)return json(res,503,{error:'worker is stopping',code:'SHUTTING_DOWN'});
    const actual=Buffer.from(req.url??''),expected=Buffer.from(mcpPath);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(res,404,{});
    if(req.method!=='POST'){res.setHeader('allow','POST');return json(res,405,{});}
    const error=(status,id,code,message)=>json(res,status,{jsonrpc:'2.0',id,error:{code,message}});
    const version=req.headers['mcp-protocol-version'];
    if(version!==undefined&&!protocolVersions.includes(version))return error(400,null,-32600,'unsupported MCP protocol header');
    // JSON escaping can expand a valid 1 MiB text payload to 6 MiB plus its envelope.
    // The decoded per-file/result limits remain 1 MiB; controller bodies remain 2 MiB.
    let m;try{m=await body(req,8*1024*1024);}catch(e){
      return error(e.statusCode??400,null,e.statusCode===413?-32600:-32700,e.statusCode===413?'request too large':'invalid JSON or UTF-8');
    }
    if(stopping)return json(res,503,{error:'worker is stopping',code:'SHUTTING_DOWN'});
    let kind;try{kind=validateMessage(m);}catch{return error(400,null,-32600,'invalid JSON-RPC request');}
    if(kind==='notification'){res.writeHead(202);return res.end();}
    let result,protocolVersion;
    if(m.method==='initialize') {
      try{protocolVersion=negotiateProtocol(m.params?.protocolVersion);}catch{return error(200,m.id,-32602,'invalid protocolVersion');}
    }
    if(m.method==='ping')result={};
    else if(m.method==='initialize')result={protocolVersion,capabilities:{tools:{}},serverInfo:{name:'webgpt-worker',version:'1.4.1-fork.4'},instructions:'Read get_task with your private task token and perform the assigned task. Use read_input for supplied inputs. No workspace or file changes are required for text-only work. Use local file tools only when needed and granted; requested edits are applied directly, with revision hashes from read_file and no per-file grants. Review-only tasks cannot write. Coordinate disjoint edits if other workers share the project. Submit result once with the deliverable, any change receipts, evidence and limitations. No Git, PR, shell, or process control. Supervisor verifies results and retains task chats by default. Delete a task chat only when the user explicitly requests deletion of that chat.'};
    else if(m.method==='tools/list')result={tools};
    else if(m.method==='tools/call'){
      let record,started;
      if(audit){
        const name=m.params?.name,token=m.params?.arguments?.token;
        record={requestId:randomUUID(),transportId,tool:tools.some(t=>t.name===name)?name:'unknown',
          taskId:typeof token==='string'?(tasks.find(t=>t.token&&t.token===token)?.id??null):null};
        started=performance.now();writeAudit({...record,phase:'tool_received'});
      }
      try{const out=call(m.params?.name,m.params?.arguments);result={content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false};}
      catch(e){result={content:[{type:'text',text:e.message}],isError:true};}
      if(record)writeAudit({...record,phase:'tool_completed',isError:result.isError,durationMs:Math.max(0,Math.round(performance.now()-started))});
    }
    else return json(res,200,{jsonrpc:'2.0',id:m.id??null,error:{code:-32601,message:'method not found'}});
    json(res,200,{jsonrpc:'2.0',id:m.id??null,result});
  });
  const control=createServer(async(req,res)=>{
    if(req.headers.origin)return json(res,403,{});
    if(req.headers.authorization!=='Bearer '+key)return json(res,401,{});
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&req.url==='/ready'){
        const report=readiness();return json(res,report.ok?200:503,report);
      }
      if(req.method==='GET'&&url.pathname==='/reconcile'){
        const ids=[...new Set(url.searchParams.getAll('id'))];
        if([...url.searchParams.keys()].some(key=>key!=='id')
            ||ids.some(id=>!/^[a-zA-Z0-9_-]{1,80}$/.test(id)))throw Error('invalid reconciliation query');
        const selected=ids.length?tasks.filter(t=>ids.includes(t.id)):tasks;
        if(ids.length&&selected.length!==ids.length)throw Error('unknown task');
        // Health remains global. Only retained-task detail inspection is scoped;
        // full reconcile still audits every journal, original and result candidate.
        // Share only this synchronous response's observed diagnostics, not receipts
        // or a cross-request integrity verdict. Collection checks independently.
        const journalIssues=new Map(),health=readiness(journalIssues);
        return json(res,200,{health,tasks:selected.map(t=>reconciliationTask(t,journalIssues.get(t))),...(ids.length?{scope:ids}:{})});
      }
      if(stopping)return json(res,503,{error:'worker is stopping',code:'SHUTTING_DOWN',retryable:true});
      if(req.method==='GET'&&['/wait','/status','/tasks'].includes(url.pathname))verifyState();
      if(req.method==='GET'&&url.pathname==='/wait'){
        const ids=url.searchParams.getAll('id');
        if([...url.searchParams.keys()].some(key=>key!=='id'))throw Error('invalid wait query');
        if(ids.some(id=>!tasks.some(t=>t.id===id)))throw Error('unknown task');
        const selected=()=>ids.length?tasks.filter(t=>ids.includes(t.id)):tasks;
        const snapshot=()=>({...view(selected()),...((stopping||storageFailure||stateFailure)?{interrupted:true}:{}),...(ids.length?{settled:!selected().some(t=>t.status==='running')}:{})});
        const ready=v=>v.interrupted||v.events.length||v.backupDue.length||v.recoveryRequired?.length||v.resultRecoveryRequired?.length||!selected().some(t=>t.status==='running');
        const v=snapshot();if(ready(v))return json(res,200,v);
        let timer;
        const done=(timeout=false)=>{
          // The file may change while this long poll is parked. Remove this
          // waiter before checking: storageError wakes the remaining waiters.
          waiters.delete(done);
          try{verifyState();}catch(e){
            clearTimeout(timer);
            json(res,e.statusCode??503,{error:e.message,...(e.code?{code:e.code}:{}),retryable:false});return;
          }
          const v=snapshot();
          if(!timeout&&!ready(v)){waiters.add(done);return;} // An unrelated task must not wake this wait.
          clearTimeout(timer);waiters.delete(done);
          if(!res.destroyed)json(res,200,v);
        };
        waiters.add(done);
        const due=Math.min(...selected().filter(t=>t.status==='running').map(t=>t.nextCheck-now()));
        timer=setTimeout(()=>done(true),Math.max(1,Math.min(waitMs,due)));
        res.on('close',()=>{clearTimeout(timer);waiters.delete(done);});return;
      }
      if(req.method==='GET'&&req.url==='/status')return json(res,200,view());
      if(req.method==='GET'&&req.url==='/tasks') {
        const active=tasks.filter(t=>t.status==='running'||!t.collected);
        return json(res,200,{running:active.filter(t=>t.status==='running').length,
          uncollected:active.filter(t=>t.status!=='running'&&!t.collected).length,
          tasks:active.map(t=>({id:t.id,status:t.status,collected:t.collected,nextCheck:t.nextCheck,
            workspace:t.workspace?{root:t.workspace.root,mode:t.workspace.mode}:null,
            recoveryRequired:Boolean(t.recoveryRequired?.length)}))});
      }

      if(req.method!=='POST')return json(res,404,{});
      const a=await body(req);
      if(stopping)return json(res,503,{error:'worker is stopping',code:'SHUTTING_DOWN',retryable:true});
      if(req.url==='/shutdown'){
        if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).length)throw Error('shutdown requires an empty object');
        stopping=true;wake();
        // An accepted stop must not wait for its response to flush: an earlier
        // pipelined wait or a disconnected client can prevent 'finish' forever.
        setImmediate(()=>{close().catch(()=>{process.exitCode=74;});});
        json(res,202,{accepted:true});return;
      }
      verifyState();
      if(req.url==='/collect')return json(res,200,commitCollection(a));
      if(req.url==='/register'){
        if(a&&['terminal','mode'].some(key=>Object.hasOwn(a,key)))throw Error('terminal/open modes are not supported by this file-scoped fork');
        if(!a||typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||typeof a.instructions!=='string'||!a.inputs||typeof a.inputs!=='object'||Array.isArray(a.inputs)||Object.values(a.inputs).some(v=>typeof v!=='string'))throw Error('invalid task');
        // Valid wire UTF-8 does not exclude JSON-escaped unpaired surrogates.
        // Reject them before storing unreadable keys or lossy UTF-8 input hashes.
        if(!a.instructions.isWellFormed()||Object.entries(a.inputs).some(([name,text])=>!name.isWellFormed()||!text.isWellFormed()))
          throw Error('task instructions and inputs must be well-formed Unicode');
        // IDs become result/recovery filenames, so keep them portable across Windows and POSIX.
        if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(a.id))throw Error('invalid task ID: reserved Windows filename');
        const workspace=grantWorkspace(a.workspace);
        checkDataBoundary(workspace);
        const existing=tasks.find(t=>t.id===a.id);
        if(!existing&&tasks.some(t=>typeof t.id==='string'&&t.id.toLowerCase()===a.id.toLowerCase()))
          throw Error('task ID conflicts with an existing ID on case-insensitive filesystems');
        if(existing) {
          if(existing.status==='running'&&!existing.collected&&existing.token&&existing.instructions===a.instructions
              &&isDeepStrictEqual(existing.inputs,a.inputs)
              &&isDeepStrictEqual(existing.workspace?{...existing.workspace,root:realpathSync.native(existing.workspace.root)}:null,workspace))
            return json(res,200,{id:existing.id,token:existing.token,duplicate:true});
          throw Error('task ID already exists with different inputs, grant or terminal state');
        }
        const t={id:a.id,token:randomUUID(),instructions:a.instructions,inputs:a.inputs,workspace,changes:[],status:'running',nextCheck:now()+backupMs,collected:false};
        persist([...tasks,t]);wake();return json(res,200,{id:t.id,token:t.token});
      }
      const t=tasks.find(t=>t.id===a.id);if(!t)throw Error('unknown task');
      const next={...t};
      if(req.url==='/ack'){if(t.status==='running')throw Error('not complete');next.collected=true;revoke(next);}
      else if(req.url==='/checked'){if(t.status==='running')next.nextCheck=now()+backupMs;}
      else if(req.url==='/cancel'){
        if(t.status==='running'){next.status='cancelled';next.summary='Cancelled by supervisor';next.nextCheck=null;next.collected=true;revoke(next);}
        // Abandon collection explicitly without rewriting the terminal result or its evidence.
        else if(!t.collected){next.collected=true;next.discarded=true;revoke(next);}
      }
      else return json(res,404,{});
      persist(tasks.map(task=>task===t?next:task));wake();json(res,200,{ok:true});
    }catch(e){json(res,e.statusCode??400,{error:e.message,...(e.code?{code:e.code}:{}),
      ...(e.code==='COLLECTION_RECOVERY_REQUIRED'?{attention:e.attention,reconciliation:e.reconciliation}:{}),retryable:false});}
  });
  for(const server of [mcp,control])server.requestTimeout=15000;
  const listen=(s,p)=>new Promise((yes,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',yes);});
  const close=()=>{
    if(closePromise)return closePromise;
    stopping=true;wake();
    closePromise=Promise.all([mcp,control].map(server=>new Promise(done=>{
      const deadline=setTimeout(()=>server.closeAllConnections(),closeGraceMs);
      server.close(()=>{clearTimeout(deadline);done();});
      server.closeIdleConnections();
    }))).then(()=>{
      // Socket-close callbacks may follow server.close. Finalize observations
      // before releasing runtime ownership; late events cannot write again.
      for(const finishAudit of [...auditResponses])finishAudit();
      release();
    });
    return closePromise;
  };
  // A failed second bind can leave a request on the first listener. Stop tool
  // execution and drain both servers before releasing this runtime's ownership.
  try{await listen(mcp,port);await listen(control,controlPort);}catch(e){await close();throw e;}
  writeAudit({phase:'started'});
  return {mcpPort:mcp.address().port,controlPort:control.address().port,key,close};
  }catch(e){release();throw e;}
}
if(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  let config, service, stopRequested=false;
  const stop=()=>{
    stopRequested=true;
    return service?.close().catch(()=>{process.exitCode=74;});
  };
  // Register before the first await. An IPC owner can disappear or request stop
  // while listeners are still starting, not just after the listening message.
  if(typeof process.send==='function'){
    process.on('message',message=>{if(message?.type==='shutdown')stop();});
    process.once('disconnect',stop);
    process.channel?.unref();
    if(!process.connected)stopRequested=true;
  }
  for(const signal of ['SIGINT','SIGTERM',...(process.platform==='win32'?['SIGBREAK']:[])])process.on(signal,stop);
  try{config=configuration();}catch(error){console.error(JSON.stringify({event:'startup_failed',code:'CONFIG_INVALID'}));process.exitCode=78;}
  if(config&&!stopRequested)try{
    service=await start({dir:config.dataDir,port:config.mcpPort,controlPort:config.controlPort,publicMcp:config.publicMcp,audit:auditFromEnvironment(),entryPath:resolve(process.argv[1])});
    if(stopRequested)await stop();
    else console.log(JSON.stringify({event:'listening',mcpPort:service.mcpPort,controlPort:service.controlPort}));
  }catch(error){
    console.error(JSON.stringify({event:'startup_failed',code:error.code??'UNEXPECTED',exitCode:startupExitCode(error)}));
    process.exitCode=startupExitCode(error);
  }
}
